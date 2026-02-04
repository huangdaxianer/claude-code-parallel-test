/**
 * 用户认证路由
 */
const express = require('express');
const router = express.Router();
const db = require('../db');

// 登录 / 注册用户
router.post('/login', (req, res) => {
    const { username } = req.body;

    if (!username || typeof username !== 'string') {
        return res.status(400).json({ error: 'Username is required' });
    }

    const trimmedUsername = username.trim();

    // 验证用户名格式
    if (!/^[a-zA-Z0-9_]+$/.test(trimmedUsername)) {
        return res.status(400).json({ error: 'Username can only contain letters, numbers and underscores' });
    }

    if (trimmedUsername.length < 2 || trimmedUsername.length > 50) {
        return res.status(400).json({ error: 'Username must be between 2 and 50 characters' });
    }

    try {
        let user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(trimmedUsername);

        if (!user) {
            const result = db.prepare('INSERT INTO users (username) VALUES (?)').run(trimmedUsername);
            // New users get default role (usually 'internal' or 'external' depending on schema default, let's query it back or assume default)
            // It's safer to query it back to ensure we have the correct role
            user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(result.lastInsertRowid);
            console.log(`[Auth] New user created: ${trimmedUsername} (ID: ${user.id}, Role: ${user.role})`);
        } else {
            // Ensure we fetch role for existing user too. The previous query only fetched id, username.
            user = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(trimmedUsername);
            console.log(`[Auth] User logged in: ${trimmedUsername} (ID: ${user.id}, Role: ${user.role})`);
        }

        return res.json({ success: true, user });
    } catch (e) {
        console.error('Login error:', e);
        return res.status(500).json({ error: 'Login failed' });
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

module.exports = router;
