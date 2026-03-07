const express = require('express');
const router = express.Router();
const db = require('../db');
const analysisService = require('../services/analysisService');

function generateAnalysisId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// GET /api/admin/analysis/models
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
        console.error('[Analysis] Error fetching models:', e);
        res.status(500).json({ error: 'Failed to fetch models' });
    }
});

// POST /api/admin/analysis/available-tasks
router.post('/available-tasks', (req, res) => {
    try {
        const { modelIds } = req.body;
        if (!Array.isArray(modelIds) || modelIds.length !== 2) {
            return res.status(400).json({ error: '请选择恰好 2 个模型' });
        }

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

            if (runs.length < 2) return false;
            return runs.every(r => r.status === 'completed' || r.status === 'evaluated');
        });

        // Attach AI QC status
        const clsStmt = db.prepare(
            'SELECT requirement_type FROM ai_task_classifications WHERE task_id = ? AND status = ?'
        );
        const traceStmt = db.prepare(`
            SELECT trace_completeness FROM ai_quality_inspections
            WHERE task_id = ? AND model_id IN (${placeholders}) AND status = 'completed'
        `);
        for (const task of qualifiedTasks) {
            const cls = clsStmt.get(task.task_id, 'completed');
            task.requirement_type = cls ? cls.requirement_type : null;

            const traces = traceStmt.all(task.task_id, ...modelIds);
            task.has_incomplete_trace = traces.some(t => t.trace_completeness === '轨迹不完整');
        }

        res.json(qualifiedTasks);
    } catch (e) {
        console.error('[Analysis] Error fetching available tasks:', e);
        res.status(500).json({ error: 'Failed to fetch available tasks' });
    }
});

