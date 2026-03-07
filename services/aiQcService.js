/**
 * AI 质检服务
 * 包含两个独立的队列系统：
 * 1. 题目分类（per task）— ai_task_classifications 表
 * 2. 反馈质检 / 轨迹完整度（per model_run）— ai_quality_inspections 表
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

// ===================== 提示词 =====================

const REQ_TYPE_SYSTEM_PROMPT = `你会看到一个软件开发需求，请你判断该需求是否为真实的软件开发需求，并对需求进行分类。一次只输出一个分类，如果同时满足多个分类，以最主要的分类为准。

## 分类列表及标准
- 客户端：iOS/Android/桌面客户端等原生应用开发任务
- 前端网页：仅涉及前端界面的网页开发任务（HTML/CSS/JS/前端框架等）
- 全栈：同时需要更改前端界面和后端代码的任务
- 服务端：仅涉及后端/服务端的开发任务（API、数据库、微服务等）
- 算法：算法、数据结构、机器学习、大语言模型、推荐系统等相关任务
- 嵌入式：嵌入式系统、单片机、硬件驱动等开发任务
- 技术文档：根据所给项目撰写技术文档。注意一定要是基于现有的本地项目，搜索公域信息或进行本地测试并生成报告的任务不在此范畴；没有明确开发意图的任务例如"我这是一个视频抖动评估的脚本，帮我看看有什么能进一步提升评估精度的方法"也可以属于技术文档范畴
- 其它：不属于以上任何分类的软件开发任务
- 不符合要求：不是真实的软件开发需求（例如仅要求撰写方案文档、纯文字问答等）

## 输出格式
直接输出分类名称，不要输出任何其它内容。`;

const TRACE_SYSTEM_PROMPT = `以下是一段 AI 编程助手对用户需求的执行轨迹（包含工具调用摘要和模型文本输出），请你判断该轨迹是否完整。

## 轨迹完整的标准
同时满足以下条件：
1. 过程中有 Write/Edit/Bash 等文件写入操作，确实创建或修改了代码文件
2. 轨迹末尾有明确的总结段落（如"已完成"、"Results"、"总结"等），列出了交付产物（文件名、功能点等）
3. 没有出现下述任何一种不完整情况

## 常见的不完整情况
请特别注意以下几种典型的不完整模式：
1. **首轮截断**：模型在第一轮输出文本时就被截断，没有产生任何工具调用（Function Call），轨迹中没有或几乎没有工具调用记录
2. **末轮无工具调用**：最后一轮模型只输出了文字描述（如"让我先查看…"、"我将为你创建…"），像是工具调用的前言/Preamble，但实际没有发出 Function Call，轨迹中断在文本输出处
3. **API 调用失败**：轨迹中出现 API 报错信息（如 "thinking is enabled but reasoning_content is missing"、"CoT 为空"、HTTP 400/500 错误等），导致执行中断
4. **工具调用格式错误**：模型尝试调用工具但格式不正确（如输出了原始 JSON 文本 \`"Bash", "parameters": {...}\` 而非正确的 Function Call），导致工具未被实际执行
5. **未理解开发意图**：用户只提供了 PRD/需求文档但没有给出明确的开发指令，模型没有直接开始开发，而是反问用户确认开发意图（如"What would you like me to focus on?"），由于平台只支持单轮对话，任务因此卡住
6. **仅只读操作**：全程只有 Read/Glob/Grep 等只读操作，没有实际写入任何文件
7. **仅输出方案**：模型只输出了方案文档/设计文档，没有实际编写代码

## 完整轨迹的示例

以下是一个判定为"轨迹完整"的真实示例（已精简）：

用户需求：在浏览器中模拟 iOS 17/18 的移动操作系统体验 WebOS

执行轨迹：
\`\`\`
[模型输出] 我将帮你创建一个模拟 iOS 17/18 风格的 WebOS 体验，让我先规划任务。
1. TodoWrite: 创建项目基础结构 → 成功
[模型输出] 让我先查看当前目录结构。
2. Bash: ls -la → 成功
[模型输出] 看起来已经有一个 ios-webos.html 文件了，让我先查看内容。
3. Read: ios-webos.html → 成功
4. Read: hint.md → 成功
[模型输出] 了解了需求，现在开始进行改进。
5. Bash: python3 -m http.server 1026 → 成功
6. Grep: dynamic-island → 成功
[模型输出] 灵动岛已实现，让我检查并改进其他功能。
7. Write: ios-webos.html → 成功
8. Edit: ios-webos.html → 成功
9. Edit: ios-webos.html → 成功
[模型输出] 改进完成，让我创建一个演示首页。
10. Write: index.html → 成功
11. TodoWrite: 所有任务完成 → 成功
[模型输出] iOS 18 WebOS 模拟器已完成！

## 主要功能
1. 锁屏界面：大字体时间、快捷按钮
2. 主屏幕：4xN 网格布局、Dock 栏
3. 控制中心：亮度/音量调节、Wi-Fi/蓝牙开关
4. 内置应用：电话、信息、Safari、照片、设置、计算器等 15+ 个

所有常用操作和场景都已得到支持。
\`\`\`

判定结果：轨迹完整。理由：过程中有 Write/Edit 等文件写入操作创建和修改了代码文件，末尾有明确的总结段落列出了所有交付的功能点。

## 输出格式
请以 JSON 格式输出，包含判断原因和判断结果，不要输出任何其它内容：
\`\`\`json
{"reason": "简要说明判断依据（1-2句话）", "result": "轨迹完整或轨迹不完整"}
\`\`\``;

// ===================== API 调用 =====================

/**
 * 调用 Anthropic Messages API
 */
