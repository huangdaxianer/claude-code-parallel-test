const db = require('../db');
const config = require('../config');
const { compressTrace, callAnthropicAPI } = require('./aiQcService');

let analysisIsProcessing = false;
let analysisActiveCount = 0;

const MAX_TRACE_LENGTH = 20000;

const ANALYSIS_SYSTEM_PROMPT = `你是一个专业的 AI 编程助手评测分析师。你的任务是基于用户的评分和反馈，结合执行轨迹，深入分析两个模型在同一编程任务上的表现差异。

分析原则：
- 以用户反馈为核心：你的分析必须以用户给出的评分和文字反馈为出发点。用户的评分和评论反映了他们对模型表现的真实感受，你需要解释"为什么用户给出了这样的评分"，而不是脱离用户反馈自行评判。
- 轨迹作为佐证：执行轨迹是帮助你理解用户评分背后原因的工具。当用户对某个模型评分较低或给出负面评论时，你应从轨迹中找到具体的步骤或行为来解释原因。

输入说明：
你会收到以下信息：
1. 用户需求：原始的编程任务描述
2. 两个模型的执行轨迹：工具调用和模型输出的压缩记录（模型用后台配置的备注名称标识）
3. 评分维度与分数：用户在各评测维度上对两个模型分别给出的评分
4. 用户反馈：用户对两个模型的文字评价，包括评分时的评论、主动反馈和行内批注

分析框架：
1. 评分差异解读：逐维度对比评分，重点关注差距较大的维度，从轨迹中找原因。评分相同的维度简要带过。
2. 用户反馈要点：归纳用户文字反馈中的关键问题和亮点，将主观感受与轨迹中的客观行为对应。
3. 策略差异：基于用户反馈和轨迹，分析两个模型的执行策略差异，哪些策略导致了更好或更差的评分。
4. 结论：2-3 句话总结哪个模型更好，核心优劣势。

输出要求：
- 不要使用 Markdown 格式，使用纯文本输出
- 不超过 200 字
- 如果用户没有给出评分或反馈，基于轨迹进行有限度的客观分析，并注明"无用户反馈数据"
- 避免泛泛而谈，每个观点都应有评分数据或用户反馈或轨迹证据支撑`;

// ===================== Preview Model Config =====================

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

// ===================== Prompt Construction =====================

function getModelDisplayName(modelId) {
    const mc = db.prepare(
        'SELECT COALESCE(description, endpoint_name) as name FROM model_configs WHERE model_id = ?'
    ).get(modelId);
    return mc ? mc.name : modelId;
}

function truncateTrace(trace) {
    if (trace.length <= MAX_TRACE_LENGTH) return trace;
    return trace.substring(0, MAX_TRACE_LENGTH) + '\n...(已截断)';
}

function buildAnalysisPrompt(taskId, modelAId, modelBId) {
    const task = db.prepare('SELECT prompt, title FROM tasks WHERE task_id = ?').get(taskId);
    if (!task) return null;

    const modelAName = getModelDisplayName(modelAId);
    const modelBName = getModelDisplayName(modelBId);

    // Get compressed traces
    const runA = db.prepare('SELECT id FROM model_runs WHERE task_id = ? AND model_id = ?').get(taskId, modelAId);
    const runB = db.prepare('SELECT id FROM model_runs WHERE task_id = ? AND model_id = ?').get(taskId, modelBId);
    const traceA = runA ? truncateTrace(compressTrace(runA.id)) : '(无轨迹)';
    const traceB = runB ? truncateTrace(compressTrace(runB.id)) : '(无轨迹)';

    // Get feedback question stems and scores
    const questions = db.prepare(
        'SELECT id, stem, short_name, scoring_type FROM feedback_questions WHERE is_active = 1 ORDER BY display_order, id'
    ).all();

    let scoresSection = '';
    if (questions.length > 0) {
        const scoreLines = [];
        for (const q of questions) {
            const scoreA = db.prepare(
                'SELECT score FROM feedback_responses WHERE task_id = ? AND model_id = ? AND question_id = ? AND score IS NOT NULL AND score > 0'
            ).get(taskId, modelAId, q.id);
            const scoreB = db.prepare(
                'SELECT score FROM feedback_responses WHERE task_id = ? AND model_id = ? AND question_id = ? AND score IS NOT NULL AND score > 0'
            ).get(taskId, modelBId, q.id);

            const qName = q.short_name || q.stem;
            const sA = scoreA ? scoreA.score : '未评分';
            const sB = scoreB ? scoreB.score : '未评分';
            const maxScore = q.scoring_type === 'stars_3' ? 3 : 5;
            scoreLines.push(`- ${qName}（满分${maxScore}）: ${modelAName}=${sA}, ${modelBName}=${sB}`);
        }
        scoresSection = `\n用户评分：\n${scoreLines.join('\n')}`;
    }

    // Get all user feedback/comments
    const feedbackItems = [];

    // Scoring comments (from feedback_responses)
    const scoringComments = db.prepare(`
        SELECT fr.comment, fr.model_id, fq.short_name, fq.stem
        FROM feedback_responses fr
        JOIN feedback_questions fq ON fq.id = fr.question_id
        WHERE fr.task_id = ? AND fr.model_id IN (?, ?)
          AND fr.comment IS NOT NULL AND fr.comment != ''
    `).all(taskId, modelAId, modelBId);
    for (const c of scoringComments) {
        const modelLabel = c.model_id === modelAId ? modelAName : modelBName;
        feedbackItems.push(`[${modelLabel} - 评分评论/${c.short_name || c.stem}] ${c.comment}`);
    }

    // Voluntary user feedback
    const voluntaryFb = db.prepare(`
        SELECT content, model_id FROM user_feedback
        WHERE task_id = ? AND model_id IN (?, ?)
          AND content IS NOT NULL AND content != ''
    `).all(taskId, modelAId, modelBId);
    for (const f of voluntaryFb) {
        const modelLabel = f.model_id === modelAId ? modelAName : modelBName;
        feedbackItems.push(`[${modelLabel} - 主动反馈] ${f.content}`);
    }

    // Inline comments
    const inlineComments = db.prepare(`
        SELECT content, model_id, target_type FROM feedback_comments
        WHERE task_id = ? AND model_id IN (?, ?)
          AND content IS NOT NULL AND content != ''
    `).all(taskId, modelAId, modelBId);
    for (const c of inlineComments) {
        const modelLabel = c.model_id === modelAId ? modelAName : modelBName;
        feedbackItems.push(`[${modelLabel} - 行内批注] ${c.content}`);
    }

    let feedbackSection = '';
    if (feedbackItems.length > 0) {
        feedbackSection = `\n用户反馈：\n${feedbackItems.join('\n')}`;
    }

    return `用户需求：\n${task.prompt || task.title || '(无)'}\n\n${modelAName} 执行轨迹：\n${traceA}\n\n${modelBName} 执行轨迹：\n${traceB}${scoresSection}${feedbackSection}`;
}

