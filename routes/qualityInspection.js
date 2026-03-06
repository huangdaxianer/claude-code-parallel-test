const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/quality-inspection?taskId=X&modelId=Y
router.get('/', (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: '仅管理员可访问' });
    }

    const { taskId, modelId } = req.query;
    if (!taskId || !modelId) {
        return res.status(400).json({ error: '缺少 taskId 或 modelId' });
    }

    try {
        const rows = db.prepare(
            'SELECT question_key, answer, note, admin_username, updated_at FROM quality_inspections WHERE task_id = ? AND model_id = ?'
        ).all(taskId, modelId);

        const result = {};
        rows.forEach(r => {
            result[r.question_key] = {
                answer: r.answer,
                note: r.note,
                admin_username: r.admin_username,
                updated_at: r.updated_at
            };
        });

        res.json({ success: true, data: result });
    } catch (e) {
        console.error('[QualityInspection] GET error:', e);
        res.status(500).json({ error: '查询失败' });
    }
});

// POST /api/quality-inspection
router.post('/', (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: '仅管理员可访问' });
    }

    const { taskId, modelId, questionKey, answer, note } = req.body;
    if (!taskId || !modelId || !questionKey || !answer) {
        return res.status(400).json({ error: '缺少必填字段' });
    }

    const validKeys = ['task_quality', 'feedback_quality'];
    if (!validKeys.includes(questionKey)) {
        return res.status(400).json({ error: '无效的 questionKey' });
    }

    try {
        db.prepare(`
            INSERT INTO quality_inspections (task_id, model_id, question_key, answer, note, admin_username, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(task_id, model_id, question_key)
            DO UPDATE SET answer = excluded.answer, note = excluded.note, admin_username = excluded.admin_username, updated_at = datetime('now')
        `).run(taskId, modelId, questionKey, answer, note || null, req.user.username);

        res.json({ success: true });
    } catch (e) {
        console.error('[QualityInspection] POST error:', e);
        res.status(500).json({ error: '保存失败' });
    }
});

module.exports = router;
