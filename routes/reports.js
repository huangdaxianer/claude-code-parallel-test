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

// GET /api/admin/report/models - 只返回对当前用户组启用的模型
router.get('/models', (req, res) => {
    try {
        const groupId = req.user.group_id;
        const models = db.prepare(`
            SELECT mc.model_id as id, COALESCE(mc.description, mc.endpoint_name) as name, mc.description
            FROM model_configs mc
            LEFT JOIN model_group_settings mgs ON mc.id = mgs.model_id AND mgs.group_id = ?
            WHERE mc.model_id IS NOT NULL AND COALESCE(mgs.is_enabled, 1) = 1
            ORDER BY mc.endpoint_name ASC
        `).all(groupId);
        res.json(models);
    } catch (e) {
        console.error('[Report] Error fetching models:', e);
        res.status(500).json({ error: 'Failed to fetch models' });
    }
});

// GET /api/admin/report/questions - active feedback questions for ability selection
router.get('/questions', (req, res) => {
    try {
        const questions = db.prepare(`
            SELECT id, stem, short_name, scoring_type, options_json, display_order
            FROM feedback_questions WHERE is_active = 1 ORDER BY display_order, id
        `).all();
        res.json(questions);
    } catch (e) {
        console.error('[Report] Error fetching questions:', e);
        res.status(500).json({ error: 'Failed to fetch questions' });
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

        // 附加 AI 质检状态，用于前端"全选合格任务"功能
        const clsStmt = db.prepare(
            'SELECT requirement_type FROM ai_task_classifications WHERE task_id = ? AND status = ?'
        );
        const traceStmt = db.prepare(`
            SELECT trace_completeness FROM ai_quality_inspections
            WHERE task_id = ? AND model_id IN (${placeholders}) AND status = 'completed'
        `);
        for (const task of qualifiedTasks) {
            // 题目分类：是否"不符合要求"
            const cls = clsStmt.get(task.task_id, 'completed');
            task.requirement_type = cls ? cls.requirement_type : null;

            // 轨迹完整度：所选模型中是否有"轨迹不完整"
            const traces = traceStmt.all(task.task_id, ...modelIds);
            task.has_incomplete_trace = traces.some(t => t.trace_completeness === '轨迹不完整');
        }

        res.json(qualifiedTasks);
    } catch (e) {
        console.error('[Report] Error fetching available tasks:', e);
        res.status(500).json({ error: 'Failed to fetch available tasks' });
    }
});

