/**
 * 文件操作路由
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const db = require('../db');
const config = require('../config');

// 获取任务详情
router.get('/task_details/:taskId', (req, res) => {
    const { taskId } = req.params;
    const taskDir = path.join(config.TASKS_DIR, taskId);

    try {
        const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // Join with model_configs to get endpoint_name
        const runs = db.prepare(`
            SELECT mr.*, mc.endpoint_name 
            FROM model_runs mr 
            LEFT JOIN model_configs mc ON mc.model_id = mr.model_id
            WHERE mr.task_id = ?
        `).all(taskId);

        const responseData = {
            taskId: task.task_id,
            title: task.title,
            prompt: task.prompt,
            runs: runs.map(run => {
                // Use model_id for folder path (this is the 5-char ID)
                const folderPath = path.join(taskDir, run.model_id);
                let generatedFiles = [];

                if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
                    const walkSync = (dir, filelist = []) => {
                        fs.readdirSync(dir).forEach(file => {
                            if (file === 'node_modules' || file === '.git' || file === '.DS_Store') return;
                            const filepath = path.join(dir, file);
                            if (fs.statSync(filepath).isDirectory()) {
                                walkSync(filepath, filelist);
                            } else {
                                filelist.push(path.relative(folderPath, filepath));
                            }
                        });
                        return filelist;
                    };
                    generatedFiles = walkSync(folderPath);
                }

                // Check if any files exist (ignoring strict HTML check to support backend-rendered apps)
                const hasFiles = generatedFiles.length > 0;

                return {
                    runId: run.id,
                    folderName: path.join(taskId, run.model_id),
                    modelId: run.model_id,
                    modelName: run.endpoint_name || run.model_id, // Display name for UI
                    endpointName: run.endpoint_name,
                    status: run.status,
                    previewable: run.previewable || ((run.status === 'completed' && hasFiles) ? 'static' : 'unpreviewable'), // Fallback for old tasks, ensure running tasks don't show preview
                    generatedFiles,
                    stats: {
                        duration: run.duration,
                        startedAt: run.started_at || (run.status === 'running' ? run.updated_at : null),
                        turns: run.turns,
                        inputTokens: run.input_tokens,
                        outputTokens: run.output_tokens,
                        cacheReadTokens: run.cache_read_tokens,
                        toolCounts: {
                            TodoWrite: run.count_todo_write,
                            Read: run.count_read,
                            Write: run.count_write,
                            Bash: run.count_bash
                        }
                    }
                };
            })
        };

        res.json(responseData);
    } catch (e) {
        console.error('Error fetching task details:', e);
        res.status(500).json({ error: 'Failed to fetch task details' });
    }
});

// 获取特定模型的完整日志
router.get('/task_logs/:taskId/:modelId', (req, res) => {
    const { taskId, modelId } = req.params;
    const logFilePath = path.join(config.TASKS_DIR, taskId, 'logs', `${modelId}.txt`);

    if (fs.existsSync(logFilePath)) {
        try {
            const content = fs.readFileSync(logFilePath, 'utf-8');
            res.json({ outputLog: content });
        } catch (err) {
            res.status(500).json({ error: 'Failed to read log file' });
        }
    } else {
        res.json({ outputLog: '' });
    }
});

// 获取结构化日志事件
router.get('/task_events/:runId', (req, res) => {
    const { runId } = req.params;
    try {
        const events = db.prepare(`
            SELECT id, type, tool_name, tool_use_id, preview_text, status_class, is_flagged 
            FROM log_entries 
            WHERE run_id = ? AND type NOT LIKE 'HIDDEN_%'
            ORDER BY line_number ASC
        `).all(runId);
        res.json({ events });
    } catch (e) {
        console.error('Error fetching task events:', e);
        res.status(500).json({ error: 'Failed to fetch task events' });
    }
});

// 获取特定日志条目的完整 JSON 内容
router.get('/log_event_content/:eventId', (req, res) => {
    const { eventId } = req.params;
    try {
        const entry = db.prepare('SELECT run_id, tool_use_id, content FROM log_entries WHERE id = ?').get(eventId);
        if (!entry) return res.status(404).json({ error: 'Log entry not found' });

        if (entry.tool_use_id) {
            const entries = db.prepare(`
                SELECT content FROM log_entries 
                WHERE run_id = ? AND tool_use_id = ? 
                ORDER BY line_number ASC
            `).all(entry.run_id, entry.tool_use_id);
            res.json({ contents: entries.map(e => e.content) });
        } else {
            res.json({ contents: [entry.content] });
        }
    } catch (e) {
        console.error('Error fetching event content:', e);
        res.status(500).json({ error: 'Failed to fetch event content' });
    }
});

// 切换日志标记状态
router.post('/log_entries/:id/flag', (req, res) => {
    const { id } = req.params;
    const { isFlagged } = req.body;

    try {
        const stmt = db.prepare('UPDATE log_entries SET is_flagged = ? WHERE id = ?');
        const result = stmt.run(isFlagged ? 1 : 0, id);

        if (result.changes > 0) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Log entry not found' });
        }
    } catch (e) {
        console.error('Error updating log flag:', e);
        res.status(500).json({ error: 'Failed to update flag' });
    }
});

// 读取文件内容
router.get('/file_content', (req, res) => {
    const { folder, file } = req.query;
    if (!folder || !file) return res.status(400).json({ error: 'Missing folder or file' });

    const targetPath = path.join(config.TASKS_DIR, folder, file);

    if (!targetPath.startsWith(config.TASKS_DIR)) {
        return res.status(403).json({ error: 'Access denied' });
    }

    try {
        const content = fs.readFileSync(targetPath, 'utf8');
        res.json({ content });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read file' });
    }
});

// 下载文件夹 ZIP
router.get('/download_zip', (req, res) => {
    const { folderName } = req.query;
    console.log(`[ZIP Request] Request for folder: ${folderName}`);

    if (!folderName) return res.status(400).json({ error: 'Missing folderName' });

    const folderPath = path.join(config.TASKS_DIR, folderName);

    if (!folderPath.startsWith(config.TASKS_DIR)) {
        console.error(`[ZIP Error] Access denied for path: ${folderPath}`);
        return res.status(403).send('Access denied');
    }

    if (!fs.existsSync(folderPath)) {
        console.error(`[ZIP Error] Folder not found: ${folderPath}`);
        return res.status(404).send('Folder not found');
    }

    const downloadName = folderName.replace(/[\/\\]/g, '_') + '.zip';
    const tempZipPath = path.join(config.TASKS_DIR, 'temp_uploads', `${downloadName}_${Date.now()}`);

    const tempDir = path.dirname(tempZipPath);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    console.log(`[ZIP] Writing to temp file: ${tempZipPath}`);

    const output = fs.createWriteStream(tempZipPath);
    const archive = archiver('zip', {
        zlib: { level: 1 }
    });

    output.on('close', function () {
        console.log(`[ZIP] Archive created: ${archive.pointer()} bytes`);

        res.download(tempZipPath, downloadName, (err) => {
            if (err) {
                console.error('[ZIP] Download send error:', err);
                if (!res.headersSent) res.status(500).send({ error: 'Download failed' });
            }

            try {
                if (fs.existsSync(tempZipPath)) {
                    fs.unlinkSync(tempZipPath);
                    console.log(`[ZIP] Temp file deleted: ${tempZipPath}`);
                }
            } catch (e) {
                console.error(`[ZIP] Failed to delete temp file:`, e);
            }
        });
    });

    archive.on('warning', function (err) {
        if (err.code === 'ENOENT') {
            console.warn('[ZIP Warning]', err);
        } else {
            console.error('[ZIP Error from Warning]', err);
        }
    });

    archive.on('error', function (err) {
        console.error('[ZIP Error]', err);
        if (!res.headersSent) res.status(500).send({ error: err.message });
        try { if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath); } catch (e) { }
    });

    archive.pipe(output);

    console.log(`[ZIP] Archiving directory: ${folderPath}`);

    archive.glob('**/*', {
        cwd: folderPath,
        ignore: ['**/.DS_Store'],
        dot: true,
        follow: false
    });

    archive.finalize();
});

module.exports = router;
