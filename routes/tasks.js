/**
 * 任务 CRUD 路由
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const { generateTitle } = require('../services/titleService');
const { processQueue, activeSubtaskProcesses, checkAndUpdateTaskStatus } = require('../services/queueService');

// Multer 配置
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, config.UPLOAD_DIR);
    }
});
const upload = multer({
    storage: storage,
    limits: {
        fieldSize: 10 * 1024 * 1024, // Increase field size limit to 10MB for large JSON payloads
        fileSize: 500 * 1024 * 1024, // 500MB per file
        files: 100000 // Maximum 100,000 files
    }
});

// 获取所有任务 (支持用户过滤)
router.get('/', (req, res) => {
    const { userId } = req.query;

    try {
        let tasks;
        if (userId) {
            tasks = db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC').all(userId);
        } else {
            tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
        }

        return res.json(tasks.map(t => ({
            taskId: t.task_id,
            title: t.title,
            prompt: t.prompt,
            baseDir: t.base_dir,
            userId: t.user_id,
            createdAt: t.created_at
        })));
    } catch (e) {
        console.error('Error reading tasks from DB:', e);
        return res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

/**
 * 验证任务是否存在且属于指定用户（管理员可访问所有任务）
 * GET /api/tasks/verify?taskId=xxx&userId=yyy
 */
