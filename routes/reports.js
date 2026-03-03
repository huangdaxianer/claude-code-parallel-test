const express = require('express');
const router = express.Router();
const db = require('../db');

function generateReportId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function computeConfidenceInterval95(values) {
    if (values.length === 0) return { mean: 0, lower: 0, upper: 0 };
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    if (n === 1) return { mean, lower: mean, upper: mean };

    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (n - 1);
    const stdErr = Math.sqrt(variance / n);
    const tValue = n <= 30 ? getTValue(n - 1) : 1.96;
    const margin = tValue * stdErr;

    return {
        mean: Math.round(mean * 100) / 100,
        lower: Math.round((mean - margin) * 100) / 100,
        upper: Math.round((mean + margin) * 100) / 100
    };
}

function getTValue(df) {
    const tTable = {
        1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
        6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
        11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
        16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
        25: 2.060, 30: 2.042
    };
    if (tTable[df]) return tTable[df];
    const keys = Object.keys(tTable).map(Number).sort((a, b) => a - b);
    for (let i = 0; i < keys.length - 1; i++) {
        if (df > keys[i] && df < keys[i + 1]) {
            const ratio = (df - keys[i]) / (keys[i + 1] - keys[i]);
            return tTable[keys[i]] * (1 - ratio) + tTable[keys[i + 1]] * ratio;
        }
    }
    return 1.96;
}

// GET /api/admin/report/models - all enabled models for admin
router.get('/models', (req, res) => {
    try {
        const models = db.prepare(`
            SELECT mc.model_id as id, mc.endpoint_name as name, mc.description
            FROM model_configs mc
            WHERE mc.model_id IS NOT NULL
            ORDER BY mc.endpoint_name ASC
        `).all();
        res.json(models);
    } catch (e) {
        console.error('[Report] Error fetching models:', e);
        res.status(500).json({ error: 'Failed to fetch models' });
    }
});

// POST /api/admin/report/available-tasks - tasks that qualify for report
router.post('/available-tasks', (req, res) => {
    try {
        const { reportType, modelIds } = req.body;
        if (!reportType || !Array.isArray(modelIds) || modelIds.length === 0) {
            return res.status(400).json({ error: 'Missing reportType or modelIds' });
        }

        const requiredStatus = reportType === 'trace_and_score' ? 'evaluated' : null;
        const placeholders = modelIds.map(() => '?').join(',');

        const allTasks = db.prepare(`
            SELECT DISTINCT t.task_id, t.title, u.username, t.created_at
            FROM tasks t
            JOIN users u ON t.user_id = u.id
            JOIN model_runs mr ON mr.task_id = t.task_id
            WHERE mr.model_id IN (${placeholders})
            ORDER BY t.created_at DESC
        `).all(...modelIds);

        const qualifiedTasks = allTasks.filter(task => {
            const runs = db.prepare(`
                SELECT model_id, status FROM model_runs
                WHERE task_id = ? AND model_id IN (${placeholders})
            `).all(task.task_id, ...modelIds);

            if (runs.length !== modelIds.length) return false;

            if (requiredStatus) {
                return runs.every(r => r.status === requiredStatus);
            }
            return runs.every(r => r.status === 'completed' || r.status === 'evaluated');
        });

        res.json(qualifiedTasks);
    } catch (e) {
        console.error('[Report] Error fetching available tasks:', e);
        res.status(500).json({ error: 'Failed to fetch available tasks' });
    }
});