function callAnthropicAPI(apiBaseUrl, apiKey, modelName, systemPrompt, userContent, maxTokens = 256) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            model: modelName,
            max_tokens: maxTokens,
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

// ===================== 工具函数 =====================

/**
 * 压缩执行轨迹：按时间顺序交织展示工具调用和模型文本输出
 *
 * 之前的实现：先列所有工具调用，再贴最后3条TXT。
 * 问题：LIMIT 3 丢失大量上下文（有些任务有49条TXT记录），评估模型
 * 看到大量工具调用但只有3小段文本，误判为"输出被截断"。
 *
 * 新实现：按 line_number 顺序交织排列所有条目（工具调用 + 文本），
 * 所有 TXT 文本保留完整内容，工具调用压缩为一行摘要。
 */
function compressTrace(runId) {
    // 取所有相关条目（工具调用 + TXT），按 line_number 排序
    const allEntries = db.prepare(`
        SELECT line_number, type, tool_name, status_class, preview_text
        FROM log_entries
        WHERE run_id = ?
          AND ((tool_name IS NOT NULL) OR (type = 'TXT' AND preview_text IS NOT NULL))
        ORDER BY line_number ASC
    `).all(runId);

    if (allEntries.length === 0) return '(无工具调用记录)';

    let stepNum = 0;
    const lines = allEntries.map(entry => {
        if (entry.tool_name) {
            // 工具调用：一行摘要
            stepNum++;
            let statusLabel;
            if (entry.status_class === 'type-success') {
                statusLabel = '成功';
            } else if (entry.status_class === 'type-error') {
                statusLabel = '失败';
            } else {
                statusLabel = '进行中';
            }
            const preview = entry.preview_text
                ? ': ' + entry.preview_text.substring(0, 80).replace(/\n/g, ' ')
                : '';
            return `${stepNum}. ${entry.tool_name}${preview} → ${statusLabel}`;
        } else {
            // TXT 文本输出：保留完整内容
            const text = entry.preview_text.replace(/\n{3,}/g, '\n\n');
            return `[模型输出] ${text}`;
        }
    });

    return lines.join('\n');
}

/**
 * 归一化模型输出：去除多余空白和标点
 */
function normalizeOutput(text) {
    return text.trim().replace(/[。，.!！\s]+$/, '').trim();
}

/**
 * 合法的轨迹完整度结果值（仅这两种）
 */
const VALID_TRACE_RESULTS = ['轨迹完整', '轨迹不完整'];

/**
 * 解析轨迹完整度的 JSON 响应
 * 兼容模型可能输出带 markdown code block 或纯 JSON
 * 仅接受 "轨迹完整" 和 "轨迹不完整" 两种结果，其它视为解析失败
 */