router.get('/verify', (req, res) => {
    try {
        const { taskId, userId } = req.query;

        if (!taskId || !userId) {
            return res.json({ exists: false, task: null });
        }

        // 检查当前用户是否是管理员
        const username = req.cookies?.username || req.headers['x-username'];
        const currentUser = username ? db.prepare('SELECT role FROM users WHERE username = ?').get(username) : null;
        const isAdmin = currentUser && currentUser.role === 'admin';

        let task;
        if (isAdmin) {
            // 管理员可以访问所有任务
            task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
        } else {
            task = db.prepare('SELECT * FROM tasks WHERE task_id = ? AND user_id = ?').get(taskId, userId);
        }

        res.json({
            exists: !!task,
            task: task || null
        });
    } catch (e) {
        console.error('[API] Task verify error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 弹出原生文件夹选择器 (仅限 macOS)
router.post('/browse', (req, res) => {
    if (process.platform !== 'darwin') {
        return res.status(400).json({ error: 'Native browsing only supported on macOS' });
    }

    const script = `osascript -e 'POSIX path of (choose folder with prompt "Select Base Project Folder")'`;
    exec(script, (error, stdout, stderr) => {
        if (error) {
            console.error(`Browse error: ${error}`);
            return res.status(500).json({ error: 'User canceled or browsing failed' });
        }
        const selectedPath = stdout.trim();
        res.json({ path: selectedPath });
    });
});

// 上传文件夹接口
router.post('/upload', upload.any(), (req, res) => {
    const folderName = req.body.folderName;
    if (!folderName) {
        console.error('[Upload] Error: Missing folderName in request body');
        return res.status(400).json({ error: '缺少文件夹名称' });
    }

    const uploadId = Date.now();
    const targetBase = path.join(config.UPLOAD_DIR, `${uploadId}_${folderName}`);
    console.log(`[Upload] Starting process for folder: ${folderName} (ID: ${uploadId})`);

    try {
        // Create upload directory if it doesn't exist
        if (!fs.existsSync(config.UPLOAD_DIR)) {
            fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
            console.log(`[Upload] Created upload directory: ${config.UPLOAD_DIR}`);
        }

        if (!fs.existsSync(targetBase)) {
            fs.mkdirSync(targetBase, { recursive: true });
        }

        if (!req.files || req.files.length === 0) {
            console.error('[Upload] Error: No files received from multer');
            return res.status(400).json({ error: '没有接收到文件，请重新选择文件夹' });
        }

        const filesToProcess = req.files.filter(f => f.fieldname === 'files');
        const fileCount = filesToProcess.length;

        let filePaths = req.body.filePaths;

        // Handle JSON string for large file counts
        if (typeof filePaths === 'string') {
            try {
                filePaths = JSON.parse(filePaths);
            } catch (e) {
                // If parse fails, assume it's a single path string (shouldn't happen with new frontend logic but good for safety)
                filePaths = [filePaths];
            }
        }

        filePaths = filePaths || [];
        if (!Array.isArray(filePaths)) {
            filePaths = [filePaths];
        }

        let totalBytes = 0;
        filesToProcess.forEach(f => totalBytes += f.size);
        const sizeInMB = (totalBytes / (1024 * 1024)).toFixed(2);

        console.log(`[Upload] Received ${fileCount} files, total size: ${sizeInMB} MB`);

        let processedCount = 0;
        filesToProcess.forEach((file, index) => {
            try {
                const relPath = filePaths[index] || file.originalname;
                const parentDir = path.dirname(targetBase);
                const fullPath = path.join(parentDir, `${uploadId}_${relPath}`);
                const dir = path.dirname(fullPath);

                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                // Check if source file exists before moving
                if (!fs.existsSync(file.path)) {
                    console.error(`[Upload] Source file missing: ${file.path}`);
                    throw new Error(`源文件不存在: ${file.originalname}`);
                }

                fs.renameSync(file.path, fullPath);
                processedCount++;

                if (index % 100 === 0 || index === fileCount - 1) {
                    console.log(`[Upload] Processing: ${index + 1}/${fileCount} files...`);
                }
            } catch (err) {
                console.error(`[Upload] Error processing file ${index}:`, err);
                // Clean up temp file if it exists
                try {
                    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
                } catch (e) { /* ignore cleanup errors */ }
                throw err;
            }
        });

        console.log(`[Upload] Successfully processed ${processedCount}/${fileCount} files to: ${targetBase}`);
        res.json({ path: targetBase, fileCount: processedCount });
    } catch (err) {
        console.error('[Upload] Fatal server error during processing:', err);

        // Clean up partial upload on error
        try {
            if (fs.existsSync(targetBase)) {
                fs.rmSync(targetBase, { recursive: true, force: true });
                console.log(`[Upload] Cleaned up partial upload: ${targetBase}`);
            }
        } catch (cleanupErr) {
            console.error('[Upload] Failed to clean up:', cleanupErr);
        }

        let errorMsg = '处理上传文件失败';
        if (err.code === 'ENOSPC') {
            errorMsg = '服务器磁盘空间不足';
        } else if (err.code === 'EACCES') {
            errorMsg = '服务器权限不足';
        } else if (err.message) {
            errorMsg = err.message;
        }

        res.status(500).json({ error: errorMsg });
    }
});

// 上传 ZIP 接口
router.post('/upload_zip', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '没有接收到文件' });
    }

    const file = req.file;
    // Remove .zip extension for folder name
    const originalName = file.originalname.replace(/\.zip$/i, '');
    const uploadId = Date.now();

    // We'll extract to UPLOAD_DIR/<timestamp>_<name>
    const targetBase = path.join(config.UPLOAD_DIR, `${uploadId}_${originalName}`);

    console.log(`[Upload ZIP] Starting process for: ${file.originalname} (ID: ${uploadId})`);

    try {
        if (!fs.existsSync(config.UPLOAD_DIR)) {
            fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
        }

        // Create target directory
        if (!fs.existsSync(targetBase)) {
            fs.mkdirSync(targetBase, { recursive: true });
        }

        // Use system unzip
        // -o: overwrite
        // -d: destination
        // -q: quiet
        const unzipCmd = `unzip -o -q "${file.path}" -d "${targetBase}"`;

        exec(unzipCmd, (error, stdout, stderr) => {
            // Always delete the temp zip file
            try {
                fs.unlinkSync(file.path);
            } catch (e) {
                console.warn('[Upload ZIP] Failed to delete temp zip:', e);
            }

            if (error) {
                // unzip exit code 1 = warnings (e.g. stripped absolute paths), files were still extracted
                // Only treat exit code >= 3 as real failures
                const exitCode = error.code;
                if (typeof exitCode === 'number' && exitCode >= 3) {
                    console.error('[Upload ZIP] Unzip error:', error);
                    console.error('[Upload ZIP] Stderr:', stderr);
                    return res.status(500).json({ error: '解压失败: ' + stderr });
                }
                console.warn(`[Upload ZIP] Unzip finished with warnings (exit code ${exitCode}), continuing...`);
            }

            // Count files
            exec(`find "${targetBase}" -type f | wc -l`, (err, countBytes) => {
                const count = parseInt(countBytes ? countBytes.toString().trim() : '0') || 0;
                console.log(`[Upload ZIP] Success. Extracted to ${targetBase}, ${count} files.`);
                res.json({ path: targetBase, fileCount: count });
            });
        });

    } catch (err) {
        console.error('[Upload ZIP] Fatal error:', err);
        // Clean up
        try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (e) { }
        return res.status(500).json({ error: '服务器处理错误: ' + err.message });
    }
});

