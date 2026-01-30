/**
 * 评论反馈系统路由
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');

// Configure multer for image uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Will be set dynamically in the route handler
        cb(null, config.UPLOAD_DIR);
    },
    filename: function (req, file, cb) {
        // Generate random filename
        const ext = path.extname(file.originalname);
        const randomName = crypto.randomBytes(16).toString('hex') + ext;
        cb(null, randomName);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: function (req, file, cb) {
        // Only allow image files
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const ext = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mime = allowedTypes.test(file.mimetype);
        if (ext && mime) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

// 获取评论列表
router.get('/', (req, res) => {
    const { taskId, modelId } = req.query;
    if (!taskId || !modelId) return res.status(400).json({ error: 'Missing params' });

    try {
        const comments = db.prepare(`
            SELECT c.*, u.username as user_name 
            FROM feedback_comments c
            LEFT JOIN users u ON c.user_id = u.id
            WHERE c.task_id = ? AND c.model_id = ?
            ORDER BY c.created_at DESC
        `).all(taskId, modelId);
        res.json(comments);
    } catch (e) {
        console.error('Error fetching comments:', e);
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});

// 获取用户添加的反馈（不包含选区评论）
router.get('/user-feedback', (req, res) => {
    const { taskId } = req.query;
    if (!taskId) return res.status(400).json({ error: 'Missing taskId' });

    try {
        const feedback = db.prepare(`
            SELECT uf.*, u.username as user_name 
            FROM user_feedback uf
            LEFT JOIN users u ON uf.user_id = u.id
            WHERE uf.task_id = ?
            ORDER BY uf.created_at DESC
        `).all(taskId);
        res.json(feedback);
    } catch (e) {
        console.error('Error fetching user feedback:', e);
        res.status(500).json({ error: 'Failed to fetch user feedback' });
    }
});

// 添加评论
router.post('/', (req, res) => {
    const { taskId, modelId, userId, targetType, targetRef, selectionRange, content, originalContent } = req.body;

    if (!taskId || !modelId || !content || !targetType) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const result = db.prepare(`
            INSERT INTO feedback_comments (
                task_id, model_id, user_id, target_type, target_ref, 
                selection_range, content, original_content
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            taskId, modelId, userId || null, targetType, targetRef || '',
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

// 添加用户反馈（支持图片上传）
router.post('/user-feedback', upload.array('images', 10), (req, res) => {
    const { taskId, modelId, userId, content } = req.body;

    if (!taskId || !content) {
        return res.status(400).json({ error: 'Missing required fields (taskId, content)' });
    }

    try {
        // Create comments directory for the task
        const commentsDir = path.join(config.TASKS_DIR, taskId, 'comments');
        if (!fs.existsSync(commentsDir)) {
            fs.mkdirSync(commentsDir, { recursive: true });
        }

        // Move uploaded images to task comments directory and collect paths
        const imagePaths = [];
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const newPath = path.join(commentsDir, file.filename);
                fs.renameSync(file.path, newPath);
                // Store relative path from task directory
                imagePaths.push(`${taskId}/comments/${file.filename}`);
            }
        }

        // Insert into database
        const result = db.prepare(`
            INSERT INTO user_feedback (
                task_id, model_id, user_id, content, images
            )
            VALUES (?, ?, ?, ?, ?)
        `).run(
            taskId,
            modelId || '',
            userId || null,
            content,
            JSON.stringify(imagePaths)
        );

        res.json({
            success: true,
            id: result.lastInsertRowid,
            images: imagePaths
        });
    } catch (e) {
        console.error('Error adding user feedback:', e);
        res.status(500).json({ error: 'Failed to add user feedback' });
    }
});

// 删除用户反馈
router.delete('/user-feedback/:id', (req, res) => {
    const { id } = req.params;

    try {
        // First get the feedback to delete associated images
        const feedback = db.prepare('SELECT * FROM user_feedback WHERE id = ?').get(id);
        if (!feedback) {
            return res.status(404).json({ error: 'Feedback not found' });
        }

        // Delete associated images
        if (feedback.images) {
            try {
                const images = JSON.parse(feedback.images);
                for (const imgPath of images) {
                    const fullPath = path.join(config.TASKS_DIR, imgPath);
                    if (fs.existsSync(fullPath)) {
                        fs.unlinkSync(fullPath);
                    }
                }
            } catch (e) {
                console.error('Error deleting feedback images:', e);
            }
        }

        // Delete from database
        const result = db.prepare('DELETE FROM user_feedback WHERE id = ?').run(id);
        if (result.changes > 0) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Feedback not found' });
        }
    } catch (e) {
        console.error('Error deleting user feedback:', e);
        res.status(500).json({ error: 'Failed to delete user feedback' });
    }
});

module.exports = router;
