/**
 * 内部 API 代理路由
 *
 * 功能：接收 Claude CLI 子进程的 API 请求，注入真实的认证信息后转发到上游 API。
 * 子进程只拿到假的 token 和本地代理地址，无法获取真实的 API Key。
 *
 * 安全：只允许 localhost 访问（子进程和主服务在同一台机器上）。
 *
 * Haiku 分流：Claude Code 内部会用 Haiku 模型做分类/路由等辅助调用。
 * 当检测到请求的 model 包含 "haiku" 时，自动路由到标记为 is_preview_model 的模型，
 * 并强制关闭 thinking，避免辅助请求被错误地发到昂贵的主模型。
 *
 * 性能指标采集：对每次 API 请求采集 TTFT（首 token 延迟）和 TPOT（每输出 token 耗时），
 * 写入 api_requests 表，用于管理员在前端查看模型性能。
 *
 * 路由格式：
 *   POST /internal-proxy/:taskId/:modelId/v1/messages
 *   （实际用通配匹配所有子路径）
 */
const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const db = require('../db');

// HTTP 代理支持：当环境中配置了 HTTPS_PROXY / HTTP_PROXY 时，
// 通过 https-proxy-agent 让 Node.js 原生 http/https 请求走代理
let httpsProxyAgent = null;
let httpProxyAgent = null;
try {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
        || process.env.HTTP_PROXY || process.env.http_proxy;
    if (proxyUrl) {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        const { HttpProxyAgent } = require('http-proxy-agent');
        httpsProxyAgent = new HttpsProxyAgent(proxyUrl);
        httpProxyAgent = new HttpProxyAgent(proxyUrl);
        console.log('[Proxy] Using HTTP proxy for upstream requests:', proxyUrl.replace(/:[^:@]+@/, ':***@'));
    }
} catch (e) {
    console.warn('[Proxy] Failed to initialize proxy agent:', e.message);
}

const router = express.Router();

// ========== 性能指标采集相关 ==========

// Per-run 请求计数器：Map<"taskId/modelId", number>
const requestCounters = new Map();

// 预编译的 INSERT 语句
let insertApiRequestStmt = null;
try {
    insertApiRequestStmt = db.prepare(`
        INSERT INTO api_requests
            (run_id, request_index, is_haiku, request_model, upstream_model,
             request_started_at, first_token_at, last_token_at,
             ttft_ms, tpot_ms, input_tokens, output_tokens, cache_read_tokens,
             status_code, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
} catch (e) {
    console.warn('[Proxy Metrics] Failed to prepare insert statement:', e.message);
}

// 缓存 run_id 查询：Map<"taskId/modelId", runId>
const runIdCache = new Map();

/**
 * 持久化单次 API 请求的性能指标
 */
function persistApiRequestMetrics(data) {
    if (!insertApiRequestStmt) return;
    try {
        // 查找 run_id（带缓存）
        const cacheKey = `${data.taskId}/${data.modelId}`;
        let runId = runIdCache.get(cacheKey);
        if (!runId) {
            const run = db.prepare(
                'SELECT id FROM model_runs WHERE task_id = ? AND model_id = ?'
            ).get(data.taskId, data.modelId);
            if (!run) {
                console.warn(`[Proxy Metrics] No model_run found for ${cacheKey}`);
                return;
            }
            runId = run.id;
            runIdCache.set(cacheKey, runId);
        }

        // 递增请求计数
        const requestIndex = (requestCounters.get(cacheKey) || 0) + 1;
        requestCounters.set(cacheKey, requestIndex);

        // 计算指标
        const ttft = data.firstTokenTime ? (data.firstTokenTime - data.requestStartTime) : null;
        const duration = Date.now() - data.requestStartTime;
        let tpot = null;
        if (data.firstTokenTime && data.lastTokenTime && data.outputTokenCount > 1) {
            tpot = (data.lastTokenTime - data.firstTokenTime) / (data.outputTokenCount - 1);
        }

        insertApiRequestStmt.run(
            runId, requestIndex, data.isHaiku ? 1 : 0,
            data.requestModel || null, data.upstreamModel || null,
            data.requestStartTime, data.firstTokenTime || null, data.lastTokenTime || null,
            ttft, tpot,
            data.inputTokenCount || 0, data.outputTokenCount || 0, data.cacheReadCount || 0,
            data.statusCode || null, duration
        );

        if (ttft !== null) {
            console.log(`[Proxy Metrics] ${cacheKey} req#${requestIndex}: TTFT=${ttft.toFixed(0)}ms TPOT=${tpot !== null ? tpot.toFixed(1) + 'ms' : 'N/A'} out=${data.outputTokenCount} ft=${!!data.firstTokenTime} lt=${!!data.lastTokenTime}`);
        }
    } catch (e) {
        console.error('[Proxy Metrics] Failed to persist:', e.message);
    }
}

