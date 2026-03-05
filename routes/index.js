/**
 * 路由汇总
 */
const express = require('express');
const router = express.Router();

const { requireLogin, requireAdmin } = require('../middleware/auth');
const db = require('../db');

const authRoutes = require('./auth');
const adminRoutes = require('./admin');
const feedbackRoutes = require('./feedback');
const tasksRoutes = require('./tasks');
const previewRoutes = require('./preview');
const filesRoutes = require('./files');
const usersRoutes = require('./users');
const reportRoutes = require('./reports');

// 获取对当前用户组启用的模型 (Public/User) — 不需要管理员权限，但需要登录
router.get('/models/enabled', requireLogin, (req, res) => {
    try {
        const user = req.user; // requireLogin 已经验证并注入了 user
        console.log('[Models] Fetching enabled models for user:', user.username, 'group_id:', user.group_id);

        const models = db.prepare(`
            SELECT
                mc.model_id as id,
                mc.model_id,
                mc.endpoint_name as name,
                mc.endpoint_name,
                mc.description,
                COALESCE(mgs.is_enabled, 1) as is_enabled,
                COALESCE(mgs.is_default_checked, mc.is_default_checked) as is_default_checked,
                COALESCE(mgs.display_name, mc.description, mc.endpoint_name) as displayName
            FROM model_configs mc
            LEFT JOIN model_group_settings mgs ON mc.id = mgs.model_id AND mgs.group_id = ?
            WHERE COALESCE(mgs.is_enabled, 1) = 1 AND mc.model_id IS NOT NULL
            ORDER BY mc.endpoint_name ASC
        `).all(user.group_id);

        console.log('[Models] Returning models for group:', models.map(m => ({ id: m.id, name: m.name })));
        res.json(models);
    } catch (e) {
        console.error('Error fetching enabled models:', e);
        res.status(500).json({ error: 'Failed to fetch enabled models' });
    }
});

// 公开报告查看接口（不需要登录）
router.get('/report/:id', (req, res) => {
    try {
        const report = db.prepare(`
            SELECT r.*, u.username as created_by_name
            FROM reports r LEFT JOIN users u ON r.created_by = u.id
            WHERE r.id = ?
        `).get(req.params.id);
        if (!report) return res.status(404).json({ error: 'Report not found' });
        res.json({
            id: report.id,
            title: report.title,
            reportType: report.report_type,
            createdAt: report.created_at,
            createdBy: report.created_by_name,
            data: JSON.parse(report.report_data)
        });
    } catch (e) {
        console.error('[Report] Error fetching report:', e);
        res.status(500).json({ error: 'Failed to fetch report' });
    }
});