// ===================== Queue Processing =====================

function enqueueAnalysis(analysisId) {
    console.log(`[AI-Analysis] Enqueuing analysis ${analysisId}`);
    setImmediate(() => processAnalysisQueue());
}

async function processAnalysisQueue() {
    if (analysisIsProcessing) return;
    analysisIsProcessing = true;

    try {
        const maxConcurrency = config.getAppConfig().aiQcConcurrency || 30;

        while (true) {
            const availableSlots = maxConcurrency - analysisActiveCount;
            if (availableSlots <= 0) break;

            const pendingItems = db.prepare(`
                SELECT ar.id, ar.analysis_id, ar.task_id, ar.retry_count,
                       a.model_a_id, a.model_b_id
                FROM ai_analysis_results ar
                JOIN ai_analyses a ON ar.analysis_id = a.id
                WHERE ar.status = 'pending'
                ORDER BY ar.id ASC
                LIMIT ?
            `).all(availableSlots);

            if (pendingItems.length === 0) break;

            const updateRunning = db.prepare(
                "UPDATE ai_analysis_results SET status = 'running', started_at = datetime('now') WHERE id = ?"
            );
            for (const item of pendingItems) {
                updateRunning.run(item.id);
            }

            for (const item of pendingItems) {
                analysisActiveCount++;
                processOneAnalysis(item).finally(() => {
                    analysisActiveCount--;
                    updateAnalysisProgress(item.analysis_id);
                    setImmediate(() => processAnalysisQueue());
                });
            }

            break;
        }
    } catch (e) {
        console.error('[AI-Analysis] Queue processing error:', e);
    } finally {
        analysisIsProcessing = false;
    }
}

async function processOneAnalysis(item) {
    const modelConfig = getPreviewModelConfig();
    if (!modelConfig || !modelConfig.api_base_url || !modelConfig.api_key) {
        db.prepare(
            "UPDATE ai_analysis_results SET status = 'failed', error_message = '未配置辅助模型' WHERE id = ?"
        ).run(item.id);
        return;
    }

    if (item.retry_count > 0) {
        await new Promise(r => setTimeout(r, 1000 * item.retry_count));
    }

    try {
        const userContent = buildAnalysisPrompt(item.task_id, item.model_a_id, item.model_b_id);
        if (!userContent) {
            db.prepare(
                "UPDATE ai_analysis_results SET status = 'failed', error_message = '无法构建分析输入（任务不存在）' WHERE id = ?"
            ).run(item.id);
            return;
        }

        const insight = await callAnthropicAPI(
            modelConfig.api_base_url,
            modelConfig.api_key,
            modelConfig.model_name,
            ANALYSIS_SYSTEM_PROMPT,
            userContent,
            2048
        );

        db.prepare(`
            UPDATE ai_analysis_results
            SET insight = ?, status = 'completed', completed_at = datetime('now'), error_message = NULL
            WHERE id = ?
        `).run(insight, item.id);

        console.log(`[AI-Analysis] Completed task=${item.task_id} analysis=${item.analysis_id}`);
    } catch (err) {
        console.error(`[AI-Analysis] Error task=${item.task_id}:`, err.message);
        const newRetry = (item.retry_count || 0) + 1;
        if (newRetry >= 3) {
            db.prepare(
                "UPDATE ai_analysis_results SET status = 'failed', error_message = ?, retry_count = ? WHERE id = ?"
            ).run(err.message.substring(0, 500), newRetry, item.id);
        } else {
            db.prepare(
                "UPDATE ai_analysis_results SET status = 'pending', error_message = ?, retry_count = ? WHERE id = ?"
            ).run(err.message.substring(0, 500), newRetry, item.id);
        }
    }
}

function updateAnalysisProgress(analysisId) {
    const progress = db.prepare(`
        SELECT
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
            COUNT(*) as total
        FROM ai_analysis_results WHERE analysis_id = ?
    `).get(analysisId);

    const allDone = (progress.completed + progress.failed) >= progress.total;
    const overallStatus = allDone ? 'completed' : 'processing';

    db.prepare(`
        UPDATE ai_analyses
        SET completed_count = ?, failed_count = ?,
            status = ?,
            completed_at = CASE WHEN ? = 1 THEN datetime('now') ELSE completed_at END
        WHERE id = ?
    `).run(progress.completed, progress.failed, overallStatus, allDone ? 1 : 0, analysisId);
}

module.exports = {
    enqueueAnalysis,
    processAnalysisQueue,
    buildAnalysisPrompt,
    updateAnalysisProgress
};
