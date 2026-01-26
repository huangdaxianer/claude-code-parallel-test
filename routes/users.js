/**
 * 用户路由
 * User-related routes
 */
const express = require('express');
const router = express.Router();
const db = require('../db');

/**
 * 验证用户是否存在
 * GET /api/users/verify?username=xxx
 */
router.get('/verify', (req, res) => {
    try {
        const { username } = req.query;

        if (!username) {
            return res.json({ exists: false, user: null });
        }

        const user = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);

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