// 创建任务
router.post('/', (req, res) => {
    const task = req.body.task;
    if (!task || !task.taskId) {
        return res.status(400).json({ error: 'Invalid task format' });
    }

    let finalBaseDir = task.baseDir;
    const taskDir = path.join(config.TASKS_DIR, task.taskId);

    // 处理增量开发
    if (task.srcTaskId) {
        let srcTaskDir = path.join(config.TASKS_DIR, task.srcTaskId);
        let targetPath = path.join(taskDir, 'source');

        if (task.srcModelName) {
            srcTaskDir = path.join(srcTaskDir, task.srcModelName);
            targetPath = path.join(targetPath, task.srcModelName);
        }

        if (fs.existsSync(srcTaskDir)) {
            try {
                if (!fs.existsSync(taskDir)) fs.mkdirSync(taskDir, { recursive: true });
                if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });

                console.log(`[Incremental] Copying files from ${srcTaskDir} to ${targetPath}`);

                const copyFiles = (src, dest) => {
                    const items = fs.readdirSync(src);
                    items.forEach(item => {
                        if (item.endsWith('.txt')) return;
                        if (item === '.agent') return;

                        const srcPath = path.join(src, item);
                        const destPath = path.join(dest, item);

                        try {
                            const stat = fs.statSync(srcPath);
                            if (stat.isDirectory()) {
                                if (!fs.existsSync(destPath)) fs.mkdirSync(destPath);
                                copyFiles(srcPath, destPath);
                            } else {
                                fs.copyFileSync(srcPath, destPath);
                            }
                        } catch (e) { /* ignore missing/locked */ }
                    });
                };

                copyFiles(srcTaskDir, targetPath);
                finalBaseDir = path.relative(__dirname + '/..', targetPath);
                task.baseDir = finalBaseDir;
                console.log(`[Incremental] Setup complete. Base dir: ${finalBaseDir}`);

            } catch (err) {
                console.error('[Incremental] Copy failed:', err);
            }
        }
    }

    // 处理上传的项目文件夹
    if (finalBaseDir && finalBaseDir.includes('temp_uploads')) {
        const sourcePath = finalBaseDir;
        const targetPath = path.join(taskDir, 'source');

        try {
            if (!fs.existsSync(taskDir)) fs.mkdirSync(taskDir, { recursive: true });
            fs.renameSync(sourcePath, targetPath);
            finalBaseDir = path.relative(__dirname + '/..', targetPath);
            task.baseDir = finalBaseDir;
        } catch (err) {
            console.error('Error moving uploaded source:', err);
        }
    }

    // 写入数据库记录
    console.log(`[Task Create] taskId=${task.taskId}, userId=${task.userId}, typeof userId=${typeof task.userId}`);
    console.log(`[Task Create] Models received: ${JSON.stringify(task.models)}`);
    try {
        const insertTask = db.prepare('INSERT INTO tasks (task_id, title, prompt, base_dir, user_id) VALUES (?, ?, ?, ?, ?)');
        insertTask.run(task.taskId, task.title, task.prompt, task.baseDir, task.userId || null);

        const insertRun = db.prepare('INSERT INTO model_runs (task_id, model_id, status) VALUES (?, ?, ?)');
        const models = Array.isArray(task.models) ? task.models : [];
        console.log(`[Task Create] Inserting ${models.length} model runs: ${models.join(', ')}`);
        const insertManyRuns = db.transaction((taskId, modelList) => {
            for (const m of modelList) {
                insertRun.run(taskId, m, 'pending');
            }
        });
        insertManyRuns(task.taskId, models);
    } catch (e) {
        console.error('Error saving task to DB:', e);
        return res.status(500).json({ error: 'Failed to save task' });
    }

    // 加入队列
    try {
        db.prepare("INSERT INTO task_queue (task_id, status) VALUES (?, 'pending')").run(task.taskId);
        console.log(`[ID: ${task.taskId}] Added to execution queue`);
        processQueue();
    } catch (e) {
        console.error('Error adding to task queue:', e);
        return res.status(500).json({ error: 'Failed to queue task' });
    }

    // 异步生成 AI 标题
    generateTitle(task.prompt).then(aiTitle => {
        try {
            const updateTitle = db.prepare('UPDATE tasks SET title = ? WHERE task_id = ?');
            updateTitle.run(aiTitle, task.taskId);
            console.log(`[ID: ${task.taskId}] Title updated to: ${aiTitle}`);
        } catch (e) {
            console.error("Error updating title in DB:", e);
        }
    });

    res.json({ success: true, taskId: task.taskId });
});

