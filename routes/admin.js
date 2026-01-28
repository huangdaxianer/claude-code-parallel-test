/**
 * 管理后台路由
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const config = require('../config');
const { processQueue } = require('../services/queueService');

// 获取所有任务的管理视图
router.get('/tasks', (req, res) => {
    try {
        const tasks = db.prepare(`
            SELECT 
                t.task_id,
                t.title,
                t.prompt,
                t.base_dir,
                t.user_id,
                t.created_at,
                u.username,
                q.status as queue_status,
                q.started_at,
                q.completed_at
            FROM tasks t
            LEFT JOIN users u ON t.user_id = u.id
            LEFT JOIN task_queue q ON t.task_id = q.task_id
            ORDER BY t.created_at DESC
        `).all();

        const tasksWithRuns = tasks.map(task => {
            const runs = db.prepare(`
                SELECT model_name, status, duration, input_tokens, output_tokens
                FROM model_runs 
                WHERE task_id = ?
            `).all(task.task_id);

            return {
                taskId: task.task_id,
                title: task.title,
                prompt: task.prompt,
                baseDir: task.base_dir,
                userId: task.user_id,
                username: task.username || 'Unknown',
                createdAt: task.created_at,
                queueStatus: task.queue_status || 'unknown',
                startedAt: task.started_at,
                completedAt: task.completed_at,
                runs: runs.map(r => ({
                    modelName: r.model_name,
                    status: r.status,
                    duration: r.duration,
                    inputTokens: r.input_tokens,
                    outputTokens: r.output_tokens
                }))
            };
        });

        return res.json(tasksWithRuns);
    } catch (e) {
        console.error('Error fetching admin tasks:', e);
        return res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

// 获取所有用户列表
router.get('/users', (req, res) => {
    try {
        const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC').all();
        return res.json(users);
    } catch (e) {
        console.error('Error fetching users:', e);
        return res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// 更新用户角色
router.put('/users/:id/role', (req, res) => {
    try {
        const { id } = req.params;
        const { role } = req.body;

        const validRoles = ['admin', 'internal', 'external'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({ error: 'Invalid role' });
        }

        const result = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);

        if (result.changes > 0) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (e) {
        console.error('[API] Update user role error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 获取系统配置
router.get('/config', (req, res) => {
    res.json(config.getAppConfig());
});

// 更新系统配置
router.post('/config', express.json(), (req, res) => {
    const { maxParallelSubtasks } = req.body;

    if (maxParallelSubtasks !== undefined) {
        const value = parseInt(maxParallelSubtasks, 10);
        if (isNaN(value) || value < 1 || value > 50) {
            return res.status(400).json({ error: 'maxParallelSubtasks must be between 1 and 50' });
        }
        config.updateAppConfig({ maxParallelSubtasks: value });
    }

    config.saveConfig(config.getAppConfig());
    console.log(`[Config] Updated config:`, config.getAppConfig());

    setTimeout(processQueue, 100);

    res.json(config.getAppConfig());
});

// 获取队列状态
router.get('/queue-status', (req, res) => {
    try {
        const runningSubtasks = db.prepare("SELECT COUNT(*) as count FROM model_runs WHERE status = 'running'").get().count;
        const pendingSubtasks = db.prepare("SELECT COUNT(*) as count FROM model_runs WHERE status = 'pending'").get().count;

        res.json({
            maxParallelSubtasks: config.getAppConfig().maxParallelSubtasks,
            runningSubtasks,
            pendingSubtasks
        });
    } catch (e) {
        console.error('Error fetching queue status:', e);
        res.status(500).json({ error: 'Failed to fetch queue status' });
    }
});

// 获取所有评价问题 (Admin)
router.get('/questions', (req, res) => {
    try {
        const questions = db.prepare('SELECT * FROM feedback_questions ORDER BY display_order ASC, created_at DESC').all();
        res.json(questions);
    } catch (e) {
        console.error('Error fetching questions:', e);
        res.status(500).json({ error: 'Failed to fetch questions' });
    }
});

// 创建新问题 (Admin)
router.post('/questions', (req, res) => {
    const { stem, short_name, scoring_type, description, has_comment, is_required, options_json } = req.body;

    if (!stem || !scoring_type) {
        return res.status(400).json({ error: 'Missing required fields (stem, scoring_type)' });
    }

    try {
        const stmt = db.prepare(`
            INSERT INTO feedback_questions (stem, short_name, scoring_type, description, has_comment, is_required, options_json, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        `);
        const result = stmt.run(stem, short_name || '', scoring_type, description || '', has_comment ? 1 : 0, is_required ? 1 : 0, options_json || null);

        res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
        console.error('Error creating question:', e);
        res.status(500).json({ error: 'Failed to create question' });
    }
});

// 重排序问题 (Admin)
router.put('/questions/reorder', express.json(), (req, res) => {
    const { order } = req.body; // Array of IDs in new order

    if (!Array.isArray(order)) {
        return res.status(400).json({ error: 'Invalid order data' });
    }

    try {
        console.log('[Reorder] Received order:', order);
        const updateStmt = db.prepare('UPDATE feedback_questions SET display_order = ? WHERE id = ?');

        const transaction = db.transaction((ids) => {
            let changes = 0;
            ids.forEach((id, index) => {
                const info = updateStmt.run(index, id);
                changes += info.changes;
                console.log(`[Reorder] ID ${id} -> Order ${index}, Changes: ${info.changes}`);
            });
            console.log(`[Reorder] Total changes: ${changes}`);
        });

        transaction(order);
        res.json({ success: true });
    } catch (e) {
        console.error('Error reordering questions:', e);
        res.status(500).json({ error: 'Failed to reorder questions' });
    }
});

// 更新问题 (Admin)
router.put('/questions/:id', (req, res) => {
    const { id } = req.params;
    const { stem, short_name, description, is_required, is_active, options_json } = req.body;

    try {
        const updates = [];
        const params = [];

        if (stem !== undefined) { updates.push('stem = ?'); params.push(stem); }
        if (short_name !== undefined) { updates.push('short_name = ?'); params.push(short_name); }
        if (description !== undefined) { updates.push('description = ?'); params.push(description); }
        if (is_required !== undefined) { updates.push('is_required = ?'); params.push(is_required ? 1 : 0); }
        if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
        if (options_json !== undefined) { updates.push('options_json = ?'); params.push(options_json); }

        if (updates.length === 0) {
            return res.json({ success: true, message: 'No changes' });
        }

        params.push(id);
        const sql = `UPDATE feedback_questions SET ${updates.join(', ')} WHERE id = ?`;
        const result = db.prepare(sql).run(...params);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Question not found' });
        }

        res.json({ success: true });
    } catch (e) {
        console.error('Error updating question:', e);
        res.status(500).json({ error: 'Failed to update question' });
    }
});

// 获取反馈统计 (Admin)
router.get('/feedback-stats', (req, res) => {
    try {
        const feedbackData = db.prepare(`
            SELECT 
                t.task_id,
                t.title,
                u.username,
                fr.model_name,
                fq.id as question_id,
                fq.stem as question_stem,
                fq.short_name as question_short_name,
                fr.score,
                fr.comment,
                fr.created_at
            FROM feedback_responses fr
            JOIN feedback_questions fq ON fr.question_id = fq.id
            JOIN tasks t ON fr.task_id = t.task_id
            JOIN users u ON t.user_id = u.id
            WHERE fq.is_active = 1
            ORDER BY t.created_at DESC, u.username, fr.model_name, fq.id
        `).all();

        const grouped = {};
        feedbackData.forEach(row => {
            const key = `${row.task_id}|${row.username}|${row.model_name}`;
            if (!grouped[key]) {
                grouped[key] = {
                    taskId: row.task_id,
                    title: row.title,
                    username: row.username,
                    modelName: row.model_name,
                    responses: []
                };
            }
            grouped[key].responses.push({
                questionId: row.question_id,
                questionStem: row.question_stem,
                questionShortName: row.question_short_name,
                score: row.score,
                comment: row.comment,
                createdAt: row.created_at
            });
        });

        const result = Object.values(grouped).map(group => {
            const latestTime = group.responses.reduce((latest, r) => {
                return new Date(r.createdAt) > new Date(latest) ? r.createdAt : latest;
            }, group.responses[0]?.createdAt || null);

            return {
                ...group,
                submittedAt: latestTime
            };
        });

        res.json({ success: true, data: result });
    } catch (e) {
        console.error('Error fetching feedback stats:', e);
        res.status(500).json({ error: 'Failed to fetch feedback statistics' });
    }
});

// 获取所有模型配置 (Admin)
router.get('/models', (req, res) => {
    try {
        const models = db.prepare('SELECT * FROM model_configs ORDER BY created_at DESC').all();
        res.json(models);
    } catch (e) {
        console.error('Error fetching model configs:', e);
        res.status(500).json({ error: 'Failed to fetch model configs' });
    }
});

// 获取对当前角色启用的模型 (Public/User)
router.get('/models/enabled', (req, res) => {
    try {
        const username = req.cookies?.username || req.headers['x-username'];
        console.log('[Models] Fetching enabled models for user:', username);
        
        if (!username) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const user = db.prepare('SELECT role FROM users WHERE username = ?').get(username);
        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }

        console.log('[Models] User role:', user.role);

        let roleCol = 'is_enabled_internal';
        if (user.role === 'admin') roleCol = 'is_enabled_admin';
        else if (user.role === 'external') roleCol = 'is_enabled_external';

        const models = db.prepare(`
            SELECT name, description, is_default_checked
            FROM model_configs
            WHERE ${roleCol} = 1
            ORDER BY name ASC
        `).all();

        // For admin users, use description as displayName; for others, use name
        const isAdmin = user.role === 'admin';
        const modelsWithDisplayName = models.map(model => ({
            ...model,
            displayName: isAdmin && model.description ? model.description : model.name
        }));

        console.log('[Models] Returning models with displayNames:', modelsWithDisplayName.map(m => ({ name: m.name, displayName: m.displayName })));
        res.json(modelsWithDisplayName);
    } catch (e) {
        console.error('Error fetching enabled models:', e);
        res.status(500).json({ error: 'Failed to fetch enabled models' });
    }
});

// 创建新模型 (Admin)
router.post('/models', express.json(), (req, res) => {
    const { name, description, is_enabled_internal, is_enabled_external, is_enabled_admin, is_default_checked } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Missing required field: name' });
    }

    try {
        const stmt = db.prepare(`
            INSERT INTO model_configs (name, description, is_enabled_internal, is_enabled_external, is_enabled_admin, is_default_checked)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(
            name,
            description || '',
            is_enabled_internal ? 1 : 0,
            is_enabled_external ? 1 : 0,
            is_enabled_admin ? 1 : 0,
            is_default_checked ? 1 : 0
        );

        res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
        console.error('Error creating model config:', e);
        if (e.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Model name already exists' });
        }
        res.status(500).json({ error: 'Failed to create model config' });
    }
});

// 更新模型 (Admin)
router.put('/models/:id', express.json(), (req, res) => {
    const { id } = req.params;
    const { name, description, is_enabled_internal, is_enabled_external, is_enabled_admin, is_default_checked } = req.body;

    try {
        const updates = [];
        const params = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (description !== undefined) { updates.push('description = ?'); params.push(description); }
        if (is_enabled_internal !== undefined) { updates.push('is_enabled_internal = ?'); params.push(is_enabled_internal ? 1 : 0); }
        if (is_enabled_external !== undefined) { updates.push('is_enabled_external = ?'); params.push(is_enabled_external ? 1 : 0); }
        if (is_enabled_admin !== undefined) { updates.push('is_enabled_admin = ?'); params.push(is_enabled_admin ? 1 : 0); }
        if (is_default_checked !== undefined) { updates.push('is_default_checked = ?'); params.push(is_default_checked ? 1 : 0); }

        if (updates.length === 0) {
            return res.json({ success: true, message: 'No changes' });
        }

        params.push(id);
        const sql = `UPDATE model_configs SET ${updates.join(', ')} WHERE id = ?`;
        const result = db.prepare(sql).run(...params);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Model config not found' });
        }

        res.json({ success: true });
    } catch (e) {
        console.error('Error updating model config:', e);
        if (e.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Model name already exists' });
        }
        res.status(500).json({ error: 'Failed to update model config' });
    }
});

// 删除模型 (Admin)
router.delete('/models/:id', (req, res) => {
    const { id } = req.params;
    try {
        const result = db.prepare('DELETE FROM model_configs WHERE id = ?').run(id);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Model config not found' });
        }
        res.json({ success: true });
    } catch (e) {
        console.error('Error deleting model config:', e);
        res.status(500).json({ error: 'Failed to delete model config' });
    }
});

module.exports = router;
