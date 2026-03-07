/**
 * AI 质检服务
 * 管理 AI 模型质检的队列调度和 API 调用
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const db = require('../db');
const config = require('../config');

// HTTP 代理支持
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
        console.log('[AI-QC] Using HTTP proxy:', proxyUrl.replace(/:[^:@]+@/, ':***@'));
    }
} catch (e) {
    console.warn('[AI-QC] Failed to initialize proxy agent:', e.message);
}

// 辅助模型配置缓存
let _previewModelCache = null;
let _previewModelCacheTime = 0;
const CACHE_TTL = 60000;

function getPreviewModelConfig() {
    const now = Date.now();
    if (_previewModelCache && (now - _previewModelCacheTime) < CACHE_TTL) {
        return _previewModelCache;
    }
    try {
        _previewModelCache = db.prepare(
            'SELECT api_key, api_base_url, model_name FROM model_configs WHERE is_preview_model = 1 LIMIT 1'
        ).get() || null;
        _previewModelCacheTime = now;
    } catch (e) {
        _previewModelCache = null;
    }
    return _previewModelCache;
}

// 队列状态
let isProcessing = false;
let activeCount = 0;

// 提示词
const REQ_TYPE_SYSTEM_PROMPT = '你会看到一个软件开发需求，请你判断该需求是否为真实的软件开发需求（例如需求如果只是要求撰写方案文档，就不算软件开发需求），并对需求进行分类，包含以下几个分类：客户端、前端网页、全栈网页、服务端、算法、嵌入式、其它，如果需求符合要求就直接输出分类，如果不符合就直接输出不符合要求';
const TRACE_SYSTEM_PROMPT = '以下是一段模型对用户需求的执行轨迹，请你判断该轨迹是否满足以下条件 1. 轨迹是完整的，并且在最终交付了用户的需求，并在最后一轮总结了用户的产物，没有被截断 2. 该任务确实调用工具改动了文件，生成了新的文件，而不是仅仅输出方案 请你判定完成后输入轨迹完整或轨迹不完整两种结果，不要输出其它内容';

/**
 * 调用 Anthropic Messages API
 */
function callAnthropicAPI(apiBaseUrl, apiKey, modelName, systemPrompt, userContent) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            model: modelName,
            max_tokens: 256,
            system: systemPrompt,
            messages: [{ role: 'user', content: userContent }]
        });

        const baseUrl = apiBaseUrl.replace(/\/+$/, '');
        let targetUrl;
        try {
            targetUrl = new URL(`${baseUrl}/v1/messages`);
        } catch (e) {
            return reject(new Error(`Invalid API base URL: ${baseUrl}`));
        }

        const isHttps = targetUrl.protocol === 'https:';
        const requestModule = isHttps ? https : http;
        const agent = isHttps ? httpsProxyAgent : httpProxyAgent;

        const options = {
            method: 'POST',
            hostname: targetUrl.hostname,
            port: targetUrl.port,
            path: targetUrl.pathname + targetUrl.search,
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        if (agent) options.agent = agent;

        const req = requestModule.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        return reject(new Error(`API ${res.statusCode}: ${body.substring(0, 500)}`));
                    }
                    const data = JSON.parse(body);
                    const text = (data.content && data.content[0] && data.content[0].text) || '';
                    resolve(text.trim());
                } catch (e) {
                    reject(new Error(`Parse error: ${e.message}`));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy(new Error('Request timeout (30s)'));
        });
        req.write(postData);
        req.end();
    });
}

/**
 * 压缩执行轨迹：仅保留工具名称和成功/失败状态
 */
function compressTrace(runId) {
    const entries = db.prepare(`
        SELECT tool_name, status_class
        FROM log_entries
        WHERE run_id = ? AND tool_name IS NOT NULL
        ORDER BY line_number ASC
    `).all(runId);

    if (entries.length === 0) return '(无工具调用记录)';

    return entries.map((entry, idx) => {
        let statusLabel;
        if (entry.status_class === 'type-success') {
            statusLabel = '成功';
        } else if (entry.status_class === 'type-error') {
            statusLabel = '失败';
        } else {
            statusLabel = '进行中';
        }
        return `${idx + 1}. ${entry.tool_name} → ${statusLabel}`;
    }).join('\n');
}

/**
 * 归一化模型输出：去除多余空白和标点
 */
function normalizeOutput(text) {
    return text.trim().replace(/[。，.!！\s]+$/, '').trim();
}

/**
 * 将选中的 task+model 组合加入 AI 质检队列
 * @param {Array<{task_id: string, model_id: string}>} items
 * @returns {number} 成功入队数量
 */