// 停止任务
router.post('/:taskId/stop', async (req, res) => {
    const { taskId } = req.params;
    const { modelId } = req.body || {};

    if (modelId) {
        // Use model_id for folder naming
        const folderName = modelId;
        console.log(`[Control] Stopping model ${modelId} for task ${taskId}`);

        const modelDir = path.join(config.TASKS_DIR, taskId, folderName);
        try {
            try {
                execSync(`pkill -9 -f "${modelDir}" 2>/dev/null || true`, { timeout: 5000 });
            } catch (e) { /* ignore */ }

            try {
                const pids = execSync(`ps aux | grep -E "claude.*${taskId}.*${folderName}" | grep -v grep | awk '{print $2}'`, { timeout: 5000 }).toString().trim();
                if (pids) {
                    pids.split('\n').forEach(pid => {
                        if (pid) {
                            try { execSync(`kill -9 ${pid} 2>/dev/null || true`); } catch (e) { /* ignore */ }
                        }
                    });
                }
            } catch (e) { /* ignore */ }

            console.log(`[Control] Kill commands executed for model ${modelId}`);
        } catch (e) {
            console.log(`[Control] pkill for model ${modelId} completed (may have found no processes)`);
        }

        try {
            db.prepare("UPDATE model_runs SET status = 'stopped', stop_reason = 'manual_stop' WHERE task_id = ? AND model_id = ? AND status = 'running'").run(taskId, modelId);

            const subtaskKey = `${taskId}/${modelId}`;
            delete activeSubtaskProcesses[subtaskKey];

            checkAndUpdateTaskStatus(taskId);
        } catch (e) {
            console.error('Error updating DB for model stop:', e);
            return res.status(500).json({ error: 'Failed to update model status' });
        }
    } else {
        console.log(`[Control] Stopping entire task ${taskId}`);

        const taskDir = path.join(config.TASKS_DIR, taskId);
        for (const [key, child] of Object.entries(activeSubtaskProcesses)) {
            if (key.startsWith(`${taskId}/`)) {
                try {
                    const pid = child.pid;
                    console.log(`[Control] Killing subtask process ${key} (PID ${pid})`);
                    try {
                        process.kill(-pid, 'SIGTERM');
                    } catch (e) {
                        try { process.kill(-pid, 'SIGKILL'); } catch (e2) { }
                    }
                } catch (e) {
                    console.error(`[Control] Error killing subtask ${key}:`, e);
                    try { child.kill('SIGKILL'); } catch (e2) { }
                }
                delete activeSubtaskProcesses[key];
            }
        }

        try {
            execSync(`pkill -f "claude.*${taskDir}" 2>/dev/null || true`, { timeout: 5000 });
            console.log(`[Control] Attempted to kill loose processes for ${taskId}`);
        } catch (e) {
            // Ignore errors
        }

        try {
            db.prepare("UPDATE task_queue SET status = 'stopped', completed_at = CURRENT_TIMESTAMP WHERE task_id = ?").run(taskId);
            db.prepare("UPDATE model_runs SET status = 'stopped', stop_reason = 'manual_stop' WHERE task_id = ? AND status IN ('running', 'pending')").run(taskId);
        } catch (e) {
            console.error('Error updating DB for stop:', e);
            return res.status(500).json({ error: 'Failed to update task status' });
        }
    }

    res.json({ success: true });
});

