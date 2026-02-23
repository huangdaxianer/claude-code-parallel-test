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

module.exports = router;