function parseTraceResponse(raw) {
    const text = raw.trim();
    // 尝试提取 JSON（可能被 ```json ... ``` 包裹）
    const jsonMatch = text.match(/\{[\s\S]*"reason"[\s\S]*"result"[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const obj = JSON.parse(jsonMatch[0]);
            const result = normalizeOutput(obj.result || '');
            const reason = (obj.reason || '').trim();
            // 严格匹配：仅接受这两种结果
            if (VALID_TRACE_RESULTS.includes(result)) {
                return { result, reason };
            }
        } catch (e) {
            // JSON parse failed, fall through
        }
    }
    // fallback：从整段文本中尝试提取合法结果
    const normalized = normalizeOutput(text);
    if (VALID_TRACE_RESULTS.includes(normalized)) {
        return { result: normalized, reason: '' };
    }
    // 无法解析出合法结果，抛错让调用方重试
    throw new Error(`模型返回了无法识别的结果: ${text.substring(0, 100)}`);
}

// =========================================================
// 队列 1：题目分类（per task）— ai_task_classifications
// =========================================================

let clsIsProcessing = false;
let clsActiveCount = 0;

/**
 * 将任务加入题目分类队列
 * @param {Array<string>} taskIds - 任务 ID 数组
 * @returns {number} 成功入队数量
 */
function enqueueForClassification(taskIds) {
    const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO ai_task_classifications (task_id, status)
        VALUES (?, 'pending')
    `);

    let count = 0;
    for (const taskId of taskIds) {
        const result = insertStmt.run(taskId);
        if (result.changes > 0) count++;
    }

    console.log(`[AI-CLS] Enqueued ${count} tasks for classification`);

    if (count > 0) {
        setImmediate(() => processClassificationQueue());
    }
    return count;
}

/**
 * 处理题目分类队列（并发控制）
 */
async function processClassificationQueue() {
    if (clsIsProcessing) return;
    clsIsProcessing = true;

    try {
        const maxConcurrency = config.getAppConfig().aiQcConcurrency || 30;

        while (true) {
            const availableSlots = maxConcurrency - clsActiveCount;
            if (availableSlots <= 0) break;

            const pendingItems = db.prepare(`
                SELECT ac.id, ac.task_id, ac.retry_count,
                       t.prompt as task_prompt
                FROM ai_task_classifications ac
                JOIN tasks t ON ac.task_id = t.task_id
                WHERE ac.status = 'pending'
                ORDER BY ac.id ASC
                LIMIT ?
            `).all(availableSlots);

            if (pendingItems.length === 0) break;

            const updateRunning = db.prepare(
                "UPDATE ai_task_classifications SET status = 'running', started_at = datetime('now') WHERE id = ?"
            );
            for (const item of pendingItems) {
                updateRunning.run(item.id);
            }

            for (const item of pendingItems) {
                clsActiveCount++;
                processOneClassification(item).finally(() => {
                    clsActiveCount--;
                    setImmediate(() => processClassificationQueue());
                });
            }

            break;
        }
    } catch (e) {
        console.error('[AI-CLS] Queue processing error:', e);
    } finally {
        clsIsProcessing = false;
    }
}

/**
 * 处理单条题目分类任务
 */
async function processOneClassification(item) {
    const modelConfig = getPreviewModelConfig();
    if (!modelConfig || !modelConfig.api_base_url || !modelConfig.api_key) {
        db.prepare(
            "UPDATE ai_task_classifications SET status = 'failed', error_message = '未配置辅助模型' WHERE id = ?"
        ).run(item.id);
        console.error('[AI-CLS] No preview model configured');
        return;
    }

    if (item.retry_count > 0) {
        await new Promise(r => setTimeout(r, 1000 * item.retry_count));
    }

    try {
        const rawReqType = await callAnthropicAPI(
            modelConfig.api_base_url,
            modelConfig.api_key,
            modelConfig.model_name,
            REQ_TYPE_SYSTEM_PROMPT,
            item.task_prompt
        );
        const requirementType = normalizeOutput(rawReqType);
        console.log(`[AI-CLS] requirement_type="${requirementType}" task=${item.task_id}`);

        db.prepare(`
            UPDATE ai_task_classifications
            SET requirement_type = ?, status = 'completed', completed_at = datetime('now'), error_message = NULL
            WHERE id = ?
        `).run(requirementType, item.id);

    } catch (err) {
        console.error(`[AI-CLS] Error ${item.task_id}:`, err.message);
        const newRetry = (item.retry_count || 0) + 1;
        if (newRetry >= 3) {
            db.prepare(
                "UPDATE ai_task_classifications SET status = 'failed', error_message = ?, retry_count = ? WHERE id = ?"
            ).run(err.message.substring(0, 500), newRetry, item.id);
        } else {
            db.prepare(
                "UPDATE ai_task_classifications SET status = 'pending', error_message = ?, retry_count = ? WHERE id = ?"
            ).run(err.message.substring(0, 500), newRetry, item.id);
        }
    }
}

/**
 * 获取题目分类进度统计
 */
function getClassificationProgress() {
    return db.prepare(`
        SELECT
            COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
            COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) as running,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
            COUNT(*) as total
        FROM ai_task_classifications
    `).get();
}

// =========================================================
// 队列 2：反馈质检 / 轨迹完整度（per model_run）— ai_quality_inspections
// =========================================================

let traceIsProcessing = false;
let traceActiveCount = 0;

/**
 * 将选中的 task+model 组合加入反馈质检队列
 * @param {Array<{task_id: string, model_id: string}>} items
 * @returns {number} 成功入队数量
 */
function enqueueForTraceCheck(items) {
    const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO ai_quality_inspections (task_id, model_id, status)
        VALUES (?, ?, 'pending')
    `);

    let count = 0;
    for (const item of items) {
        const result = insertStmt.run(item.task_id, item.model_id);
        if (result.changes > 0) count++;
    }

    console.log(`[AI-TRACE] Enqueued ${count} items for trace check`);

    if (count > 0) {
        setImmediate(() => processTraceCheckQueue());
    }
    return count;
}

