/**
 * GSB 打分 API 路由
 * GSB (Good/Same/Bad) scoring functionality for model comparison
 */
const express = require('express');
const router = express.Router();
const db = require('../db');

/**
 * 获取当前用户的所有 GSB 作业列表
 * GET /api/gsb/jobs?userId=xxx
 */
router.get('/jobs', (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) {
            return res.status(400).json({ error: 'Missing userId' });
        }

        // Get user's group_id for per-group display name resolution
        const user = db.prepare('SELECT group_id FROM users WHERE id = ?').get(userId);
        const groupId = user ? user.group_id : null;

        const jobs = db.prepare(`
            SELECT
                gj.id, gj.name, gj.model_a_id as model_a, gj.model_b_id as model_b, gj.user_id, gj.status,
                gj.total_count, gj.completed_count, gj.created_at, gj.completed_at,
                COALESCE(mgs_a.display_name, mc_a.description, mc_a.endpoint_name, gj.model_a_id) as model_a_display,
                COALESCE(mgs_b.display_name, mc_b.description, mc_b.endpoint_name, gj.model_b_id) as model_b_display
            FROM gsb_jobs gj
            LEFT JOIN model_configs mc_a ON mc_a.model_id = gj.model_a_id
            LEFT JOIN model_group_settings mgs_a ON mc_a.id = mgs_a.model_id AND mgs_a.group_id = ?
            LEFT JOIN model_configs mc_b ON mc_b.model_id = gj.model_b_id
            LEFT JOIN model_group_settings mgs_b ON mc_b.id = mgs_b.model_id AND mgs_b.group_id = ?
            WHERE gj.user_id = ?
            ORDER BY gj.created_at DESC
        `).all(groupId, groupId, userId);

        res.json(jobs);
    } catch (e) {
        console.error('[GSB] Error fetching jobs:', e);
        res.status(500).json({ error: 'Failed to fetch jobs' });
    }
});

/**
 * 创建新的 GSB 作业
 * POST /api/gsb/jobs
 * Body: { name, modelA, modelB, userId, taskIds: [taskId1, taskId2, ...] }
 */
router.post('/jobs', (req, res) => {
    try {
        const { name, modelA, modelB, userId, taskIds } = req.body;

        if (!name || !modelA || !modelB || !userId || !Array.isArray(taskIds) || taskIds.length === 0) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Create job
        const insertJob = db.prepare(`
            INSERT INTO gsb_jobs (name, model_a_id, model_b_id, user_id, total_count)
            VALUES (?, ?, ?, ?, ?)
        `);
        const jobResult = insertJob.run(name, modelA, modelB, userId, taskIds.length);
        const jobId = jobResult.lastInsertRowid;

        // Create tasks
        const insertTask = db.prepare(`
            INSERT INTO gsb_tasks (job_id, task_id, display_order)
            VALUES (?, ?, ?)
        `);

        taskIds.forEach((taskId, index) => {
            insertTask.run(jobId, taskId, index);
        });

        // Create empty results record
        db.prepare(`
            INSERT INTO gsb_results (job_id) VALUES (?)
        `).run(jobId);

        res.json({ success: true, jobId });
    } catch (e) {
        console.error('[GSB] Error creating job:', e);
        res.status(500).json({ error: 'Failed to create job' });
    }
});

/**
 * 获取指定作业详情（包含任务列表和原任务信息）
 * GET /api/gsb/jobs/:id
 */