// 公开报告 GSB 计算接口（不需要登录）
router.get('/report/:id/gsb', (req, res) => {
    try {
        const { modelA, modelB } = req.query;
        if (!modelA || !modelB || modelA === modelB) {
            return res.status(400).json({ error: 'Need two different model IDs (modelA, modelB)' });
        }

        const report = db.prepare('SELECT selected_tasks, report_data FROM reports WHERE id = ?').get(req.params.id);
        if (!report) return res.status(404).json({ error: 'Report not found' });

        const reportData = JSON.parse(report.report_data);
        if (reportData.type !== 'trace_and_score') {
            return res.status(400).json({ error: 'Report is not trace_and_score type' });
        }

        // Get selected task IDs and question IDs from report
        const taskIds = JSON.parse(report.selected_tasks);
        const questionMeta = reportData.scoreQuestionMeta || {};
        let questionIds = Object.keys(questionMeta).map(Number).filter(n => !isNaN(n));

        // Fallback: extract question IDs from scoreStats if scoreQuestionMeta is empty
        if (questionIds.length === 0 && reportData.scoreStats) {
            const qIdSet = new Set();
            for (const modelId of Object.keys(reportData.scoreStats)) {
                for (const qId of Object.keys(reportData.scoreStats[modelId])) {
                    if (qId === '_avg') continue;
                    const num = Number(qId);
                    if (!isNaN(num)) qIdSet.add(num);
                }
            }
            questionIds = Array.from(qIdSet);
        }

        if (questionIds.length === 0 || taskIds.length === 0) {
            return res.json({ results: {} });
        }

        const taskPlaceholders = taskIds.map(() => '?').join(',');

        // Map score for 3-point scale: 1→1, 2→3, 3→5
        function mapScore(rawScore, scoringType) {
            if (scoringType === 'stars_3') {
                const map = { 1: 1, 2: 3, 3: 5 };
                return map[rawScore] || rawScore;
            }
            return rawScore;
        }

        // Fetch all scores for both models across all tasks and questions
        const scores = db.prepare(`
            SELECT fr.task_id, fr.question_id, fr.model_id, fr.score, fq.scoring_type
            FROM feedback_responses fr
            JOIN feedback_questions fq ON fq.id = fr.question_id
            WHERE fr.task_id IN (${taskPlaceholders})
              AND fr.model_id IN (?, ?)
              AND fr.question_id IN (${questionIds.map(() => '?').join(',')})
              AND fr.score IS NOT NULL AND fr.score > 0
        `).all(...taskIds, modelA, modelB, ...questionIds);

        // Group: taskId → questionId → modelId → mappedScore
        const scoreMap = {};
        for (const s of scores) {
            if (!scoreMap[s.task_id]) scoreMap[s.task_id] = {};
            if (!scoreMap[s.task_id][s.question_id]) scoreMap[s.task_id][s.question_id] = {};
            scoreMap[s.task_id][s.question_id][s.model_id] = mapScore(s.score, s.scoring_type);
        }

        // Compute GSB per question
        const results = {};
        for (const qId of questionIds) {
            let aWins = 0, same = 0, bWins = 0;
            for (const tid of taskIds) {
                const qs = scoreMap[tid]?.[qId];
                if (!qs) continue;
                const scoreA = qs[modelA];
                const scoreB = qs[modelB];
                if (scoreA == null || scoreB == null) continue;
                if (scoreA > scoreB) aWins++;
                else if (scoreA < scoreB) bWins++;
                else same++;
            }
            results[qId] = { aWins, same, bWins, total: aWins + same + bWins };
        }

        // Build question name map for response (from meta or scoreStats)
        const qNameMap = {};
        for (const qId of questionIds) {
            if (questionMeta[qId]) {
                qNameMap[qId] = questionMeta[qId].questionName;
            } else {
                // Try to get from scoreStats
                for (const modelId of Object.keys(reportData.scoreStats || {})) {
                    const qs = reportData.scoreStats[modelId]?.[qId];
                    if (qs?.questionName) { qNameMap[qId] = qs.questionName; break; }
                }
            }
        }

        res.json({ results, questionMeta: qNameMap });
    } catch (e) {
        console.error('[Report] Error computing GSB:', e);
        res.status(500).json({ error: 'Failed to compute GSB' });
    }
});

// 挂载路由
router.use('/', authRoutes);                                    // 登录接口，不需要鉴权
router.use('/admin', requireAdmin, adminRoutes);                // 管理员接口，已有 requireAdmin
router.use('/feedback', requireLogin, feedbackRoutes);          // 反馈接口，需要登录
router.use('/tasks', requireLogin, tasksRoutes);                // 任务接口，需要登录
router.use('/preview', requireLogin, previewRoutes);            // 预览接口，需要登录
router.use('/comments', requireLogin, require('./comments'));   // 评论接口，需要登录
router.use('/', requireLogin, filesRoutes);                     // 文件接口，需要登录
router.use('/users', requireLogin, usersRoutes);                // 用户接口，需要登录
router.use('/gsb', requireLogin, require('./gsb'));              // GSB接口，需要登录
router.use('/tasks', requireLogin, require('./agents'));         // 子Agent状态接口，需要登录

module.exports = router;
