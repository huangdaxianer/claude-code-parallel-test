/**
 * 内部 API 代理路由
 *
 * 功能：接收 Claude CLI 子进程的 API 请求，注入真实的认证信息后转发到上游 API。
 * 子进程只拿到假的 token 和本地代理地址，无法获取真实的 API Key。
 *
 * 安全：只允许 localhost 访问（子进程和主服务在同一台机器上）。
 *
 * 路由格式：
 *   POST /internal-proxy/:modelId/v1/messages
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
 * 通配路由：处理所有 /internal-proxy/:modelId/* 的请求
 */
router.all('/:modelId/{*path}', (req, res) => {
    const { modelId, path: pathSegments } = req.params;
    // Express 5 的 {*path} 返回数组，需拼接为路径字符串
    const remainingPath = Array.isArray(pathSegments) ? pathSegments.join('/') : pathSegments;

    console.log(`[Proxy] ${req.method} model=${modelId} path=${remainingPath}`);

    // 查找模型的真实 API 配置
    let apiKey, apiBaseUrl, alwaysThinkingEnabled = false, actualModelName = null;

    if (modelId === '__default__') {
        // 默认配置（preview 等场景）
        apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
        apiBaseUrl = process.env.ANTHROPIC_BASE_URL;
    } else {
        const modelConfig = db.prepare(
            'SELECT api_key, api_base_url, always_thinking_enabled, model_name FROM model_configs WHERE model_id = ?'
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
    }

    if (!apiKey || !apiBaseUrl) {
        console.error(`[Proxy] Missing API credentials for model ${modelId}`);
        return res.status(500).json({ error: 'API credentials not configured' });
    }

    // 构建目标 URL — 必须保留 apiBaseUrl 中的路径前缀（如 /api/compatible）
    // 注意：new URL('/v1/messages', 'https://host/api/compatible') 会丢掉 /api/compatible
    let targetUrl;
    try {
        const base = apiBaseUrl.replace(/\/+$/, ''); // 去掉尾部斜杠
        targetUrl = new URL(`${base}/${remainingPath}`);
    } catch (e) {
        console.error(`[Proxy] Invalid URL: ${apiBaseUrl}/${remainingPath}`, e.message);
        return res.status(500).json({ error: 'Invalid upstream URL' });
    }

    console.log(`[Proxy] Forwarding to: ${targetUrl.toString()}`);

    const isHttps = targetUrl.protocol === 'https:';
    const requestModule = isHttps ? https : http;

    // 构建转发 headers：过滤掉不应转发的头，注入真实认证
    const forwardHeaders = {};
    const skipHeaders = new Set(['host', 'connection', 'authorization', 'content-length']);

    for (const [key, value] of Object.entries(req.headers)) {
        if (!skipHeaders.has(key.toLowerCase())) {
            forwardHeaders[key] = value;
        }
    }

    // 注入真实的认证信息
    forwardHeaders['authorization'] = `Bearer ${apiKey}`;
    forwardHeaders['host'] = targetUrl.host;

    // 发起代理请求（如果环境配置了 HTTP 代理，则通过代理转发）
    const agent = isHttps ? httpsProxyAgent : httpProxyAgent;

    /**
     * 发送请求到上游
     * @param {Buffer|null} bodyBuffer - 修改后的请求体，null 表示用 pipe 透传
     */
    function sendUpstream(bodyBuffer) {
        const requestOptions = {
            method: req.method,
            headers: { ...forwardHeaders },
        };
        if (agent) {
            requestOptions.agent = agent;
        }

        // 如果有修改后的 body，更新 content-length
        if (bodyBuffer !== null) {
            requestOptions.headers['content-length'] = Buffer.byteLength(bodyBuffer);
        }

        const proxyReq = requestModule.request(targetUrl, requestOptions, (proxyRes) => {
            // 转发响应状态码和 headers
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            // 管道转发响应体（天然支持 SSE 流式传输）
            proxyRes.pipe(res);
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

    // 对 POST 请求注入/覆盖 thinking 配置
    if (req.method === 'POST') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString());

                // 强制改写 model 字段为实际的上游模型名（解决 subagent/teammate 使用 claude-opus-4-6 的问题）
                if (actualModelName && body.model && body.model !== actualModelName) {
                    console.log(`[Proxy] Rewriting model: ${body.model} → ${actualModelName}`);
                    body.model = actualModelName;
                }

                if (alwaysThinkingEnabled) {
                    // 启用推理：强制注入 thinking enabled
                    body.thinking = { type: 'enabled' };
                } else {
                    // 禁用推理：强制设置为 disabled
                    body.thinking = { type: 'disabled' };
                }

                const modified = Buffer.from(JSON.stringify(body));
                console.log(`[Proxy] Thinking ${alwaysThinkingEnabled ? 'enabled' : 'disabled'} for model ${modelId}`);
                sendUpstream(modified);
            } catch (e) {
                // JSON 解析失败，透传原始请求体
                console.warn(`[Proxy] Failed to parse request body for thinking injection: ${e.message}`);
                sendUpstream(Buffer.concat(chunks));
            }
        });
    } else {
        // 非 POST 请求直接 pipe 透传
        sendUpstream(null);
    }
});

module.exports = router;