router.get('/jobs/:id', (req, res) => {
    try {
        const { id } = req.params;

        const job = db.prepare(`
            SELECT
                id, name, model_a_id as model_a, model_b_id as model_b, user_id, status,
                total_count, completed_count, created_at, completed_at
            FROM gsb_jobs
            WHERE id = ?
        `).get(id);

        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        // Get user's group_id for per-group display name resolution
        const user = db.prepare('SELECT group_id FROM users WHERE id = ?').get(job.user_id);
        const groupId = user ? user.group_id : null;

        // Resolve model display names
        const modelADisplay = db.prepare(`
            SELECT COALESCE(mgs.display_name, mc.description, mc.endpoint_name, mc.model_id) as displayName
            FROM model_configs mc
            LEFT JOIN model_group_settings mgs ON mc.id = mgs.model_id AND mgs.group_id = ?
            WHERE mc.model_id = ?
        `).get(groupId, job.model_a);

        const modelBDisplay = db.prepare(`
            SELECT COALESCE(mgs.display_name, mc.description, mc.endpoint_name, mc.model_id) as displayName
            FROM model_configs mc
            LEFT JOIN model_group_settings mgs ON mc.id = mgs.model_id AND mgs.group_id = ?
            WHERE mc.model_id = ?
        `).get(groupId, job.model_b);

        job.model_a_display = modelADisplay ? modelADisplay.displayName : job.model_a;
        job.model_b_display = modelBDisplay ? modelBDisplay.displayName : job.model_b;

        // Get tasks with original task info
        const tasks = db.prepare(`
            SELECT
                gt.id, gt.task_id, gt.display_order, gt.rating, gt.rated_at,
                t.title, t.prompt
            FROM gsb_tasks gt
            LEFT JOIN tasks t ON gt.task_id = t.task_id
            WHERE gt.job_id = ?
            ORDER BY gt.display_order ASC
        `).all(id);

        // Get results
        const results = db.prepare(`
            SELECT model_a_wins, model_b_wins, same_count, failed_count
            FROM gsb_results
            WHERE job_id = ?
        `).get(id);

        res.json({
            ...job,
            tasks: tasks,
            results: results || { model_a_wins: 0, model_b_wins: 0, same_count: 0, failed_count: 0 }
        });
    } catch (e) {
        console.error('[GSB] Error fetching job details:', e);
        res.status(500).json({ error: 'Failed to fetch job details' });
    }
});

/**
 * 删除作业
 * DELETE /api/gsb/jobs/:id
 */
router.delete('/jobs/:id', (req, res) => {
    try {
        const { id } = req.params;

        const result = db.prepare('DELETE FROM gsb_jobs WHERE id = ?').run(id);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }

        res.json({ success: true });
    } catch (e) {
        console.error('[GSB] Error deleting job:', e);
        res.status(500).json({ error: 'Failed to delete job' });
    }
});

/**
 * 获取下一个待评分的任务
 * GET /api/gsb/jobs/:id/next
 */
router.get('/jobs/:id/next', (req, res) => {
    try {
        const { id } = req.params;

        // Get job info
        const job = db.prepare('SELECT model_a_id as model_a, model_b_id as model_b FROM gsb_jobs WHERE id = ?').get(id);
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        // Get next unrated task
        const nextTask = db.prepare(`
            SELECT 
                gt.id, gt.task_id, gt.display_order,
                t.title, t.prompt
            FROM gsb_tasks gt
            LEFT JOIN tasks t ON gt.task_id = t.task_id
            WHERE gt.job_id = ? AND gt.rating IS NULL
            ORDER BY gt.display_order ASC
            LIMIT 1
        `).get(id);

        if (!nextTask) {
            // All tasks rated
            return res.json({ completed: true, task: null });
        }

        // Get previewable info for both models
        const modelAInfo = db.prepare(`
            SELECT previewable FROM model_runs 
            WHERE task_id = ? AND model_id = ?
        `).get(nextTask.task_id, job.model_a);

        const modelBInfo = db.prepare(`
            SELECT previewable FROM model_runs 
            WHERE task_id = ? AND model_id = ?
        `).get(nextTask.task_id, job.model_b);

        res.json({
            completed: false,
            task: {
                ...nextTask,
                modelA: job.model_a,
                modelB: job.model_b,
                modelAPreviewable: modelAInfo?.previewable,
                modelBPreviewable: modelBInfo?.previewable
            }
        });
    } catch (e) {
        console.error('[GSB] Error fetching next task:', e);
        res.status(500).json({ error: 'Failed to fetch next task' });
    }
});

/**
 * 提交单个任务的评分
 * POST /api/gsb/jobs/:id/rate
 * Body: { taskId, rating: 'left_better' | 'right_better' | 'same' | 'failed' }
 */
