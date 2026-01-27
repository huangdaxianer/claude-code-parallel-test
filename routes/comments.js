/**
 * 评论反馈系统路由
 */
const express = require('express');
const router = express.Router();
const db = require('../db');

// 获取评论列表
router.get('/', (req, res) => {
    const { taskId, modelName } = req.query;
    if (!taskId || !modelName) return res.status(400).json({ error: 'Missing params' });

    try {
        const comments = db.prepare(`
            SELECT c.*, u.username as user_name 
            FROM feedback_comments c
            LEFT JOIN users u ON c.user_id = u.id
            WHERE c.task_id = ? AND c.model_name = ?
            ORDER BY c.created_at DESC
        `).all(taskId, modelName);
        res.json(comments);
    } catch (e) {
        console.error('Error fetching comments:', e);
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});

// 添加评论
router.post('/', (req, res) => {
    const { taskId, modelName, userId, targetType, targetRef, selectionRange, content, originalContent } = req.body;

    if (!taskId || !modelName || !content || !targetType) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const result = db.prepare(`
            INSERT INTO feedback_comments (
                task_id, model_name, user_id, target_type, target_ref, 
                selection_range, content, original_content
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            taskId, modelName, userId || null, targetType, targetRef || '',
            JSON.stringify(selectionRange || {}), content, originalContent || ''
        );

        res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
        console.error('Error adding comment:', e);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

// 删除评论
router.delete('/:id', (req, res) => {
    const { id } = req.params;

    try {
        const result = db.prepare('DELETE FROM feedback_comments WHERE id = ?').run(id);
        if (result.changes > 0) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Comment not found' });
        }
    } catch (e) {
        console.error('Error deleting comment:', e);
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

module.exports = router;
