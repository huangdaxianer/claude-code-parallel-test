/**
 * 用户认证路由
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { requireLogin } = require('../middleware/auth');

// 登录
router.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || typeof username !== 'string') {
        return res.status(400).json({ error: '请输入用户名' });
    }

    if (!password || typeof password !== 'string') {
        return res.status(400).json({ error: '请输入密码' });
    }

    const trimmedUsername = username.trim();

    // 验证用户名格式
    if (!/^[a-zA-Z0-9_]+$/.test(trimmedUsername)) {
        return res.status(400).json({ error: '用户名只能包含字母、数字和下划线' });
    }

    if (trimmedUsername.length < 2 || trimmedUsername.length > 50) {
        return res.status(400).json({ error: '用户名长度需在 2-50 之间' });
    }

    try {
        const user = db.prepare('SELECT id, username, role, group_id, password_hash FROM users WHERE username = ?').get(trimmedUsername);

        if (!user) {
            // 用户不存在，检查是否允许注册
            const appConfig = config.getAppConfig();
            if (appConfig.allowNewRegistration === false) {
                return res.status(403).json({ error: '用户不存在，且当前不允许注册新用户' });
            }
            // 通知前端弹窗确认注册
            return res.json({ needRegister: true });
        }

        // 用户存在，验证密码
        if (!bcrypt.compareSync(password, user.password_hash)) {
            return res.status(401).json({ error: '密码错误' });
        }

        console.log(`[Auth] User logged in: ${trimmedUsername} (ID: ${user.id}, Role: ${user.role})`);
        return res.json({
            success: true,
            user: { id: user.id, username: user.username, role: user.role, group_id: user.group_id }
        });
    } catch (e) {
        console.error('Login error:', e);
        return res.status(500).json({ error: '登录失败' });
    }
});

// 注册新用户
router.post('/register', (req, res) => {
    const { username, password } = req.body;

    if (!username || typeof username !== 'string') {
        return res.status(400).json({ error: '请输入用户名' });
    }
    if (!password || typeof password !== 'string') {
        return res.status(400).json({ error: '请输入密码' });
    }

    const trimmedUsername = username.trim();

    if (!/^[a-zA-Z0-9_]+$/.test(trimmedUsername)) {
        return res.status(400).json({ error: '用户名只能包含字母、数字和下划线' });
    }
    if (trimmedUsername.length < 2 || trimmedUsername.length > 50) {
        return res.status(400).json({ error: '用户名长度需在 2-50 之间' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: '密码长度不能少于 6 位' });
    }

    // 检查是否允许注册
    const appConfig = config.getAppConfig();
    if (appConfig.allowNewRegistration === false) {
        return res.status(403).json({ error: '当前不允许注册新用户' });
    }

    try {
        // 检查用户是否已存在
        const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(trimmedUsername);
        if (existing) {
            return res.status(400).json({ error: '用户名已存在' });
        }

        const passwordHash = bcrypt.hashSync(password, 10);
        const defaultGroup = db.prepare("SELECT id FROM user_groups WHERE is_default = 1").get();
        const groupId = defaultGroup ? defaultGroup.id : null;

        const result = db.prepare(
            "INSERT INTO users (username, role, group_id, password_hash) VALUES (?, 'external', ?, ?)"
        ).run(trimmedUsername, groupId, passwordHash);

        const user = db.prepare('SELECT id, username, role, group_id FROM users WHERE id = ?').get(result.lastInsertRowid);
        console.log(`[Auth] New user registered: ${trimmedUsername} (ID: ${user.id})`);

        return res.json({ success: true, user });
    } catch (e) {
        console.error('Register error:', e);
        return res.status(500).json({ error: '注册失败' });
    }
});

// 修改密码（需要登录）
router.post('/change-password', requireLogin, (req, res) => {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
        return res.status(400).json({ error: '请输入旧密码和新密码' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ error: '新密码长度不能少于 6 位' });
    }

    try {
        const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        if (!bcrypt.compareSync(oldPassword, user.password_hash)) {
            return res.status(401).json({ error: '旧密码错误' });
        }

        const newHash = bcrypt.hashSync(newPassword, 10);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);

        console.log(`[Auth] Password changed for user: ${req.user.username} (ID: ${req.user.id})`);
        return res.json({ success: true });
    } catch (e) {
        console.error('Change password error:', e);
        return res.status(500).json({ error: '修改密码失败' });
    }
});

// 获取用户信息
router.get('/user/:userId', (req, res) => {
    const { userId } = req.params;
    try {
        const user = db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        return res.json({ user });
    } catch (e) {
        console.error('Error fetching user:', e);
        return res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// 验证用户是否存在（用于自动登录等场景，不需要登录态）
router.get('/users/verify', (req, res) => {
    try {
        const { username } = req.query;

        if (!username) {
            return res.json({ exists: false, user: null });
        }

        const user = db.prepare('SELECT id, username, role, group_id FROM users WHERE username = ?').get(username);

        res.json({
            exists: !!user,
            user: user || null
        });
    } catch (e) {
        console.error('[API] User verify error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
