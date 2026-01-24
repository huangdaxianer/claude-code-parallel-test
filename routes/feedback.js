/**
 * 反馈系统路由 (客户端)
 */
const express = require('express');
const router = express.Router();
const db = require('../db');

// 获取活跃的评价问题 (用户端)
router.get('/questions', (req, res) => {
    try {
        const questions = db.prepare(`
            SELECT * FROM feedback_questions 
            WHERE is_active = 1 
            ORDER BY created_at ASC
        `).all();
        res.json(questions);
    } catch (e) {
        console.error('Error fetching questions for user:', e);
        res.status(500).json({ error: 'Failed to fetch questions' });
    }
});

// 检查反馈是否已存在
router.get('/check', (req, res) => {
    const { taskId, modelName } = req.query;
    if (!taskId || !modelName) return res.status(400).json({ error: 'Missing params' });

    try {
        const feedback = db.prepare('SELECT * FROM feedback_responses WHERE task_id = ? AND model_name = ?').all(taskId, modelName);
        res.json({ exists: feedback.length > 0, feedback: feedback });
    } catch (e) {
        console.error('Error checking feedback:', e);
        res.status(500).json({ error: 'Check failed' });
    }
});

// 提交反馈
router.post('/submit', (req, res) => {
    const { taskId, modelName, responses } = req.body;

    if (!taskId || !modelName || !Array.isArray(responses) || responses.length === 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    try {
        const insertStmt = db.prepare(`
            INSERT OR REPLACE INTO feedback_responses (task_id, model_name, question_id, score, comment)
            VALUES (?, ?, ?, ?, ?)
        `);

        let allRequiredMet = false;

        db.transaction(() => {
            for (const r of responses) {
                insertStmt.run(taskId, modelName, r.questionId, r.score, r.comment || '');
            }

            const requiredQuestions = db.prepare('SELECT id FROM feedback_questions WHERE is_active = 1 AND is_required = 1').all();
            const currentResponses = db.prepare('SELECT question_id, score FROM feedback_responses WHERE task_id = ? AND model_name = ?').all(taskId, modelName);

            const responseMap = {};
            currentResponses.forEach(r => { responseMap[r.question_id] = r.score; });

            allRequiredMet = requiredQuestions.every(q => {
                const score = responseMap[q.id];
                return score !== undefined && score > 0;
            });

            const newStatus = allRequiredMet ? 'evaluated' : 'completed';

            db.prepare(`
                UPDATE model_runs SET status = ? 
                WHERE task_id = ? AND model_name = ?
            `).run(newStatus, taskId, modelName);
        })();

        console.log(`[Feedback] Submitted for ${taskId}/${modelName}. Status set to: ${allRequiredMet ? 'evaluated' : 'completed'}`);
        res.json({ success: true, status: allRequiredMet ? 'evaluated' : 'completed' });
    } catch (e) {
        console.error('Error submitting feedback:', e);
        res.status(500).json({ error: 'Failed to submit feedback' });
    }
});

module.exports = router;
