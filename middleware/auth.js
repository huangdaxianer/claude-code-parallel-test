/**
 * 认证 & 权限校验中间件
 */
const db = require('../db');

/**
 * 从请求中提取当前用户信息
 */
function getCurrentUser(req) {
    const username = req.cookies?.username || req.headers['x-username'];
    if (!username) return null;
    return db.prepare('SELECT id, username, role, group_id FROM users WHERE username = ?').get(username);
}

/**
 * 要求登录（任意角色均可）
 * 通过后会在 req.user 上挂载用户信息
 */
function requireLogin(req, res, next) {
    const user = getCurrentUser(req);
    if (!user) {
        return res.status(401).json({ error: '未登录' });
    }
    req.user = user;
    next();
}

/**
 * 要求管理员角色
 * 通过后会在 req.user 上挂载用户信息
 */
function requireAdmin(req, res, next) {
    const user = getCurrentUser(req);
    if (!user) {
        return res.status(401).json({ error: '未登录' });
    }
    if (user.role !== 'admin') {
        return res.status(403).json({ error: '无权限，需要管理员角色' });
    }
    req.user = user;
    next();
}

module.exports = { getCurrentUser, requireLogin, requireAdmin };