/**
 * 处理反馈质检队列（并发控制）
 */
async function processTraceCheckQueue() {
    if (traceIsProcessing) return;
    traceIsProcessing = true;

    try {
        const maxConcurrency = config.getAppConfig().aiQcConcurrency || 30;

        while (true) {
            const availableSlots = maxConcurrency - traceActiveCount;
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
                traceActiveCount++;
                processOneTraceCheck(item).finally(() => {
                    traceActiveCount--;
                    setImmediate(() => processTraceCheckQueue());
                });
            }

            break;
        }
    } catch (e) {
        console.error('[AI-TRACE] Queue processing error:', e);
    } finally {
        traceIsProcessing = false;
    }
}

/**
 * 处理单条反馈质检（轨迹完整度）
 */
async function processOneTraceCheck(item) {
    const modelConfig = getPreviewModelConfig();
    if (!modelConfig || !modelConfig.api_base_url || !modelConfig.api_key) {
        db.prepare(
            "UPDATE ai_quality_inspections SET status = 'failed', error_message = '未配置辅助模型' WHERE id = ?"
        ).run(item.id);
        console.error('[AI-TRACE] No preview model configured');
        return;
    }

    if (item.retry_count > 0) {
        await new Promise(r => setTimeout(r, 1000 * item.retry_count));
    }

    try {
        const run = db.prepare(
            'SELECT id FROM model_runs WHERE task_id = ? AND model_id = ?'
        ).get(item.task_id, item.model_id);

        let traceCompleteness = null;
        let traceReason = null;

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
            const parsed = parseTraceResponse(rawTrace);
            traceCompleteness = parsed.result;
            traceReason = parsed.reason;
            console.log(`[AI-TRACE] trace="${traceCompleteness}" reason="${traceReason}" ${item.task_id}/${item.model_id}`);
        } else {
            traceCompleteness = '轨迹不完整';
            traceReason = '未找到对应的模型执行记录';
            console.warn(`[AI-TRACE] No model_run found for ${item.task_id}/${item.model_id}`);
        }

        db.prepare(`
            UPDATE ai_quality_inspections
            SET trace_completeness = ?, trace_reason = ?,
                status = 'completed', completed_at = datetime('now'), error_message = NULL
            WHERE id = ?
        `).run(traceCompleteness, traceReason, item.id);

    } catch (err) {
        console.error(`[AI-TRACE] Error ${item.task_id}/${item.model_id}:`, err.message);
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
 * 获取反馈质检进度统计
 */
function getTraceCheckProgress() {
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

// ===================== 导出 =====================

module.exports = {
    // 题目分类
    enqueueForClassification,
    processClassificationQueue,
    getClassificationProgress,
    // 反馈质检
    enqueueForTraceCheck,
    processTraceCheckQueue,
    getTraceCheckProgress,
    // 工具
    compressTrace,
    callAnthropicAPI
};