/**
 * 缓存 preview model 配置（Haiku fallback），每 60 秒刷新
 */
let _previewModelCache = null;
let _previewModelCacheTime = 0;
const PREVIEW_CACHE_TTL = 60000; // 60s

function getPreviewModelConfig() {
    const now = Date.now();
    if (_previewModelCache !== undefined && (now - _previewModelCacheTime) < PREVIEW_CACHE_TTL) {
        return _previewModelCache;
    }
    try {
        _previewModelCache = db.prepare(
            'SELECT api_key, api_base_url, model_name FROM model_configs WHERE is_preview_model = 1 LIMIT 1'
        ).get() || null;
    } catch (e) {
        _previewModelCache = null;
    }
    _previewModelCacheTime = now;
    return _previewModelCache;
}

/**
 * 检测是否是 Haiku 内部分类请求
 * Claude Code 使用 claude-haiku-4-5-20251001 等 Haiku 模型做分类/路由
 */
function isHaikuModel(modelName) {
    if (!modelName) return false;
    return /haiku/i.test(modelName);
}

/**
 * 只允许 localhost 访问的中间件
 */
function requireLocalhost(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || '';
    const isLocal = (
        ip === '127.0.0.1' ||
        ip === '::1' ||
        ip === '::ffff:127.0.0.1' ||
        ip === 'localhost'
    );
    if (!isLocal) {
        console.warn(`[Proxy] Blocked non-local request from ${ip}`);
        return res.status(403).json({ error: 'Forbidden: localhost only' });
    }
    next();
}

router.use(requireLocalhost);

/**
 * 通配路由：处理所有 /internal-proxy/:taskId/:modelId/* 的请求
 * taskId 为 '_' 时表示非任务场景（如 preview），不采集指标
 */