// POST /api/admin/report/create - generate report
router.post('/create', (req, res) => {
    try {
        const { reportType, modelIds, taskIds, title } = req.body;
        if (!reportType || !Array.isArray(modelIds) || !Array.isArray(taskIds) || modelIds.length === 0 || taskIds.length === 0) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const modelPlaceholders = modelIds.map(() => '?').join(',');
        const taskPlaceholders = taskIds.map(() => '?').join(',');

        const models = db.prepare(`
            SELECT model_id as id, endpoint_name as name, description
            FROM model_configs WHERE model_id IN (${modelPlaceholders})
        `).all(...modelIds);

        const tasks = db.prepare(`
            SELECT t.task_id, t.title, u.username
            FROM tasks t JOIN users u ON t.user_id = u.id
            WHERE t.task_id IN (${taskPlaceholders})
        `).all(...taskIds);

        const modelStats = {};
        for (const modelId of modelIds) {
            const runs = db.prepare(`
                SELECT duration, turns, input_tokens, output_tokens, cache_read_tokens,
                       count_todo_write, count_read, count_write, count_bash
                FROM model_runs
                WHERE model_id = ? AND task_id IN (${taskPlaceholders})
            `).all(modelId, ...taskIds);

            const n = runs.length;
            if (n === 0) {
                modelStats[modelId] = { taskCount: 0 };
                continue;
            }

            const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
            const round2 = (v) => Math.round(v * 100) / 100;

            const durations = runs.map(r => r.duration || 0);
            const turnsList = runs.map(r => r.turns || 0);
            const inputTokens = runs.map(r => r.input_tokens || 0);
            const outputTokens = runs.map(r => r.output_tokens || 0);
            const cacheTokens = runs.map(r => r.cache_read_tokens || 0);
            const todoWrites = runs.map(r => r.count_todo_write || 0);
            const reads = runs.map(r => r.count_read || 0);
            const writes = runs.map(r => r.count_write || 0);
            const bashes = runs.map(r => r.count_bash || 0);
            const totalTools = runs.map(r =>
                (r.count_todo_write || 0) + (r.count_read || 0) + (r.count_write || 0) + (r.count_bash || 0)
            );

            modelStats[modelId] = {
                taskCount: n,
                avgDuration: round2(avg(durations)),
                avgTurns: round2(avg(turnsList)),
                avgInputTokens: round2(avg(inputTokens)),
                avgOutputTokens: round2(avg(outputTokens)),
                avgCacheReadTokens: round2(avg(cacheTokens)),
                avgTodoWrite: round2(avg(todoWrites)),
                avgRead: round2(avg(reads)),
                avgWrite: round2(avg(writes)),
                avgBash: round2(avg(bashes)),
                avgTotalToolCalls: round2(avg(totalTools)),
                duration: computeConfidenceInterval95(durations),
                turns: computeConfidenceInterval95(turnsList),
                inputTokens: computeConfidenceInterval95(inputTokens),
                outputTokens: computeConfidenceInterval95(outputTokens),
            };
        }

        let scoreStats = null;
        if (reportType === 'trace_and_score') {
            scoreStats = {};
            const activeQuestions = db.prepare(`
                SELECT id, stem, short_name, scoring_type
                FROM feedback_questions WHERE is_active = 1 ORDER BY display_order, id
            `).all();

            for (const modelId of modelIds) {
                scoreStats[modelId] = {};
                for (const question of activeQuestions) {
                    const scores = db.prepare(`
                        SELECT score FROM feedback_responses
                        WHERE model_id = ? AND question_id = ? AND task_id IN (${taskPlaceholders})
                        AND score IS NOT NULL AND score > 0
                    `).all(modelId, question.id, ...taskIds).map(r => r.score);

                    const maxScore = question.scoring_type === 'stars_5' ? 5 : 3;
                    scoreStats[modelId][question.id] = {
                        questionName: question.short_name || question.stem,
                        scoringType: question.scoring_type,
                        maxScore,
                        count: scores.length,
                        scores,
                        ...computeConfidenceInterval95(scores)
                    };
                }
            }
        }

        // User Voices: collect all comments at report creation time
        const userVoices = [];

        // 1) Scoring question comments (feedback_responses with non-empty comment)
        const activeQuestionsForVoices = db.prepare(`
            SELECT id, stem, short_name FROM feedback_questions WHERE is_active = 1 ORDER BY display_order, id
        `).all();
        const qNameMap = {};
        for (const q of activeQuestionsForVoices) {
            qNameMap[q.id] = q.short_name || q.stem;
        }

        const scoringComments = db.prepare(`
            SELECT fr.task_id, fr.model_id, fr.question_id, fr.comment, fr.score,
                   mc.endpoint_name as model_name, t.title as task_title,
                   COALESCE(u_resp.username, u_task.username) as username
            FROM feedback_responses fr
            JOIN model_configs mc ON mc.model_id = fr.model_id
            JOIN tasks t ON t.task_id = fr.task_id
            JOIN users u_task ON t.user_id = u_task.id
            LEFT JOIN users u_resp ON fr.user_id = u_resp.id
            WHERE fr.task_id IN (${taskPlaceholders}) AND fr.model_id IN (${modelPlaceholders})
              AND fr.comment IS NOT NULL AND fr.comment != ''
        `).all(...taskIds, ...modelIds);

        for (const row of scoringComments) {
            userVoices.push({
                modelId: row.model_id,
                modelName: row.model_name,
                category: qNameMap[row.question_id] || '评分反馈',
                categoryType: 'score',
                content: row.comment,
                taskId: row.task_id,
                taskTitle: row.task_title,
                username: row.username,
                score: row.score,
            });
        }

        // 2) Voluntary feedback (user_feedback)
        const voluntaryFeedback = db.prepare(`
            SELECT uf.task_id, uf.model_id, uf.content,
                   mc.endpoint_name as model_name, t.title as task_title, u.username
            FROM user_feedback uf
            JOIN model_configs mc ON mc.model_id = uf.model_id
            JOIN tasks t ON t.task_id = uf.task_id
            JOIN users u ON uf.user_id = u.id
            WHERE uf.task_id IN (${taskPlaceholders}) AND uf.model_id IN (${modelPlaceholders})
              AND uf.content IS NOT NULL AND uf.content != ''
        `).all(...taskIds, ...modelIds);

        for (const row of voluntaryFeedback) {
            userVoices.push({
                modelId: row.model_id,
                modelName: row.model_name,
                category: '主动反馈',
                categoryType: 'voluntary',
                content: row.content,
                taskId: row.task_id,
                taskTitle: row.task_title,
                username: row.username,
            });
        }

        // 3) Inline comments (feedback_comments)
        const inlineComments = db.prepare(`
            SELECT fc.task_id, fc.model_id, fc.content, fc.target_type,
                   mc.endpoint_name as model_name, t.title as task_title, u2.username
            FROM feedback_comments fc
            JOIN model_configs mc ON mc.model_id = fc.model_id
            JOIN tasks t ON t.task_id = fc.task_id
            JOIN users u2 ON fc.user_id = u2.id
            WHERE fc.task_id IN (${taskPlaceholders}) AND fc.model_id IN (${modelPlaceholders})
              AND fc.content IS NOT NULL AND fc.content != ''
        `).all(...taskIds, ...modelIds);

        for (const row of inlineComments) {
            userVoices.push({
                modelId: row.model_id,
                modelName: row.model_name,
                category: '评论反馈',
                categoryType: 'inline',
                content: row.content,
                taskId: row.task_id,
                taskTitle: row.task_title,
                username: row.username,
            });
        }

        const reportData = {
            type: reportType,
            models: models.map(m => ({ ...m, stats: modelStats[m.id] })),
            tasks,
            scoreStats,
            userVoices,
        };

        let reportId;
        do {
            reportId = generateReportId();
        } while (db.prepare('SELECT 1 FROM reports WHERE id = ?').get(reportId));

        const reportTitle = title || `${reportType === 'trace_only' ? '轨迹分析' : '轨迹与评分分析'}报告 - ${new Date().toLocaleDateString('zh-CN')}`;

        db.prepare(`
            INSERT INTO reports (id, title, report_type, selected_models, selected_tasks, report_data, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            reportId,
            reportTitle,
            reportType,
            JSON.stringify(modelIds),
            JSON.stringify(taskIds),
            JSON.stringify(reportData),
            req.user.id
        );

        res.json({ success: true, reportId, reportUrl: `/report.html?id=${reportId}` });
    } catch (e) {
        console.error('[Report] Error creating report:', e);
        res.status(500).json({ error: 'Failed to create report' });
    }
});

// GET /api/admin/report/list - list all reports
router.get('/list', (req, res) => {
    try {
        const reports = db.prepare(`
            SELECT r.id, r.title, r.report_type, r.created_at, u.username as created_by
            FROM reports r
            LEFT JOIN users u ON r.created_by = u.id
            ORDER BY r.created_at DESC
        `).all();
        res.json(reports);
    } catch (e) {
        console.error('[Report] Error listing reports:', e);
        res.status(500).json({ error: 'Failed to list reports' });
    }
});

// DELETE /api/admin/report/:id
router.delete('/:id', (req, res) => {
    try {
        db.prepare('DELETE FROM reports WHERE id = ?').run(req.params.id);
        res.json({ success: true });
    } catch (e) {
        console.error('[Report] Error deleting report:', e);
        res.status(500).json({ error: 'Failed to delete report' });
    }
});

module.exports = router;
