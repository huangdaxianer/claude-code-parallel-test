/**
 * 反馈系统路由 (客户端)
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { isTaskOwnerOrAdmin } = require('../middleware/auth');

// 获取活跃的评价问题 (用户端)
router.get('/questions', (req, res) => {
    try {
        const questions = db.prepare(`
            SELECT * FROM feedback_questions 
            WHERE is_active = 1 
            ORDER BY display_order ASC, created_at DESC
        `).all();
        res.json(questions);
    } catch (e) {
        console.error('Error fetching questions for user:', e);
        res.status(500).json({ error: 'Failed to fetch questions' });
    }
});

// 检查反馈是否已存在
router.get('/check', (req, res) => {
    const { taskId, modelId } = req.query;
    if (!taskId || !modelId) return res.status(400).json({ error: 'Missing params' });

    try {
        let feedback;
        if (req.user.role === 'admin') {
            feedback = db.prepare('SELECT * FROM feedback_responses WHERE task_id = ? AND model_id = ?').all(taskId, modelId);
        } else {
            feedback = db.prepare('SELECT * FROM feedback_responses WHERE task_id = ? AND model_id = ? AND user_id = ?').all(taskId, modelId, req.user.id);
        }
        res.json({ exists: feedback.length > 0, feedback: feedback });
    } catch (e) {
        console.error('Error checking feedback:', e);
        res.status(500).json({ error: 'Check failed' });
    }
});

// 提交反馈
router.post('/submit', (req, res) => {
    const { taskId, modelId, responses } = req.body;

    if (!taskId || !modelId || !Array.isArray(responses) || responses.length === 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    // 校验任务归属
    if (!isTaskOwnerOrAdmin(req, res, taskId)) return;

    try {
        const insertStmt = db.prepare(`
            INSERT OR REPLACE INTO feedback_responses (task_id, model_id, question_id, score, comment, user_id)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        let allRequiredMet = false;

        db.transaction(() => {
            for (const r of responses) {
                insertStmt.run(taskId, modelId, r.questionId, r.score, r.comment || '', req.user.id);
            }

            const requiredQuestions = db.prepare('SELECT id, has_comment FROM feedback_questions WHERE is_active = 1 AND is_required = 1').all();
            const currentResponses = db.prepare('SELECT question_id, score, comment FROM feedback_responses WHERE task_id = ? AND model_id = ?').all(taskId, modelId);

            const responseMap = {};
            currentResponses.forEach(r => { responseMap[r.question_id] = { score: r.score, comment: r.comment }; });

            allRequiredMet = requiredQuestions.every(q => {
                const resp = responseMap[q.id];
                if (!resp || resp.score === undefined || resp.score <= 0) return false;
                if (q.has_comment && (!resp.comment || resp.comment.trim() === '')) return false;
                return true;
            });

            const newStatus = allRequiredMet ? 'evaluated' : 'completed';

            db.prepare(`
                UPDATE model_runs SET status = ? 
                WHERE task_id = ? AND model_id = ?
            `).run(newStatus, taskId, modelId);
        })();

        console.log(`[Feedback] Submitted for ${taskId}/${modelId}. Status set to: ${allRequiredMet ? 'evaluated' : 'completed'}`);
        res.json({ success: true, status: allRequiredMet ? 'evaluated' : 'completed' });
    } catch (e) {
        console.error('Error submitting feedback:', e);
        res.status(500).json({ error: 'Failed to submit feedback' });
    }
});

// 删除单个反馈回答（取消选择）
router.delete('/response', (req, res) => {
    const { taskId, modelId, questionId } = req.body;

    if (!taskId || !modelId || !questionId) {
        return res.status(400).json({ error: 'Missing params' });
    }

    if (!isTaskOwnerOrAdmin(req, res, taskId)) return;

    try {
        db.transaction(() => {
            db.prepare(
                'DELETE FROM feedback_responses WHERE task_id = ? AND model_id = ? AND question_id = ? AND user_id = ?'
            ).run(taskId, modelId, questionId, req.user.id);

            // 重新检查必填题是否全部完成
            const requiredQuestions = db.prepare('SELECT id, has_comment FROM feedback_questions WHERE is_active = 1 AND is_required = 1').all();
            const currentResponses = db.prepare('SELECT question_id, score, comment FROM feedback_responses WHERE task_id = ? AND model_id = ?').all(taskId, modelId);

            const responseMap = {};
            currentResponses.forEach(r => { responseMap[r.question_id] = { score: r.score, comment: r.comment }; });

            const allRequiredMet = requiredQuestions.every(q => {
                const resp = responseMap[q.id];
                if (!resp || resp.score === undefined || resp.score <= 0) return false;
                if (q.has_comment && (!resp.comment || resp.comment.trim() === '')) return false;
                return true;
            });

            const newStatus = allRequiredMet ? 'evaluated' : 'completed';
            db.prepare('UPDATE model_runs SET status = ? WHERE task_id = ? AND model_id = ?').run(newStatus, taskId, modelId);
        })();

        console.log(`[Feedback] Deleted response for ${taskId}/${modelId}/q${questionId}`);
        res.json({ success: true });
    } catch (e) {
        console.error('Error deleting feedback response:', e);
        res.status(500).json({ error: 'Failed to delete feedback response' });
    }
});

module.exports = router;