router.post('/jobs/:id/rate', (req, res) => {
    try {
        const { id } = req.params;
        const { taskId, rating } = req.body;

        const validRatings = ['left_better', 'right_better', 'same', 'failed'];
        if (!taskId || !validRatings.includes(rating)) {
            return res.status(400).json({ error: 'Invalid rating data' });
        }

        // Update task rating
        const updateTask = db.prepare(`
            UPDATE gsb_tasks 
            SET rating = ?, rated_at = CURRENT_TIMESTAMP
            WHERE job_id = ? AND task_id = ?
        `);
        updateTask.run(rating, id, taskId);

        // Update job completed count
        const completedCount = db.prepare(`
            SELECT COUNT(*) as count FROM gsb_tasks 
            WHERE job_id = ? AND rating IS NOT NULL
        `).get(id).count;

        const totalCount = db.prepare(`
            SELECT total_count FROM gsb_jobs WHERE id = ?
        `).get(id).total_count;

        const isCompleted = completedCount >= totalCount;

        db.prepare(`
            UPDATE gsb_jobs 
            SET completed_count = ?, 
                status = ?,
                completed_at = ?
            WHERE id = ?
        `).run(
            completedCount,
            isCompleted ? 'completed' : 'scoring',
            isCompleted ? new Date().toISOString() : null,
            id
        );

        // Update results
        const updateResultField = {
            'left_better': 'model_a_wins',
            'right_better': 'model_b_wins',
            'same': 'same_count',
            'failed': 'failed_count'
        }[rating];

        db.prepare(`
            UPDATE gsb_results 
            SET ${updateResultField} = ${updateResultField} + 1
            WHERE job_id = ?
        `).run(id);

        res.json({
            success: true,
            completedCount,
            totalCount,
            isCompleted
        });
    } catch (e) {
        console.error('[GSB] Error submitting rating:', e);
        res.status(500).json({ error: 'Failed to submit rating' });
    }
});

/**
 * 获取可用于创建 GSB 作业的任务列表（根据模型筛选）
 * GET /api/gsb/available-tasks?userId=xxx&modelA=xxx&modelB=xxx
 */
router.get('/available-tasks', (req, res) => {
    try {
        const { userId, modelA, modelB } = req.query;

        if (!userId || !modelA || !modelB) {
            return res.status(400).json({ error: 'Missing required params' });
        }

        // Get tasks where both models have previewable results
        const tasks = db.prepare(`
            SELECT DISTINCT
                t.task_id,
                t.title,
                t.prompt,
                t.created_at,
                ma.previewable as model_a_previewable,
                mb.previewable as model_b_previewable
            FROM tasks t
            INNER JOIN model_runs ma ON t.task_id = ma.task_id AND ma.model_id = ?
            INNER JOIN model_runs mb ON t.task_id = mb.task_id AND mb.model_id = ?
            WHERE t.user_id = ?
            ORDER BY t.created_at DESC
        `).all(modelA, modelB, userId);

        // Add previewable status
        const tasksWithStatus = tasks.map(task => ({
            ...task,
            canSelect: (task.model_a_previewable === 'static' || task.model_a_previewable === 'dynamic') &&
                (task.model_b_previewable === 'static' || task.model_b_previewable === 'dynamic')
        }));

        res.json(tasksWithStatus);
    } catch (e) {
        console.error('[GSB] Error fetching available tasks:', e);
        res.status(500).json({ error: 'Failed to fetch available tasks' });
    }
});

/**
 * 获取当前用户已完成任务中的可用模型列表
 * GET /api/gsb/available-models?userId=xxx
 */
router.get('/available-models', (req, res) => {
    try {
        const { userId } = req.query;

        if (!userId) {
            return res.status(400).json({ error: 'Missing userId' });
        }

        // Get user's group_id for per-group display name resolution
        const user = db.prepare('SELECT group_id FROM users WHERE id = ?').get(userId);
        const groupId = user ? user.group_id : null;

        // Get distinct model_ids from completed runs for this user's tasks
        const models = db.prepare(`
            SELECT DISTINCT mr.model_id, mc.endpoint_name,
                COALESCE(mgs.display_name, mc.description, mc.endpoint_name) as displayName
            FROM model_runs mr
            INNER JOIN tasks t ON mr.task_id = t.task_id
            LEFT JOIN model_configs mc ON mc.model_id = mr.model_id
            LEFT JOIN model_group_settings mgs ON mc.id = mgs.model_id AND mgs.group_id = ?
            WHERE t.user_id = ?
              AND mr.status = 'completed'
              AND (mr.previewable = 'static' OR mr.previewable = 'dynamic')
            ORDER BY mc.endpoint_name ASC
        `).all(groupId, userId);

        res.json(models.map(m => ({
            model_id: m.model_id,
            endpoint_name: m.endpoint_name || m.model_id,
            displayName: m.displayName || m.endpoint_name || m.model_id
        })));
    } catch (e) {
        console.error('[GSB] Error fetching available models:', e);
        res.status(500).json({ error: 'Failed to fetch available models' });
    }
});

module.exports = router;
