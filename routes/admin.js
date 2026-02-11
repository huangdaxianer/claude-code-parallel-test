/**
 * 管理后台路由
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const config = require('../config');
const { processQueue } = require('../services/queueService');

// 获取任务的管理视图（支持分页和筛选）
router.get('/tasks', (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
        const userId = req.query.userId || '';
        const search = req.query.search || '';

        // Parse per-model status filters: modelFilter_MODELID=status
        const modelFilters = {};
        for (const key of Object.keys(req.query)) {
            if (key.startsWith('modelFilter_') && req.query[key]) {
                const modelId = key.substring('modelFilter_'.length);
                modelFilters[modelId] = req.query[key];
            }
        }

        // Build WHERE clauses
        const conditions = [];
        const params = [];

        if (userId) {
            conditions.push('t.user_id = ?');
            params.push(userId);
        }
        if (search) {
            conditions.push('(t.title LIKE ? OR t.prompt LIKE ? OR t.task_id LIKE ?)');
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern, searchPattern);
        }

        // Per-model status filters: task must have a model_run matching each filter
        for (const [modelId, filterStatus] of Object.entries(modelFilters)) {
            conditions.push(`EXISTS (SELECT 1 FROM model_runs mr_f WHERE mr_f.task_id = t.task_id AND mr_f.model_id = ? AND mr_f.status = ?)`);
            params.push(modelId, filterStatus);
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        // Get total count for pagination
        const countSql = `
            SELECT COUNT(*) as total
            FROM tasks t
            LEFT JOIN users u ON t.user_id = u.id
            LEFT JOIN task_queue q ON t.task_id = q.task_id
            ${whereClause}
        `;
        const { total } = db.prepare(countSql).get(...params);

        // Get paginated tasks
        const offset = (page - 1) * pageSize;
        const tasksSql = `
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
            ${whereClause}
            ORDER BY t.created_at DESC
            LIMIT ? OFFSET ?
        `;
        const tasks = db.prepare(tasksSql).all(...params, pageSize, offset);

        const tasksWithRuns = tasks.map(task => {
            const runs = db.prepare(`
                SELECT mr.model_id, mr.status, mr.duration, mr.input_tokens, mr.output_tokens, mc.endpoint_name
                FROM model_runs mr
                LEFT JOIN model_configs mc ON mc.model_id = mr.model_id
                WHERE mr.task_id = ?
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
                    modelId: r.model_id,
                    modelName: r.endpoint_name || r.model_id,
                    status: r.status,
                    duration: r.duration,
                    inputTokens: r.input_tokens,
                    outputTokens: r.output_tokens
                }))
            };
        });

        // Get stats (across all tasks, unfiltered) for the stats cards
        const stats = db.prepare(`
            SELECT
                COALESCE(SUM(CASE WHEN mr.status != 'not-started' THEN 1 ELSE 0 END), 0) as total,
                COALESCE(SUM(CASE WHEN mr.status IN ('completed', 'evaluated') THEN 1 ELSE 0 END), 0) as completed,
                COALESCE(SUM(CASE WHEN mr.status = 'running' THEN 1 ELSE 0 END), 0) as running,
                COALESCE(SUM(CASE WHEN mr.status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
                COALESCE(SUM(CASE WHEN mr.status = 'stopped' THEN 1 ELSE 0 END), 0) as stopped
            FROM model_runs mr
        `).get();

        return res.json({
            tasks: tasksWithRuns,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
            stats
        });
    } catch (e) {
        console.error('Error fetching admin tasks:', e);
        return res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

// 获取所有用户组
router.get('/user-groups', (req, res) => {
    try {
        const groups = db.prepare('SELECT * FROM user_groups ORDER BY is_default DESC, created_at ASC').all();
        return res.json(groups);
    } catch (e) {
        console.error('Error fetching user groups:', e);
        return res.status(500).json({ error: 'Failed to fetch user groups' });
    }
});

// 创建新用户组
router.post('/user-groups', (req, res) => {
    try {
        const { name } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: '用户组名称不能为空' });
        }

        const result = db.prepare('INSERT INTO user_groups (name, is_default) VALUES (?, 0)').run(name.trim());
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
        console.error('Error creating user group:', e);
        if (e.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: '用户组名称已存在' });
        }
        return res.status(500).json({ error: 'Failed to create user group' });
    }
});

// 更新用户组名称
router.put('/user-groups/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { name } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: '用户组名称不能为空' });
        }

        const result = db.prepare('UPDATE user_groups SET name = ? WHERE id = ?').run(name.trim(), id);

        if (result.changes > 0) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'User group not found' });
        }
    } catch (e) {
        console.error('Error updating user group:', e);
        if (e.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: '用户组名称已存在' });
        }
        return res.status(500).json({ error: 'Failed to update user group' });
    }
});

// 删除用户组
router.delete('/user-groups/:id', (req, res) => {
    try {
        const { id } = req.params;

        // 检查是否是默认用户组
        const group = db.prepare('SELECT is_default FROM user_groups WHERE id = ?').get(id);
        if (!group) {
            return res.status(404).json({ error: 'User group not found' });
        }

        if (group.is_default) {
            return res.status(400).json({ error: '默认用户组不可删除' });
        }

        // 获取默认用户组ID，将用户迁移到默认组
        const defaultGroup = db.prepare('SELECT id FROM user_groups WHERE is_default = 1').get();
        if (defaultGroup) {
            db.prepare('UPDATE users SET group_id = ? WHERE group_id = ?').run(defaultGroup.id, id);
        }

        const result = db.prepare('DELETE FROM user_groups WHERE id = ?').run(id);
        res.json({ success: true });
    } catch (e) {
        console.error('Error deleting user group:', e);
        return res.status(500).json({ error: 'Failed to delete user group' });
    }
});

// 获取所有用户列表（包含用户组信息）
router.get('/users', (req, res) => {
    try {
        const users = db.prepare(`
            SELECT u.id, u.username, u.role, u.group_id, u.created_at,
                   g.name as group_name, g.is_default as group_is_default
            FROM users u
            LEFT JOIN user_groups g ON u.group_id = g.id
            ORDER BY u.created_at DESC
        `).all();
        return res.json(users);
    } catch (e) {
        console.error('Error fetching users:', e);
        return res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// 批量创建用户 (Admin)
router.post('/users', (req, res) => {
    try {
        const { usernames } = req.body;

        if (!usernames || typeof usernames !== 'string' || !usernames.trim()) {
            return res.status(400).json({ error: '用户名不能为空' });
        }

        // Split by semicolon, trim whitespace, filter empties
        const usernameList = usernames
            .split(';')
            .map(u => u.trim())
            .filter(u => u.length > 0);

        if (usernameList.length === 0) {
            return res.status(400).json({ error: '没有有效的用户名' });
        }

        // Validate each username
        const invalidUsernames = [];
        const validUsernames = [];

        for (const username of usernameList) {
            if (!/^[a-zA-Z0-9_]+$/.test(username)) {
                invalidUsernames.push({ username, reason: '只能包含字母、数字和下划线' });
            } else if (username.length < 2 || username.length > 50) {
                invalidUsernames.push({ username, reason: '长度必须在2-50之间' });
            } else {
                validUsernames.push(username);
            }
        }

        // Get default group
        const defaultGroup = db.prepare("SELECT id FROM user_groups WHERE is_default = 1").get();
        const groupId = defaultGroup ? defaultGroup.id : null;

        const created = [];
        const skipped = [];

        const insertStmt = db.prepare(
            "INSERT INTO users (username, role, group_id) VALUES (?, 'external', ?)"
        );

        for (const username of validUsernames) {
            const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
            if (existing) {
                skipped.push(username);
            } else {
                insertStmt.run(username, groupId);
                created.push(username);
                console.log(`[Admin] User created: ${username}`);
            }
        }

        res.json({
            success: true,
            created,
            skipped,
            invalid: invalidUsernames
        });
    } catch (e) {
        console.error('[Admin] Create users error:', e);
        res.status(500).json({ error: '创建用户失败' });
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

// 更新用户分组
router.put('/users/:id/group', (req, res) => {
    try {
        const { id } = req.params;
        const { group_id } = req.body;

        // 验证分组是否存在
        const group = db.prepare('SELECT id FROM user_groups WHERE id = ?').get(group_id);
        if (!group) {
            return res.status(400).json({ error: 'Invalid group' });
        }

        const result = db.prepare('UPDATE users SET group_id = ? WHERE id = ?').run(group_id, id);

        if (result.changes > 0) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (e) {
        console.error('[API] Update user group error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 删除用户
router.delete('/users/:id', (req, res) => {
    try {
        const { id } = req.params;

        const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);

        if (result.changes > 0) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (e) {
        console.error('[API] Delete user error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 获取系统配置
router.get('/config', (req, res) => {
    res.json(config.getAppConfig());
});

// 更新系统配置
router.post('/config', (req, res) => {
    const { maxParallelSubtasks, allowNewRegistration } = req.body;

    if (maxParallelSubtasks !== undefined) {
        const value = parseInt(maxParallelSubtasks, 10);
        if (isNaN(value) || value < 1) {
            return res.status(400).json({ error: 'maxParallelSubtasks must be at least 1' });
        }
        config.updateAppConfig({ maxParallelSubtasks: value });
    }

    if (allowNewRegistration !== undefined) {
        config.updateAppConfig({ allowNewRegistration: !!allowNewRegistration });
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
router.put('/questions/reorder', (req, res) => {
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
                fr.model_id,
                mc.endpoint_name,
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
            LEFT JOIN model_configs mc ON mc.model_id = fr.model_id
            WHERE fq.is_active = 1
            ORDER BY t.created_at DESC, u.username, fr.model_id, fq.id
        `).all();

        const grouped = {};
        feedbackData.forEach(row => {
            const key = `${row.task_id}|${row.username}|${row.model_id}`;
            if (!grouped[key]) {
                grouped[key] = {
                    taskId: row.task_id,
                    title: row.title,
                    username: row.username,
                    modelId: row.model_id,
                    modelName: row.endpoint_name || row.model_id,
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

// 获取所有模型配置 (Admin) - 包含每个用户组的设置
router.get('/models', (req, res) => {
    try {
        const models = db.prepare('SELECT id as internal_id, model_id as id, endpoint_name as name, description, is_default_checked, api_base_url, api_key, model_name, auto_retry_limit, activity_timeout_seconds, task_timeout_seconds, is_preview_model, created_at FROM model_configs ORDER BY created_at DESC').all();
        const groups = db.prepare('SELECT * FROM user_groups ORDER BY is_default DESC, name ASC').all();

        // Get all model group settings
        const allSettings = db.prepare('SELECT * FROM model_group_settings').all();
        const settingsMap = {};
        allSettings.forEach(s => {
            if (!settingsMap[s.model_id]) settingsMap[s.model_id] = {};
            settingsMap[s.model_id][s.group_id] = s;
        });

        // Attach group settings to each model
        const modelsWithGroupSettings = models.map(model => {
            const groupSettings = groups.map(group => {
                const setting = settingsMap[model.internal_id]?.[group.id];
                return {
                    group_id: group.id,
                    group_name: group.name,
                    is_default: group.is_default,
                    is_enabled: setting ? setting.is_enabled : 1,
                    is_default_checked: setting ? setting.is_default_checked : model.is_default_checked,
                    display_name: setting ? setting.display_name : null
                };
            });

            // Remove internal_id from the object to keep the API clean
            const { internal_id, ...modelData } = model;

            // Mask api_key for security
            if (modelData.api_key) {
                const key = modelData.api_key;
                modelData.api_key_masked = key.length > 4 ? '****' + key.slice(-4) : '****';
                delete modelData.api_key;
            }

            return {
                ...modelData,
                group_settings: groupSettings
            };
        });

        res.json(modelsWithGroupSettings);
    } catch (e) {
        console.error('Error fetching model configs:', e);
        res.status(500).json({ error: 'Failed to fetch model configs' });
    }
});

// 获取对当前用户组启用的模型 (Public/User)
router.get('/models/enabled', (req, res) => {
    try {
        const username = req.cookies?.username || req.headers['x-username'];
        console.log('[Models] Fetching enabled models for user:', username);

        if (!username) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const user = db.prepare('SELECT id, group_id FROM users WHERE username = ?').get(username);
        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }

        console.log('[Models] User group_id:', user.group_id);

        // Get models enabled for this user's group
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

// 更新模型的用户组设置 (Admin)
router.put('/models/:modelId/group-settings/:groupId', (req, res) => {
    const { modelId, groupId } = req.params;
    const { is_enabled, is_default_checked, display_name } = req.body;

    try {
        // Resolve modelId string to internal integer ID
        const modelConfig = db.prepare('SELECT id FROM model_configs WHERE model_id = ?').get(modelId);
        if (!modelConfig) {
            return res.status(404).json({ error: 'Model not found' });
        }
        const internalModelId = modelConfig.id;

        // Check if setting exists
        const existing = db.prepare('SELECT id FROM model_group_settings WHERE model_id = ? AND group_id = ?').get(internalModelId, groupId);

        if (existing) {
            // Update existing
            const updates = [];
            const params = [];

            if (is_enabled !== undefined) { updates.push('is_enabled = ?'); params.push(is_enabled ? 1 : 0); }
            if (is_default_checked !== undefined) { updates.push('is_default_checked = ?'); params.push(is_default_checked ? 1 : 0); }
            if (display_name !== undefined) { updates.push('display_name = ?'); params.push(display_name || null); }

            if (updates.length > 0) {
                params.push(internalModelId, groupId);
                const sql = `UPDATE model_group_settings SET ${updates.join(', ')} WHERE model_id = ? AND group_id = ?`;
                db.prepare(sql).run(...params);
            }
        } else {
            // Insert new
            db.prepare(`
                INSERT INTO model_group_settings (model_id, group_id, is_enabled, is_default_checked, display_name)
                VALUES (?, ?, ?, ?, ?)
            `).run(
                internalModelId,
                groupId,
                is_enabled !== undefined ? (is_enabled ? 1 : 0) : 1,
                is_default_checked !== undefined ? (is_default_checked ? 1 : 0) : 1,
                display_name || null
            );
        }

        res.json({ success: true });
    } catch (e) {
        console.error('Error updating model group settings:', e);
        res.status(500).json({ error: 'Failed to update model group settings' });
    }
});

// 清理字符串中的零宽字符（复制粘贴时可能带入）
function cleanInvisibleChars(str) {
    if (!str) return str;
    return str.replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, '').trim();
}

// Helper function to generate 5-character model ID
function generateModelId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 5; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// 创建新模型 (Admin)
router.post('/models', (req, res) => {
    const endpoint_name = req.body.endpoint_name?.trim();
    const { description, is_default_checked, api_base_url, api_key, model_name, auto_retry_limit, activity_timeout_seconds, task_timeout_seconds } = req.body;

    if (!endpoint_name) {
        return res.status(400).json({ error: 'Missing required field: endpoint_name' });
    }

    if (!model_name || !model_name.trim()) {
        return res.status(400).json({ error: 'Missing required field: model_name' });
    }

    try {
        // Generate unique model_id
        let modelId;
        do {
            modelId = generateModelId();
        } while (db.prepare("SELECT 1 FROM model_configs WHERE model_id = ?").get(modelId));

        const retryLimit = Math.max(0, parseInt(auto_retry_limit) || 0);
        const activityTimeout = activity_timeout_seconds != null ? Math.max(0, parseInt(activity_timeout_seconds)) : null;
        const taskTimeout = task_timeout_seconds != null ? Math.max(0, parseInt(task_timeout_seconds)) : null;

        const stmt = db.prepare(`
            INSERT INTO model_configs (model_id, endpoint_name, description, is_default_checked, api_base_url, api_key, model_name, auto_retry_limit, activity_timeout_seconds, task_timeout_seconds)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(
            modelId,
            endpoint_name,
            description || '',
            is_default_checked ? 1 : 0,
            cleanInvisibleChars(api_base_url) || null,
            cleanInvisibleChars(api_key) || null,
            cleanInvisibleChars(model_name),
            retryLimit,
            activityTimeout,
            taskTimeout
        );

        res.json({ success: true, id: result.lastInsertRowid, model_id: modelId });
    } catch (e) {
        console.error('Error creating model config:', e);
        if (e.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Endpoint name already exists' });
        }
        res.status(500).json({ error: 'Failed to create model config' });
    }
});

// 更新模型 (Admin)
router.put('/models/:id', (req, res) => {
    const { id } = req.params; // This is the model_id string
    const { endpoint_name, description, is_default_checked, api_base_url, api_key, model_name, auto_retry_limit, activity_timeout_seconds, task_timeout_seconds, is_preview_model } = req.body;

    try {
        // If this model is being set as preview model, clear all others first
        if (is_preview_model) {
            db.prepare('UPDATE model_configs SET is_preview_model = 0').run();
        }

        const updates = [];
        const params = [];

        if (endpoint_name !== undefined) {
            updates.push('endpoint_name = ?');
            params.push(endpoint_name);
        }
        if (description !== undefined) { updates.push('description = ?'); params.push(description); }
        if (is_default_checked !== undefined) { updates.push('is_default_checked = ?'); params.push(is_default_checked ? 1 : 0); }
        if (api_base_url !== undefined) { updates.push('api_base_url = ?'); params.push(cleanInvisibleChars(api_base_url) || null); }
        // Only update api_key if a new value is provided (not the masked placeholder)
        if (api_key !== undefined && api_key !== '' && !api_key.startsWith('****')) {
            updates.push('api_key = ?');
            params.push(cleanInvisibleChars(api_key) || null);
        }
        if (model_name !== undefined) { updates.push('model_name = ?'); params.push(cleanInvisibleChars(model_name) || null); }
        if (auto_retry_limit !== undefined) { updates.push('auto_retry_limit = ?'); params.push(Math.max(0, parseInt(auto_retry_limit) || 0)); }
        if (activity_timeout_seconds !== undefined) {
            updates.push('activity_timeout_seconds = ?');
            params.push(activity_timeout_seconds != null ? Math.max(0, parseInt(activity_timeout_seconds)) : null);
        }
        if (task_timeout_seconds !== undefined) {
            updates.push('task_timeout_seconds = ?');
            params.push(task_timeout_seconds != null ? Math.max(0, parseInt(task_timeout_seconds)) : null);
        }
        if (is_preview_model !== undefined) {
            updates.push('is_preview_model = ?');
            params.push(is_preview_model ? 1 : 0);
        }

        if (updates.length === 0) {
            return res.json({ success: true, message: 'No changes' });
        }

        params.push(id);
        const sql = `UPDATE model_configs SET ${updates.join(', ')} WHERE model_id = ?`;
        const result = db.prepare(sql).run(...params);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Model config not found' });
        }

        res.json({ success: true });
    } catch (e) {
        console.error('Error updating model config:', e);
        if (e.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Endpoint name already exists' });
        }
        res.status(500).json({ error: 'Failed to update model config' });
    }
});

// 删除模型 (Admin)
router.delete('/models/:id', (req, res) => {
    const { id } = req.params; // This is the model_id string
    try {
        const result = db.prepare('DELETE FROM model_configs WHERE model_id = ?').run(id);
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