// 启动任务 (重试/恢复)
router.post('/:taskId/start', (req, res) => {
    const { taskId } = req.params;
    const { modelId } = req.body || {};
    console.log(`[Control] Starting task ${taskId}${modelId ? ` for model ${modelId}` : ''}`);

    try {
        if (modelId) {
            console.log(`[Control] Restarting model ${modelId} for task ${taskId}`);

            const modelRun = db.prepare("SELECT id, status FROM model_runs WHERE task_id = ? AND model_id = ?").get(taskId, modelId);
            if (!modelRun) {
                console.log(`[Control] Model ${modelId} not found`);
                return res.status(404).json({ error: `Model ${modelId} not found for task ${taskId}` });
            }

            if (modelRun.status === 'running') {
                console.log(`[Control] Model ${modelId} is still running`);
                return res.status(400).json({ error: `Model ${modelId} is already running` });
            }

            console.log(`[Control] Model ${modelId} found with id ${modelRun.id}, status: ${modelRun.status}`);

            const deleteResult = db.prepare("DELETE FROM log_entries WHERE run_id = ?").run(modelRun.id);
            console.log(`[Control] Deleted ${deleteResult.changes} log entries for model ${modelId}`);

            db.prepare(`
                UPDATE model_runs SET
                    status = 'pending',
                    stop_reason = NULL,
                    retry_count = 0,
                    duration = NULL,
                    started_at = NULL,
                    turns = NULL,
                    input_tokens = NULL,
                    output_tokens = NULL,
                    cache_read_tokens = NULL,
                    count_todo_write = NULL,
                    count_read = NULL,
                    count_write = NULL,
                    count_bash = NULL,
                    previewable = 0,
                    updated_at = CURRENT_TIMESTAMP
                WHERE task_id = ? AND model_id = ?
            `).run(taskId, modelId);
            console.log(`[Control] Reset model run stats for ${modelId}`);

            // Use model_id for folder naming
            const folderName = modelId;
            const modelDir = path.join(config.TASKS_DIR, taskId, folderName);
            console.log(`[Control] Checking model directory: ${modelDir}`);
            if (fs.existsSync(modelDir)) {
                fs.rmSync(modelDir, { recursive: true, force: true });
                console.log(`[Control] Deleted model directory: ${modelDir}`);
            } else {
                console.log(`[Control] Model directory does not exist: ${modelDir}`);
            }

            const logFile = path.join(config.TASKS_DIR, taskId, 'logs', `${folderName}.txt`);
            console.log(`[Control] Checking log file: ${logFile}`);
            if (fs.existsSync(logFile)) {
                fs.unlinkSync(logFile);
                console.log(`[Control] Deleted log file: ${logFile}`);
            } else {
                console.log(`[Control] Log file does not exist: ${logFile}`);
            }
        } else {
            const runningSubtasks = db.prepare("SELECT COUNT(*) as count FROM model_runs WHERE task_id = ? AND status = 'running'").get(taskId);
            if (runningSubtasks.count > 0) {
                return res.status(400).json({ error: 'Some subtasks are still running. Stop them first or restart individual models.' });
            }

            // 获取所有需要重启的 model_runs，清理旧日志和文件
            const runsToRestart = db.prepare("SELECT id, model_id FROM model_runs WHERE task_id = ? AND status != 'completed'").all(taskId);
            for (const run of runsToRestart) {
                // 删除旧日志
                db.prepare("DELETE FROM log_entries WHERE run_id = ?").run(run.id);

                // 删除模型目录
                const modelDir = path.join(config.TASKS_DIR, taskId, run.model_id);
                if (fs.existsSync(modelDir)) {
                    fs.rmSync(modelDir, { recursive: true, force: true });
                }

                // 删除日志文件
                const logFile = path.join(config.TASKS_DIR, taskId, 'logs', `${run.model_id}.txt`);
                if (fs.existsSync(logFile)) {
                    fs.unlinkSync(logFile);
                }
            }

            // 重置所有非完成状态的 model_runs
            db.prepare(`
                UPDATE model_runs SET
                    status = 'pending',
                    stop_reason = NULL,
                    duration = NULL,
                    started_at = NULL,
                    turns = NULL,
                    input_tokens = NULL,
                    output_tokens = NULL,
                    cache_read_tokens = NULL,
                    count_todo_write = NULL,
                    count_read = NULL,
                    count_write = NULL,
                    count_bash = NULL,
                    previewable = NULL,
                    retry_count = 0,
                    updated_at = CURRENT_TIMESTAMP
                WHERE task_id = ? AND status != 'completed'
            `).run(taskId);
        }

        db.prepare("UPDATE task_queue SET status = 'pending', started_at = NULL, completed_at = NULL WHERE task_id = ?").run(taskId);
        processQueue();

        res.json({ success: true });
    } catch (e) {
        console.error('Error starting task:', e);
        res.status(500).json({ error: 'Failed to start task' });
    }
});