router.all('/:taskId/:modelId/{*path}', (req, res) => {
    const { taskId: rawTaskId, modelId, path: pathSegments } = req.params;
    // Express 5 的 {*path} 返回数组，需拼接为路径字符串
    const remainingPath = Array.isArray(pathSegments) ? pathSegments.join('/') : pathSegments;
    // taskId 为 '_' 时表示非任务场景
    const effectiveTaskId = (rawTaskId === '_') ? null : rawTaskId;

    console.log(`[Proxy] ${req.method} task=${rawTaskId} model=${modelId} path=${remainingPath}`);

    // 查找模型的真实 API 配置
    let apiKey, apiBaseUrl, alwaysThinkingEnabled = false, actualModelName = null, providerConfig = null;

    if (modelId === '__default__') {
        // 默认配置（preview 等场景）
        apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
        apiBaseUrl = process.env.ANTHROPIC_BASE_URL;
    } else {
        const modelConfig = db.prepare(
            'SELECT api_key, api_base_url, always_thinking_enabled, model_name, provider FROM model_configs WHERE model_id = ?'
        ).get(modelId);

        if (!modelConfig) {
            console.error(`[Proxy] Model not found: ${modelId}`);
            return res.status(404).json({ error: `Model config not found: ${modelId}` });
        }

        // 模型独立配置优先，null 时 fallback 到全局默认
        apiKey = modelConfig.api_key || process.env.ANTHROPIC_AUTH_TOKEN;
        apiBaseUrl = modelConfig.api_base_url || process.env.ANTHROPIC_BASE_URL;
        alwaysThinkingEnabled = !!modelConfig.always_thinking_enabled;
        actualModelName = modelConfig.model_name || null;
        providerConfig = modelConfig.provider || null;
    }

    if (!apiKey || !apiBaseUrl) {
        console.error(`[Proxy] Missing API credentials for model ${modelId}`);
        return res.status(500).json({ error: 'API credentials not configured' });
    }

    // ---- 以下变量可能被 Haiku 分流覆盖，使用 let ----

    // 构建目标 URL — 必须保留 apiBaseUrl 中的路径前缀（如 /api/compatible）
    let targetUrl;
    try {
        const base = apiBaseUrl.replace(/\/+$/, '');
        targetUrl = new URL(`${base}/${remainingPath}`);
    } catch (e) {
        console.error(`[Proxy] Invalid URL: ${apiBaseUrl}/${remainingPath}`, e.message);
        return res.status(500).json({ error: 'Invalid upstream URL' });
    }

    // 构建转发 headers：过滤掉不应转发的头，注入真实认证
    const forwardHeaders = {};
    const skipHeaders = new Set(['host', 'connection', 'authorization', 'content-length']);

    for (const [key, value] of Object.entries(req.headers)) {
        if (!skipHeaders.has(key.toLowerCase())) {
            forwardHeaders[key] = value;
        }
    }

    forwardHeaders['authorization'] = `Bearer ${apiKey}`;
    forwardHeaders['host'] = targetUrl.host;

    // 闭包变量：在 POST body 解析中设置，供 sendUpstream 回调使用
    let isHaiku = false;
    let originalRequestModel = null;
    let upstreamModelName = null;

    /**
     * 发送请求到上游（使用当前的 targetUrl 和 forwardHeaders）
     * @param {Buffer|null} bodyBuffer - 修改后的请求体，null 表示用 pipe 透传
     * @param {string|null} responseModelOverride - 如果非空，将响应 SSE 中的 model 字段改写为此值
     */
    function sendUpstream(bodyBuffer, responseModelOverride) {
        const requestStartTime = Date.now();
        const currentIsHttps = targetUrl.protocol === 'https:';
        const currentRequestModule = currentIsHttps ? https : http;
        const currentAgent = currentIsHttps ? httpsProxyAgent : httpProxyAgent;

        const requestOptions = {
            method: req.method,
            headers: { ...forwardHeaders },
        };
        if (currentAgent) {
            requestOptions.agent = currentAgent;
        }

        // 如果有修改后的 body，更新 content-length
        if (bodyBuffer !== null) {
            requestOptions.headers['content-length'] = Buffer.byteLength(bodyBuffer);
        }

        console.log(`[Proxy] Forwarding to: ${targetUrl.toString()}`);

        const proxyReq = currentRequestModule.request(targetUrl, requestOptions, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);

            // ---- 性能指标采集 ----
            let firstTokenTime = null;
            let lastTokenTime = null;
            let outputTokenCount = 0;
            let inputTokenCount = 0;
            let cacheReadCount = 0;

            const modelPattern = responseModelOverride ? /"model"\s*:\s*"[^"]+"/g : null;
            const modelReplacement = responseModelOverride ? `"model":"${responseModelOverride}"` : null;

            // SSE 跨 chunk 缓冲：TCP 分包可能将一个 SSE data: 行拆到两个 chunk 中，
            // 导致 JSON 解析失败（尤其影响 message_delta 中的 usage 提取 → TPOT 为 null）。
            // 保留上一个 chunk 末尾的不完整行，拼接到下一个 chunk 头部再解析。
            let sseBuffer = '';

            proxyRes.on('data', (chunk) => {
                const now = Date.now();
                const text = chunk.toString();

                // 写数据给下游（可选 model 改写）
                if (modelPattern) {
                    res.write(text.replace(modelPattern, modelReplacement));
                } else {
                    res.write(chunk);
                }

                // 检测 content_block_delta（实际输出 token）用于计时
                if (text.includes('content_block_delta')) {
                    if (!firstTokenTime) {
                        firstTokenTime = now;
                    }
                    lastTokenTime = now;
                }

                // 解析 usage 信息（出现在 message_delta 或 message_stop 事件中）
                // 使用 sseBuffer 处理跨 chunk 的行拆分
                const combined = sseBuffer + text;
                sseBuffer = '';

                if (combined.includes('"usage"')) {
                    const lines = combined.split('\n');
                    // 最后一行可能不完整（没有换行符结尾），缓存到下次
                    if (!text.endsWith('\n')) {
                        sseBuffer = lines.pop();
                    }
                    for (const line of lines) {
                        // 兼容 "data: {...}" (Anthropic) 和 "data:{...}" (百炼 dashscope) 两种 SSE 格式
                        let jsonStr = null;
                        if (line.startsWith('data: ')) {
                            jsonStr = line.slice(6);
                        } else if (line.startsWith('data:')) {
                            jsonStr = line.slice(5);
                        }
                        if (!jsonStr) continue;
                        try {
                            const evt = JSON.parse(jsonStr);
                            if (evt.usage) {
                                if (evt.usage.output_tokens) outputTokenCount = evt.usage.output_tokens;
                                if (evt.usage.input_tokens) inputTokenCount = evt.usage.input_tokens;
                                if (evt.usage.cache_read_input_tokens) cacheReadCount = evt.usage.cache_read_input_tokens;
                            }
                        } catch (_) { /* partial JSON, ignore */ }
                    }
                } else if (!text.endsWith('\n')) {
                    // 当前 chunk 没有 usage 但末尾不完整，可能下个 chunk 拼接后有 usage
                    const lines = combined.split('\n');
                    sseBuffer = lines[lines.length - 1];
                }
            });

            proxyRes.on('end', () => {
                res.end();

                // 持久化指标（仅当有有效 taskId 且请求成功时）
                if (effectiveTaskId && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
                    persistApiRequestMetrics({
                        taskId: effectiveTaskId,
                        modelId,
                        isHaiku,
                        requestModel: originalRequestModel,
                        upstreamModel: upstreamModelName,
                        requestStartTime,
                        firstTokenTime,
                        lastTokenTime,
                        outputTokenCount,
                        inputTokenCount,
                        cacheReadCount,
                        statusCode: proxyRes.statusCode
                    });
                }
            });

            proxyRes.on('error', (err) => {
                console.error(`[Proxy] Response stream error:`, err.message);
                res.end();
            });
        });

        proxyReq.on('error', (err) => {
            console.error(`[Proxy] Upstream error for model ${modelId}:`, err.message);
            if (!res.headersSent) {
                res.status(502).json({ error: 'Proxy upstream error', detail: err.message });
            }
        });

        if (bodyBuffer !== null) {
            proxyReq.end(bodyBuffer);
        } else {
            req.pipe(proxyReq);
        }
    }

    // 对 POST 请求注入/覆盖 thinking 配置 & model 改写
    if (req.method === 'POST') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString());

                // 记录 Claude Code 发来的原始 model 名（改写前），用于响应回写
                originalRequestModel = body.model || null;

                // ========== Haiku 分流逻辑 ==========
                // Claude Code 内部用 Haiku 做分类/路由，这些请求不应发到主模型
                // 检测到 Haiku 时，路由到 is_preview_model 标记的模型，并关闭 thinking
                if (originalRequestModel && isHaikuModel(originalRequestModel)) {
                    isHaiku = true;
                    const previewConfig = getPreviewModelConfig();

                    if (previewConfig && previewConfig.api_base_url && previewConfig.api_key) {
                        // 切换上游到 preview model
                        const previewBase = previewConfig.api_base_url.replace(/\/+$/, '');
                        try {
                            targetUrl = new URL(`${previewBase}/${remainingPath}`);
                        } catch (e) {
                            console.error(`[Proxy] Invalid preview model URL: ${previewBase}/${remainingPath}`);
                            // fallback: 继续用原始配置
                            targetUrl = null;
                        }

                        if (targetUrl) {
                            forwardHeaders['authorization'] = `Bearer ${previewConfig.api_key}`;
                            forwardHeaders['host'] = targetUrl.host;

                            // 改写 model 为 preview model 的实际模型名
                            body.model = previewConfig.model_name;
                            upstreamModelName = previewConfig.model_name;

                            // Haiku 辅助请求一律关闭 thinking
                            body.thinking = { type: 'disabled' };

                            const modified = Buffer.from(JSON.stringify(body));
                            console.log(`[Proxy] Haiku fallback: ${originalRequestModel} → ${previewConfig.model_name} (thinking: disabled)`);

                            // 响应中把 model 改回原始 Haiku 名，让 Claude Code 继续正常工作
                            sendUpstream(modified, originalRequestModel);
                            return;
                        }
                    } else {
                        console.warn(`[Proxy] No preview model configured for Haiku fallback, using main model for ${modelId}`);
                    }
                }

                // ========== 正常主模型请求处理 ==========

                // 强制改写 model 字段为实际的上游模型名（解决 subagent/teammate 使用 claude-opus-4-6 的问题）
                let modelRewritten = false;
                if (actualModelName && body.model && body.model !== actualModelName) {
                    console.log(`[Proxy] Rewriting model: ${body.model} → ${actualModelName}`);
                    body.model = actualModelName;
                    modelRewritten = true;
                }
                upstreamModelName = body.model;

                if (alwaysThinkingEnabled) {
                    // 启用推理：强制注入 thinking enabled + budget_tokens
                    // Claude API 要求 thinking.budget_tokens 为必填数值，且 < max_tokens
                    const maxTokens = body.max_tokens || 16384;
                    const budgetTokens = Math.min(10240, Math.floor(maxTokens * 0.8));
                    body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
                } else {
                    // 禁用推理：强制设置为 disabled
                    body.thinking = { type: 'disabled' };
                }

                // 注入 provider.only（如果配置了 provider）
                if (providerConfig) {
                    const providers = providerConfig.split(';').map(s => s.trim()).filter(Boolean);
                    if (providers.length > 0) {
                        body.provider = { only: providers };
                        console.log(`[Proxy] Injecting provider.only: [${providers.join(', ')}] for model ${modelId}`);
                    }
                }

                const modified = Buffer.from(JSON.stringify(body));
                console.log(`[Proxy] Thinking ${alwaysThinkingEnabled ? 'enabled' : 'disabled'} for model ${modelId}`);

                // 如果 model 被改写了，响应中也需要改写回来（让 Claude Code 以为是 Claude 模型）
                const responseModelOverride = modelRewritten ? originalRequestModel : null;
                sendUpstream(modified, responseModelOverride);
            } catch (e) {
                // JSON 解析失败，透传原始请求体
                console.warn(`[Proxy] Failed to parse request body for thinking injection: ${e.message}`);
                sendUpstream(Buffer.concat(chunks), null);
            }
        });
    } else {
        // 非 POST 请求直接 pipe 透传
        sendUpstream(null, null);
    }
});

module.exports = router;