// POST /api/admin/analysis/create
router.post('/create', (req, res) => {
    try {
        const { modelIds, taskIds, title } = req.body;
        if (!Array.isArray(modelIds) || modelIds.length !== 2) {
            return res.status(400).json({ error: '请选择恰好 2 个模型' });
        }
        if (!Array.isArray(taskIds) || taskIds.length === 0) {
            return res.status(400).json({ error: '请至少选择一个任务' });
        }

        // Generate unique ID
        let analysisId;
        for (let i = 0; i < 10; i++) {
            analysisId = generateAnalysisId();
            const existing = db.prepare('SELECT id FROM ai_analyses WHERE id = ?').get(analysisId);
            if (!existing) break;
        }

        const modelAName = db.prepare('SELECT COALESCE(description, endpoint_name) as name FROM model_configs WHERE model_id = ?').get(modelIds[0]);
        const modelBName = db.prepare('SELECT COALESCE(description, endpoint_name) as name FROM model_configs WHERE model_id = ?').get(modelIds[1]);

        const autoTitle = title || `智能分析 - ${(modelAName?.name || modelIds[0])} vs ${(modelBName?.name || modelIds[1])}`;

        db.transaction(() => {
            db.prepare(`
                INSERT INTO ai_analyses (id, title, model_a_id, model_b_id, selected_tasks, status, total_count, created_by)
                VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)
            `).run(analysisId, autoTitle, modelIds[0], modelIds[1], JSON.stringify(taskIds), taskIds.length, req.user.id);

            const insertResult = db.prepare(
                'INSERT INTO ai_analysis_results (analysis_id, task_id) VALUES (?, ?)'
            );
            for (const taskId of taskIds) {
                insertResult.run(analysisId, taskId);
            }
        })();

        analysisService.enqueueAnalysis(analysisId);

        res.json({ success: true, analysisId });
    } catch (e) {
        console.error('[Analysis] Error creating analysis:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/admin/analysis/list
router.get('/list', (req, res) => {
    try {
        const analyses = db.prepare(`
            SELECT a.id, a.title, a.model_a_id, a.model_b_id, a.status,
                   a.total_count, a.completed_count, a.failed_count,
                   a.created_at, u.username as created_by,
                   COALESCE(ma.description, ma.endpoint_name) as model_a_name,
                   COALESCE(mb.description, mb.endpoint_name) as model_b_name
            FROM ai_analyses a
            LEFT JOIN users u ON a.created_by = u.id
            LEFT JOIN model_configs ma ON ma.model_id = a.model_a_id
            LEFT JOIN model_configs mb ON mb.model_id = a.model_b_id
            ORDER BY a.created_at DESC
        `).all();
        res.json(analyses);
    } catch (e) {
        console.error('[Analysis] Error fetching list:', e);
        res.status(500).json({ error: 'Failed to fetch analyses' });
    }
});

// GET /api/admin/analysis/:id
router.get('/:id', (req, res) => {
    try {
        const analysis = db.prepare(`
            SELECT a.id, a.title, a.model_a_id, a.model_b_id, a.status,
                   a.total_count, a.completed_count, a.failed_count, a.created_at,
                   COALESCE(ma.description, ma.endpoint_name) as model_a_name,
                   COALESCE(mb.description, mb.endpoint_name) as model_b_name
            FROM ai_analyses a
            LEFT JOIN model_configs ma ON ma.model_id = a.model_a_id
            LEFT JOIN model_configs mb ON mb.model_id = a.model_b_id
            WHERE a.id = ?
        `).get(req.params.id);

        if (!analysis) {
            return res.status(404).json({ error: '分析不存在' });
        }

        const results = db.prepare(`
            SELECT ar.task_id, ar.insight, ar.status, ar.error_message,
                   t.title as task_title, u.username
            FROM ai_analysis_results ar
            LEFT JOIN tasks t ON ar.task_id = t.task_id
            LEFT JOIN users u ON t.user_id = u.id
            WHERE ar.analysis_id = ?
            ORDER BY ar.id ASC
        `).all(req.params.id);

        res.json({ ...analysis, results });
    } catch (e) {
        console.error('[Analysis] Error fetching detail:', e);
        res.status(500).json({ error: 'Failed to fetch analysis' });
    }
});

// GET /api/admin/analysis/:id/progress
router.get('/:id/progress', (req, res) => {
    try {
        const analysis = db.prepare(
            'SELECT status, total_count, completed_count, failed_count FROM ai_analyses WHERE id = ?'
        ).get(req.params.id);

        if (!analysis) {
            return res.status(404).json({ error: '分析不存在' });
        }

        res.json(analysis);
    } catch (e) {
        console.error('[Analysis] Error fetching progress:', e);
        res.status(500).json({ error: 'Failed to fetch progress' });
    }
});

// POST /api/admin/analysis/:id/retry
router.post('/:id/retry', (req, res) => {
    try {
        const analysis = db.prepare('SELECT id FROM ai_analyses WHERE id = ?').get(req.params.id);
        if (!analysis) {
            return res.status(404).json({ error: '分析不存在' });
        }

        const updated = db.prepare(`
            UPDATE ai_analysis_results SET status = 'pending', retry_count = 0, error_message = NULL
            WHERE analysis_id = ? AND status = 'failed'
        `).run(req.params.id);

        if (updated.changes > 0) {
            db.prepare("UPDATE ai_analyses SET status = 'processing' WHERE id = ?").run(req.params.id);
            analysisService.enqueueAnalysis(req.params.id);
        }

        res.json({ success: true, retried: updated.changes });
    } catch (e) {
        console.error('[Analysis] Error retrying:', e);
        res.status(500).json({ error: 'Failed to retry' });
    }
});

// DELETE /api/admin/analysis/:id
router.delete('/:id', (req, res) => {
    try {
        db.prepare('DELETE FROM ai_analysis_results WHERE analysis_id = ?').run(req.params.id);
        db.prepare('DELETE FROM ai_analyses WHERE id = ?').run(req.params.id);
        res.json({ success: true });
    } catch (e) {
        console.error('[Analysis] Error deleting:', e);
        res.status(500).json({ error: 'Failed to delete analysis' });
    }
});

module.exports = router;