// POST /api/admin/report/create - generate report
router.post('/create', (req, res) => {
    try {
        const { reportType, modelIds, taskIds, title, selectedQuestionIds, questionWeights } = req.body;
        if (!reportType || !Array.isArray(modelIds) || !Array.isArray(taskIds) || modelIds.length === 0 || taskIds.length === 0) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const modelPlaceholders = modelIds.map(() => '?').join(',');
        const taskPlaceholders = taskIds.map(() => '?').join(',');

        const models = db.prepare(`
            SELECT model_id as id, COALESCE(description, endpoint_name) as name, description
            FROM model_configs WHERE model_id IN (${modelPlaceholders})
        `).all(...modelIds);

        const tasks = db.prepare(`
            SELECT t.task_id, t.title, u.username, t.source_type
            FROM tasks t JOIN users u ON t.user_id = u.id
            WHERE t.task_id IN (${taskPlaceholders})
        `).all(...taskIds);

        const modelStats = {};
        for (const modelId of modelIds) {
            const runs = db.prepare(`
                SELECT duration, turns, input_tokens, output_tokens, cache_read_tokens,
                       count_todo_write, count_read, count_write, count_bash,
                       count_edit, count_glob, count_grep, count_agent
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
            const inputTokens = runs.map(r => (r.input_tokens || 0) + (r.cache_read_tokens || 0));
            const outputTokens = runs.map(r => r.output_tokens || 0);
            const cacheTokens = runs.map(r => r.cache_read_tokens || 0);
            const todoWrites = runs.map(r => r.count_todo_write || 0);
            const reads = runs.map(r => r.count_read || 0);
            const writes = runs.map(r => r.count_write || 0);
            const bashes = runs.map(r => r.count_bash || 0);
            const edits = runs.map(r => r.count_edit || 0);
            const globs = runs.map(r => r.count_glob || 0);
            const greps = runs.map(r => r.count_grep || 0);
            const agents = runs.map(r => r.count_agent || 0);
            const totalTools = runs.map(r => r.turns || 0);

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
                avgEdit: round2(avg(edits)),
                avgGlob: round2(avg(globs)),
                avgGrep: round2(avg(greps)),
                avgAgent: round2(avg(agents)),
                avgTotalToolCalls: round2(avg(totalTools)),
                duration: computeConfidenceInterval95(durations),
                turns: computeConfidenceInterval95(turnsList),
                inputTokens: computeConfidenceInterval95(inputTokens),
                outputTokens: computeConfidenceInterval95(outputTokens),
                todoWrite: computeConfidenceInterval95(todoWrites),
                read: computeConfidenceInterval95(reads),
                write: computeConfidenceInterval95(writes),
                bash: computeConfidenceInterval95(bashes),
                edit: computeConfidenceInterval95(edits),
                glob: computeConfidenceInterval95(globs),
                grep: computeConfidenceInterval95(greps),
                agent: computeConfidenceInterval95(agents),
            };
        }

        // Map score for 3-point scale: 1→1, 2→3, 3→5 (align with 5-point)
        function mapScore(rawScore, scoringType) {
            if (scoringType === 'stars_3') {
                const map = { 1: 1, 2: 3, 3: 5 };
                return map[rawScore] || rawScore;
            }
            return rawScore;
        }

        let scoreStats = null;
        let scoreQuestionMeta = null;
        if (reportType === 'trace_and_score') {
            scoreStats = {};
            scoreQuestionMeta = {};

            // Use selected questions or fall back to all active
            let questions;
            if (Array.isArray(selectedQuestionIds) && selectedQuestionIds.length > 0) {
                const qPlaceholders = selectedQuestionIds.map(() => '?').join(',');
                questions = db.prepare(`
                    SELECT id, stem, short_name, scoring_type, options_json, display_order
                    FROM feedback_questions WHERE id IN (${qPlaceholders}) AND is_active = 1
                    ORDER BY display_order, id
                `).all(...selectedQuestionIds);
            } else {
                questions = db.prepare(`
                    SELECT id, stem, short_name, scoring_type, options_json, display_order
                    FROM feedback_questions WHERE is_active = 1 ORDER BY display_order, id
                `).all();
            }

            // Build question metadata (for tooltip in report page)
            for (const q of questions) {
                let rawOptions = [];
                try { rawOptions = q.options_json ? JSON.parse(q.options_json) : []; } catch (e) {}

                const isStars3 = q.scoring_type === 'stars_3';
                const defaultLabels = isStars3 ? ['差', '一般', '好'] : ['非常差', '差', '一般', '好', '非常好'];
                const labels = (Array.isArray(rawOptions) && rawOptions.length > 0 && rawOptions.some(o => o && o.trim()))
                    ? rawOptions : defaultLabels;

                const options = labels.map((label, idx) => {
                    const rawValue = idx + 1;
                    const mappedValue = isStars3 ? ({ 1: 1, 2: 3, 3: 5 }[rawValue] || rawValue) : rawValue;
                    return { value: mappedValue, label: label || '' };
                });

                scoreQuestionMeta[q.id] = {
                    questionName: q.short_name || q.stem,
                    scoringType: q.scoring_type,
                    maxScore: 5,
                    options,
                };
            }

            // Accumulate per-task mapped scores across questions for avg CI
            // taskScoresByModel[modelId][taskId] = [mappedScore, ...]
            const taskScoresByModel = {};
            for (const modelId of modelIds) taskScoresByModel[modelId] = {};

            // For each question, find "complete" tasks where ALL models have scores
            for (const question of questions) {
                // Fetch all responses for this question across all models and tasks
                const allResponses = db.prepare(`
                    SELECT task_id, model_id, score FROM feedback_responses
                    WHERE question_id = ? AND task_id IN (${taskPlaceholders})
                      AND model_id IN (${modelPlaceholders})
                      AND score IS NOT NULL AND score > 0
                `).all(question.id, ...taskIds, ...modelIds);

                // Group by task_id → set of model_ids that have scores
                const taskModelScores = {};
                for (const r of allResponses) {
                    if (!taskModelScores[r.task_id]) taskModelScores[r.task_id] = {};
                    taskModelScores[r.task_id][r.model_id] = r.score;
                }

                // Only keep tasks where ALL selected models have a score
                const completeTasks = Object.keys(taskModelScores).filter(tid =>
                    modelIds.every(mid => taskModelScores[tid][mid] != null)
                );

                for (const modelId of modelIds) {
                    if (!scoreStats[modelId]) scoreStats[modelId] = {};

                    const scores = completeTasks
                        .map(tid => mapScore(taskModelScores[tid][modelId], question.scoring_type))
                        .filter(s => s != null);

                    scoreStats[modelId][question.id] = {
                        questionName: question.short_name || question.stem,
                        scoringType: question.scoring_type,
                        maxScore: 5,
                        count: scores.length,
                        ...computeConfidenceInterval95(scores)
                    };

                    // Accumulate per-task scores for avg CI (same complete-task filter)
                    for (const tid of completeTasks) {
                        const mapped = mapScore(taskModelScores[tid][modelId], question.scoring_type);
                        if (mapped != null) {
                            if (!taskScoresByModel[modelId][tid]) taskScoresByModel[modelId][tid] = [];
                            taskScoresByModel[modelId][tid].push(mapped);
                        }
                    }
                }
            }

            // Build weight map: questionId → weight fraction (0~1)
            const hasWeights = questionWeights && typeof questionWeights === 'object' && Object.keys(questionWeights).length > 0;
            const weightMap = {};
            if (hasWeights) {
                for (const qId in questionWeights) {
                    weightMap[qId] = (parseInt(questionWeights[qId]) || 0) / 100;
                }
            } else {
                // Equal weights fallback
                const n = questions.length;
                for (const q of questions) {
                    weightMap[q.id] = 1 / n;
                }
            }

            // Compute weighted total CI per model: per-task weighted sum → CI across tasks
            for (const modelId of modelIds) {
                if (!scoreStats[modelId]) scoreStats[modelId] = {};

                // For each task, compute weighted sum instead of simple average
                const perTaskWeightedSums = [];
                const taskEntries = taskScoresByModel[modelId];
                // We need per-task per-question scores, rebuild from scoreStats
                // Use the already-accumulated taskScoresByModel which has per-task arrays (ordered by question)
                // But taskScoresByModel stores flat arrays without question association
                // We need a different approach: use raw data keyed by task+question

                // Rebuild per-task weighted sums from raw score data
                const taskQuestionScores = {}; // taskId → { questionId → mappedScore }
                for (const question of questions) {
                    const qStats = scoreStats[modelId][question.id];
                    if (!qStats || qStats.count === 0) continue;

                    const allResponses = db.prepare(`
                        SELECT task_id, score FROM feedback_responses
                        WHERE question_id = ? AND task_id IN (${taskPlaceholders})
                          AND model_id = ? AND score IS NOT NULL AND score > 0
                    `).all(question.id, ...taskIds, modelId);

                    for (const r of allResponses) {
                        if (!taskQuestionScores[r.task_id]) taskQuestionScores[r.task_id] = {};
                        taskQuestionScores[r.task_id][question.id] = mapScore(r.score, question.scoring_type);
                    }
                }

                // For each task that has all questions scored, compute weighted sum
                for (const tid of Object.keys(taskQuestionScores)) {
                    const tScores = taskQuestionScores[tid];
                    const questionIds = questions.map(q => q.id);
                    const hasAll = questionIds.every(qid => tScores[qid] != null);
                    if (!hasAll) continue;

                    let weightedSum = 0;
                    for (const qid of questionIds) {
                        const w = weightMap[qid] || 0;
                        weightedSum += tScores[qid] * w;
                    }
                    perTaskWeightedSums.push(weightedSum);
                }

                scoreStats[modelId]['_avg'] = {
                    count: perTaskWeightedSums.length,
                    ...computeConfidenceInterval95(perTaskWeightedSums)
                };
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
                   COALESCE(mc.description, mc.endpoint_name) as model_name, t.title as task_title,
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
                   COALESCE(mc.description, mc.endpoint_name) as model_name, t.title as task_title, u.username
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
                   COALESCE(mc.description, mc.endpoint_name) as model_name, t.title as task_title, u2.username
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

        // Build raw per-task data for frontend filtering
        const allRunsRaw = db.prepare(`
            SELECT task_id, model_id, duration, turns, input_tokens, output_tokens, cache_read_tokens,
                   count_todo_write, count_read, count_write, count_bash,
                   count_edit, count_glob, count_grep, count_agent
            FROM model_runs WHERE task_id IN (${taskPlaceholders}) AND model_id IN (${modelPlaceholders})
        `).all(...taskIds, ...modelIds);

        // Fetch requirement_type for each task
        const clsStmtReport = db.prepare(
            'SELECT requirement_type FROM ai_task_classifications WHERE task_id = ? AND status = ?'
        );

        const rawTaskData = {};
        for (const t of tasks) {
            const cls = clsStmtReport.get(t.task_id, 'completed');
            rawTaskData[t.task_id] = {
                sourceType: t.source_type || 'prompt',
                requirementType: cls ? cls.requirement_type : null,
                models: {}
            };
        }
        for (const run of allRunsRaw) {
            if (!rawTaskData[run.task_id]) continue;
            rawTaskData[run.task_id].models[run.model_id] = {
                duration: run.duration || 0,
                turns: run.turns || 0,
                inputTokens: run.input_tokens || 0,
                outputTokens: run.output_tokens || 0,
                cacheReadTokens: run.cache_read_tokens || 0,
                countTodoWrite: run.count_todo_write || 0,
                countRead: run.count_read || 0,
                countWrite: run.count_write || 0,
                countBash: run.count_bash || 0,
                countEdit: run.count_edit || 0,
                countGlob: run.count_glob || 0,
                countGrep: run.count_grep || 0,
                countAgent: run.count_agent || 0,
            };
        }

        // Add raw scores for frontend filtering (trace_and_score only)
        if (reportType === 'trace_and_score') {
            const allScoreRaw = db.prepare(`
                SELECT fr.task_id, fr.model_id, fr.question_id, fr.score, fq.scoring_type
                FROM feedback_responses fr
                JOIN feedback_questions fq ON fq.id = fr.question_id
                WHERE fr.task_id IN (${taskPlaceholders}) AND fr.model_id IN (${modelPlaceholders})
                  AND fr.score IS NOT NULL AND fr.score > 0
            `).all(...taskIds, ...modelIds);

            for (const tid of taskIds) {
                if (rawTaskData[tid]) rawTaskData[tid].scores = {};
            }
            for (const r of allScoreRaw) {
                if (!rawTaskData[r.task_id]) continue;
                if (!rawTaskData[r.task_id].scores[r.model_id]) rawTaskData[r.task_id].scores[r.model_id] = {};
                rawTaskData[r.task_id].scores[r.model_id][r.question_id] = mapScore(r.score, r.scoring_type);
            }
        }

        const reportData = {
            type: reportType,
            models: models.map(m => ({ ...m, stats: modelStats[m.id] })),
            tasks: tasks.map(t => ({ task_id: t.task_id, title: t.title, username: t.username, sourceType: t.source_type || 'prompt' })),
            scoreStats,
            scoreQuestionMeta,
            questionWeights: questionWeights || null,
            userVoices,
            rawTaskData,
        };

        let reportId;
        do {
            reportId = generateReportId();
        } while (db.prepare('SELECT 1 FROM reports WHERE id = ?').get(reportId));

        const reportTitle = title || `${reportType === 'trace_only' ? '轨迹分析' : '轨迹与评分分析'}报告 - ${new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;

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
        res.status(500).json({ error: 'Failed to create report: ' + (e.message || String(e)) });
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