function enqueueForAiQc(items) {
    const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO ai_quality_inspections (task_id, model_id, status)
        VALUES (?, ?, 'pending')
    `);

    let count = 0;
    for (const item of items) {
        const result = insertStmt.run(item.task_id, item.model_id);
        if (result.changes > 0) count++;
    }

    console.log(`[AI-QC] Enqueued ${count} items for AI quality inspection`);

    // 触发队列处理
    if (count > 0) {
        setImmediate(() => processAiQcQueue());
    }
    return count;
}

/**
 * 处理 AI 质检队列（并发控制）
 */
async function processAiQcQueue() {
    if (isProcessing) return;
    isProcessing = true;

    try {
        const maxConcurrency = config.getAppConfig().aiQcConcurrency || 30;

        while (true) {
            const availableSlots = maxConcurrency - activeCount;
            if (availableSlots <= 0) break;

            const pendingItems = db.prepare(`
                SELECT aq.id, aq.task_id, aq.model_id, aq.retry_count,
                       t.prompt as task_prompt
                FROM ai_quality_inspections aq
                JOIN tasks t ON aq.task_id = t.task_id
                WHERE aq.status = 'pending'
                ORDER BY aq.id ASC
                LIMIT ?
            `).all(availableSlots);

            if (pendingItems.length === 0) break;

            const updateRunning = db.prepare(
                "UPDATE ai_quality_inspections SET status = 'running', started_at = datetime('now') WHERE id = ?"
            );
            for (const item of pendingItems) {
                updateRunning.run(item.id);
            }

            for (const item of pendingItems) {
                activeCount++;
                processOneItem(item).finally(() => {
                    activeCount--;
                    setImmediate(() => processAiQcQueue());
                });
            }

            break; // 让回调来填充新 slot
        }
    } catch (e) {
        console.error('[AI-QC] Queue processing error:', e);
    } finally {
        isProcessing = false;
    }
}

/**
 * 处理单条 AI 质检任务
 */
async function processOneItem(item) {
    const modelConfig = getPreviewModelConfig();
    if (!modelConfig || !modelConfig.api_base_url || !modelConfig.api_key) {
        db.prepare(
            "UPDATE ai_quality_inspections SET status = 'failed', error_message = '未配置辅助模型' WHERE id = ?"
        ).run(item.id);
        console.error('[AI-QC] No preview model configured');
        return;
    }

    // 失败重试延迟
    if (item.retry_count > 0) {
        await new Promise(r => setTimeout(r, 1000 * item.retry_count));
    }

    try {
        // --- Label 1: 需求类型（任务级优化：复用同 task_id 已有结果）---
        const existingReqType = db.prepare(
            'SELECT requirement_type FROM ai_quality_inspections WHERE task_id = ? AND requirement_type IS NOT NULL LIMIT 1'
        ).get(item.task_id);

        let requirementType;
        if (existingReqType) {
            requirementType = existingReqType.requirement_type;
        } else {
            const rawReqType = await callAnthropicAPI(
                modelConfig.api_base_url,
                modelConfig.api_key,
                modelConfig.model_name,
                REQ_TYPE_SYSTEM_PROMPT,
                item.task_prompt
            );
            requirementType = normalizeOutput(rawReqType);
            console.log(`[AI-QC] requirement_type="${requirementType}" task=${item.task_id}`);
        }

        // --- Label 2: 轨迹完整度（per model_run）---
        const run = db.prepare(
            'SELECT id FROM model_runs WHERE task_id = ? AND model_id = ?'
        ).get(item.task_id, item.model_id);

        let traceCompleteness = null;
        if (run) {
            const compressedTrace = compressTrace(run.id);
            const traceInput = `用户需求:\n${item.task_prompt}\n\n执行轨迹:\n${compressedTrace}`;
            const rawTrace = await callAnthropicAPI(
                modelConfig.api_base_url,
                modelConfig.api_key,
                modelConfig.model_name,
                TRACE_SYSTEM_PROMPT,
                traceInput
            );
            traceCompleteness = normalizeOutput(rawTrace);
            console.log(`[AI-QC] trace="${traceCompleteness}" ${item.task_id}/${item.model_id}`);
        } else {
            traceCompleteness = '轨迹不完整';
            console.warn(`[AI-QC] No model_run found for ${item.task_id}/${item.model_id}`);
        }

        // 保存结果
        db.prepare(`
            UPDATE ai_quality_inspections
            SET requirement_type = ?, trace_completeness = ?, status = 'completed',
                completed_at = datetime('now'), error_message = NULL
            WHERE id = ?
        `).run(requirementType, traceCompleteness, item.id);

        // 同步需求类型到同 task_id 的其它行
        db.prepare(`
            UPDATE ai_quality_inspections
            SET requirement_type = ?
            WHERE task_id = ? AND requirement_type IS NULL AND id != ?
        `).run(requirementType, item.task_id, item.id);

    } catch (err) {
        console.error(`[AI-QC] Error ${item.task_id}/${item.model_id}:`, err.message);
        const newRetry = (item.retry_count || 0) + 1;
        if (newRetry >= 3) {
            db.prepare(
                "UPDATE ai_quality_inspections SET status = 'failed', error_message = ?, retry_count = ? WHERE id = ?"
            ).run(err.message.substring(0, 500), newRetry, item.id);
        } else {
            db.prepare(
                "UPDATE ai_quality_inspections SET status = 'pending', error_message = ?, retry_count = ? WHERE id = ?"
            ).run(err.message.substring(0, 500), newRetry, item.id);
        }
    }
}

/**
 * 获取 AI 质检进度统计
 */
function getAiQcProgress() {
    return db.prepare(`
        SELECT
            COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
            COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) as running,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
            COUNT(*) as total
        FROM ai_quality_inspections
    `).get();
}

module.exports = {
    enqueueForAiQc,
    processAiQcQueue,
    getAiQcProgress,
    compressTrace
};