// 删除任务
router.delete('/:taskId', (req, res) => {
    const { taskId } = req.params;

    try {
        db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
        db.prepare('DELETE FROM model_runs WHERE task_id = ?').run(taskId);
        db.prepare('DELETE FROM task_queue WHERE task_id = ?').run(taskId);
    } catch (e) {
        console.error('Error deleting task from DB:', e);
        return res.status(500).json({ error: 'Failed to delete task from database' });
    }

    const taskDir = path.join(config.TASKS_DIR, taskId);

    if (fs.existsSync(taskDir)) {
        try {
            fs.rmSync(taskDir, { recursive: true, force: true });
        } catch (e) {
            console.error('Error deleting task directory:', e);
        }
    }

    res.json({ success: true });
});

// 下载任务轨迹 (打包任务目录)
router.get('/:taskId/download', (req, res) => {
    const { taskId } = req.params;
    const taskDir = path.join(config.TASKS_DIR, taskId);
    const archiver = require('archiver');

    if (!fs.existsSync(taskDir)) {
        return res.status(404).json({ error: 'Task directory not found' });
    }

    const tempZipName = `task_${taskId}_${Date.now()}.zip`;
    const tempZipPath = path.join(config.TASKS_DIR, 'temp_uploads', tempZipName);

    const tempDir = path.dirname(tempZipPath);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    console.log(`[Download] Starting zip generation for ${taskId} to ${tempZipPath}`);

    const output = fs.createWriteStream(tempZipPath);
    const archive = archiver('zip', {
        zlib: { level: 1 }
    });

    output.on('close', function () {
        console.log(`[Download] Zip created: ${archive.pointer()} total bytes`);

        res.download(tempZipPath, `task_${taskId}.zip`, (err) => {
            if (err) {
                console.error('[Download] Send error:', err);
                if (!res.headersSent) res.status(500).send({ error: 'Download failed during transmission' });
            }

            try {
                if (fs.existsSync(tempZipPath)) {
                    fs.unlinkSync(tempZipPath);
                    console.log(`[Download] Temp file deleted: ${tempZipPath}`);
                }
            } catch (e) {
                console.error(`[Download] Failed to delete temp file: ${tempZipPath}`, e);
            }
        });
    });

    archive.on('error', (err) => {
        console.error('[Download] Archive error:', err);
        if (!res.headersSent) res.status(500).send({ error: err.message });
        try { if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath); } catch (e) { }
    });

    archive.pipe(output);

    console.log(`[Download] Archiving task directory: ${taskDir}`);

    archive.glob('**/*', {
        cwd: taskDir,
        ignore: ['**/.DS_Store'],
        dot: true,
        follow: false
    });

    archive.finalize();
});

// 批量任务上传
router.post('/batch', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No CSV file uploaded' });
    }

    const tasksCreated = [];
    const crypto = require('crypto');

    try {
        const content = fs.readFileSync(req.file.path, 'utf8');
        const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

        // Get enabled models using model_id
        const baseModels = db.prepare('SELECT model_id FROM model_configs WHERE model_id IS NOT NULL').all().map(m => m.model_id);

        const insertTask = db.prepare('INSERT INTO tasks (task_id, title, prompt, base_dir) VALUES (?, ?, ?, ?)');
        const insertRun = db.prepare('INSERT INTO model_runs (task_id, model_id, status) VALUES (?, ?, ?)');
        const insertQueue = db.prepare("INSERT INTO task_queue (task_id, status) VALUES (?, 'pending')");

        const processBatch = db.transaction((lines) => {
            lines.forEach((prompt, index) => {
                const taskId = crypto.randomBytes(4).toString('hex').toUpperCase();
                const title = `Batch Task ${index + 1}`;

                insertTask.run(taskId, title, prompt, null);
                baseModels.forEach(m => insertRun.run(taskId, m, 'pending'));
                insertQueue.run(taskId);

                tasksCreated.push(taskId);

                generateTitle(prompt).then(aiTitle => {
                    try {
                        db.prepare('UPDATE tasks SET title = ? WHERE task_id = ?').run(aiTitle, taskId);
                    } catch (e) { }
                });
            });
        });

        processBatch(lines);
        processQueue();

        res.json({ success: true, count: lines.length, tasks: tasksCreated });

    } catch (e) {
        console.error('Batch upload error:', e);
        res.status(500).json({ error: 'Failed to process batch file' });
    } finally {
        try { fs.unlinkSync(req.file.path); } catch (e) { }
    }
});

module.exports = router;
