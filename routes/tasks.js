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
const { streamZip } = require('../utils/zipStream');
const { isTaskOwnerOrAdmin } = require('../middleware/auth');

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

// 获取任务列表（普通用户只能看自己的，管理员可看全部）
router.get('/', (req, res) => {
    const { userId, limit } = req.query;
    const queryLimit = Math.min(parseInt(limit) || 50, 200);

    try {
        let tasks;
        if (req.user.role === 'admin') {
            // 管理员：支持 userId 筛选，默认返回全部
            if (userId) {
                tasks = db.prepare('SELECT task_id, title, user_id, source_type, created_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, queryLimit);
            } else {
                tasks = db.prepare('SELECT task_id, title, user_id, source_type, created_at FROM tasks ORDER BY created_at DESC LIMIT ?').all(queryLimit);
            }
        } else {
            // 普通用户：只能看自己的任务
            tasks = db.prepare('SELECT task_id, title, user_id, source_type, created_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(req.user.id, queryLimit);
        }

        return res.json(tasks.map(t => ({
            taskId: t.task_id,
            title: t.title,
            userId: t.user_id,
            sourceType: t.source_type || 'prompt',
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

        let task;
        if (req.user.role === 'admin') {
            // 管理员可以访问所有任务
            task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
        } else {
            // 普通用户只能验证自己的任务
            task = db.prepare('SELECT * FROM tasks WHERE task_id = ? AND user_id = ?').get(taskId, req.user.id);
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

    // 防止目录穿越：folderName 只允许是简单的文件夹名
    const safeFolderName = path.basename(folderName);
    if (safeFolderName !== folderName || folderName.includes('..')) {
        console.error(`[Upload] Blocked path traversal attempt: ${folderName}`);
        return res.status(400).json({ error: '非法文件夹名称' });
    }

    const uploadId = Date.now();
    const targetBase = path.join(config.UPLOAD_DIR, `${uploadId}_${safeFolderName}`);
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

        // Check for PDF files
        const pdfFiles = filesToProcess.filter(f => /\.pdf$/i.test(f.originalname));
        if (pdfFiles.length > 0) {
            console.warn(`[Upload] Rejected: found ${pdfFiles.length} PDF file(s)`);
            // Clean up all temp files
            filesToProcess.forEach(f => {
                try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch (e) { /* ignore */ }
            });
            if (fs.existsSync(targetBase)) {
                try { fs.rmSync(targetBase, { recursive: true, force: true }); } catch (e) { /* ignore */ }
            }
            return res.status(400).json({ error: '暂不支持 PDF 文档，请尝试将 PDF 转换为纯文本重试' });
        }

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
        const resolvedTargetBase = path.resolve(targetBase);
        const folderPrefix = safeFolderName + '/';
        filesToProcess.forEach((file, index) => {
            try {
                let relPath = filePaths[index] || file.originalname;

                // Strip top-level folder name to avoid double nesting
                // webkitRelativePath returns "folderName/sub/file.txt", but targetBase already includes folderName
                if (relPath.startsWith(folderPrefix)) {
                    relPath = relPath.substring(folderPrefix.length);
                }

                // 防止目录穿越：确保文件路径不会跳出目标目录
                const fullPath = path.resolve(targetBase, relPath);
                if (!fullPath.startsWith(resolvedTargetBase + path.sep) && fullPath !== resolvedTargetBase) {
                    throw new Error(`非法文件路径: ${relPath}`);
                }

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
    // Remove .zip extension for folder name, then取 basename 防止路径穿越
    const originalName = path.basename(file.originalname.replace(/\.zip$/i, ''));
    if (originalName.includes('..')) {
        try { fs.unlinkSync(file.path); } catch (e) { }
        return res.status(400).json({ error: '非法文件名' });
    }
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

            // Flatten single top-level directory to avoid double nesting
            // e.g. data.zip containing data/ → uploads/123_data/data/ → flatten to uploads/123_data/
            try {
                const entries = fs.readdirSync(targetBase);
                // Filter out hidden files like __MACOSX
                const realEntries = entries.filter(e => !e.startsWith('__MACOSX') && !e.startsWith('.'));
                if (realEntries.length === 1) {
                    const singleDir = path.join(targetBase, realEntries[0]);
                    if (fs.statSync(singleDir).isDirectory()) {
                        const innerEntries = fs.readdirSync(singleDir);
                        for (const item of innerEntries) {
                            fs.renameSync(path.join(singleDir, item), path.join(targetBase, item));
                        }
                        fs.rmdirSync(singleDir);
                        // Also clean up __MACOSX if present
                        const macosxDir = path.join(targetBase, '__MACOSX');
                        if (fs.existsSync(macosxDir)) {
                            fs.rmSync(macosxDir, { recursive: true, force: true });
                        }
                        console.log(`[Upload ZIP] Flattened single top-level directory: ${realEntries[0]}`);
                    }
                }
            } catch (flattenErr) {
                console.warn('[Upload ZIP] Failed to flatten directory:', flattenErr.message);
            }

            // Check for PDF files before counting
            exec(`find "${targetBase}" -type f -iname "*.pdf" | head -1`, (pdfErr, pdfResult) => {
                if (pdfResult && pdfResult.toString().trim()) {
                    console.warn(`[Upload ZIP] Rejected: found PDF file(s) in archive`);
                    try { fs.rmSync(targetBase, { recursive: true, force: true }); } catch (e) { /* ignore */ }
                    return res.status(400).json({ error: '暂不支持 PDF 文档，请尝试将 PDF 转换为纯文本重试' });
                }

                // Count files
                exec(`find "${targetBase}" -type f | wc -l`, (err, countBytes) => {
                    const count = parseInt(countBytes ? countBytes.toString().trim() : '0') || 0;
                    console.log(`[Upload ZIP] Success. Extracted to ${targetBase}, ${count} files.`);
                    res.json({ path: targetBase, fileCount: count });
                });
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

    // 写入数据库记录 — 强制使用当前登录用户的 ID，不信任前端传来的 userId
    const currentUserId = req.user.id;
    // 仅管理员可启用 Agent Teams
    const enableAgentTeams = (req.user.role === 'admin' && task.enableAgentTeams) ? 1 : 0;
    const sourceType = task.baseDir ? 'upload' : 'prompt';
    console.log(`[Task Create] taskId=${task.taskId}, userId=${currentUserId} (from session), enableAgentTeams=${enableAgentTeams}, sourceType=${sourceType}`);

    let models = Array.isArray(task.models) ? task.models : [];

    // 外部评测人员：自动使用该用户组启用且默认勾选的模型
    if (req.user.role === 'external' && models.length === 0) {
        const defaultModels = db.prepare(`
            SELECT mc.model_id as id
            FROM model_configs mc
            LEFT JOIN model_group_settings mgs ON mc.id = mgs.model_id AND mgs.group_id = ?
            WHERE COALESCE(mgs.is_enabled, 1) = 1
              AND COALESCE(mgs.is_default_checked, mc.is_default_checked) = 1
              AND mc.model_id IS NOT NULL
        `).all(req.user.group_id);
        models = defaultModels.map(m => m.id);
        console.log(`[Task Create] External user: auto-assigned ${models.length} default models: ${models.join(', ')}`);
        if (models.length === 0) {
            return res.status(400).json({ error: '当前用户组没有可用的默认模型，请联系管理员' });
        }
    }

    // 外部评测人员必须提供 prompt
    if (req.user.role === 'external' && (!task.prompt || !task.prompt.trim())) {
        return res.status(400).json({ error: '请输入任务描述' });
    }

    console.log(`[Task Create] Models received: ${JSON.stringify(models)}`);
    try {
        const insertTask = db.prepare('INSERT INTO tasks (task_id, title, prompt, base_dir, user_id, enable_agent_teams, source_type) VALUES (?, ?, ?, ?, ?, ?, ?)');
        insertTask.run(task.taskId, task.title, task.prompt, task.baseDir, currentUserId, enableAgentTeams, sourceType);

        const insertRun = db.prepare('INSERT INTO model_runs (task_id, model_id, status) VALUES (?, ?, ?)');
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
    if (!isTaskOwnerOrAdmin(req, res, taskId)) return;
    const { modelId } = req.body || {};

    if (modelId) {
        // Use model_id for folder naming
        const folderName = modelId;
        console.log(`[Control] Stopping model ${modelId} for task ${taskId}`);

        const subtaskKey = `${taskId}/${modelId}`;
        let killed = false;

        // 优先使用 PID-based kill（从 activeSubtaskProcesses 或 DB 获取 PID）
        const activeEntry = activeSubtaskProcesses[subtaskKey];
        let pid = null;
        if (activeEntry) {
            // 兼容 ChildProcess 对象和 { pid } 对象（重连条目）
            pid = activeEntry.pid || (activeEntry.child && activeEntry.child.pid);
        }
        if (!pid) {
            // 从 DB 查询 PID
            try {
                const dbRun = db.prepare("SELECT pid FROM model_runs WHERE task_id = ? AND model_id = ? AND pid IS NOT NULL").get(taskId, modelId);
                if (dbRun) pid = dbRun.pid;
            } catch (e) { /* ignore */ }
        }

        if (pid) {
            console.log(`[Control] Killing model ${modelId} by PID ${pid}`);
            try {
                process.kill(-pid, 'SIGTERM');
                killed = true;
                // 5 秒后强制 SIGKILL 兜底
                setTimeout(() => {
                    try { process.kill(-pid, 'SIGKILL'); } catch (e) { /* already dead */ }
                }, 5000);
            } catch (e) {
                try { process.kill(pid, 'SIGKILL'); killed = true; } catch (e2) { /* already dead */ }
            }
        }

        // Fallback: pkill 模式匹配（兼容旧进程）
        if (!killed) {
            const modelDir = path.join(config.TASKS_DIR, taskId, folderName);
            try {
                execSync(`pkill -9 -f "${modelDir}" 2>/dev/null || true`, { timeout: 5000 });
            } catch (e) { /* ignore */ }

            try {
                const pids = execSync(`ps aux | grep -E "claude.*${taskId}.*${folderName}" | grep -v grep | awk '{print $2}'`, { timeout: 5000 }).toString().trim();
                if (pids) {
                    pids.split('\n').forEach(p => {
                        if (p) {
                            try { execSync(`kill -9 ${p} 2>/dev/null || true`); } catch (e) { /* ignore */ }
                        }
                    });
                }
            } catch (e) { /* ignore */ }
        }

        console.log(`[Control] Kill commands executed for model ${modelId}`);

        // 停止 FileTailer（如果有 activeProcesses 条目）
        const executorService = require('../services/executorService');
        const procEntry = executorService.activeProcesses.get(subtaskKey);
        if (procEntry) {
            if (procEntry.fileTailer) { try { procEntry.fileTailer.stop(); } catch (e) { /* ignore */ } }
            if (procEntry.stderrTailer) { try { procEntry.stderrTailer.stop(); } catch (e) { /* ignore */ } }
            if (procEntry.logStream) { try { procEntry.logStream.end(); } catch (e) { /* ignore */ } }
            executorService.activeProcesses.delete(subtaskKey);
        }

        try {
            db.prepare("UPDATE model_runs SET status = 'stopped', stop_reason = 'manual_stop', pid = NULL WHERE task_id = ? AND model_id = ? AND status = 'running'").run(taskId, modelId);

            delete activeSubtaskProcesses[subtaskKey];

            checkAndUpdateTaskStatus(taskId);
        } catch (e) {
            console.error('Error updating DB for model stop:', e);
            return res.status(500).json({ error: 'Failed to update model status' });
        }
    } else {
        console.log(`[Control] Stopping entire task ${taskId}`);

        const executorService = require('../services/executorService');
        const taskDir = path.join(config.TASKS_DIR, taskId);
        const killedPids = new Set();

        // 从 activeSubtaskProcesses 获取 PID（兼容 ChildProcess 对象和 { pid } 对象）
        for (const [key, entry] of Object.entries(activeSubtaskProcesses)) {
            if (key.startsWith(`${taskId}/`)) {
                const pid = entry.pid || (entry.child && entry.child.pid);
                if (pid) {
                    console.log(`[Control] Killing subtask process ${key} (PID ${pid})`);
                    try {
                        process.kill(-pid, 'SIGTERM');
                        killedPids.add(pid);
                    } catch (e) {
                        try { process.kill(pid, 'SIGKILL'); killedPids.add(pid); } catch (e2) { }
                    }
                } else if (entry.kill) {
                    try { entry.kill('SIGKILL'); } catch (e2) { }
                }
                // 停止 FileTailer
                const procEntry = executorService.activeProcesses.get(key);
                if (procEntry) {
                    if (procEntry.fileTailer) { try { procEntry.fileTailer.stop(); } catch (e) { /* ignore */ } }
                    if (procEntry.stderrTailer) { try { procEntry.stderrTailer.stop(); } catch (e) { /* ignore */ } }
                    if (procEntry.logStream) { try { procEntry.logStream.end(); } catch (e) { /* ignore */ } }
                    executorService.activeProcesses.delete(key);
                }
                delete activeSubtaskProcesses[key];
            }
        }

        // 从 DB 补杀 activeSubtaskProcesses 中漏掉的进程
        try {
            const dbRuns = db.prepare("SELECT model_id, pid FROM model_runs WHERE task_id = ? AND status = 'running' AND pid IS NOT NULL").all(taskId);
            for (const run of dbRuns) {
                if (!killedPids.has(run.pid)) {
                    console.log(`[Control] Killing DB-tracked process ${taskId}/${run.model_id} (PID ${run.pid})`);
                    try { process.kill(-run.pid, 'SIGTERM'); } catch (e) {
                        try { process.kill(run.pid, 'SIGKILL'); } catch (e2) { /* ignore */ }
                    }
                }
            }
        } catch (e) { /* ignore */ }

        try {
            execSync(`pkill -f "claude.*${taskDir}" 2>/dev/null || true`, { timeout: 5000 });
            console.log(`[Control] Attempted to kill loose processes for ${taskId}`);
        } catch (e) {
            // Ignore errors
        }

        try {
            db.prepare("UPDATE task_queue SET status = 'stopped', completed_at = CURRENT_TIMESTAMP WHERE task_id = ?").run(taskId);
            db.prepare("UPDATE model_runs SET status = 'stopped', stop_reason = 'manual_stop', pid = NULL WHERE task_id = ? AND status IN ('running', 'pending')").run(taskId);
        } catch (e) {
            console.error('Error updating DB for stop:', e);
            return res.status(500).json({ error: 'Failed to update task status' });
        }
    }

    res.json({ success: true });
});

/**
 * 清理 claude-user 主目录下的 Agent Teams 残留数据
 * 包括: .claude/projects/{cwdSlug}/, .claude/teams/{teamName}/, .claude/tasks/{teamName}/
 */
function cleanupAgentTeamsData(taskId, modelId) {
    const CLAUDE_USER_HOME = '/home/claude-user';
    const teamName = `${taskId}-${modelId}`;
    const taskCwd = path.join(config.TASKS_DIR, taskId, modelId);
    const cwdSlug = path.resolve(taskCwd).replace(/\//g, '-');

    // 1. 清理 .claude/projects/{cwdSlug}/ 下的子 agent JSONL 文件
    const projectDir = path.join(CLAUDE_USER_HOME, '.claude/projects', cwdSlug);
    try {
        execSync(`sudo -n rm -rf "${projectDir}" 2>/dev/null`, { timeout: 10000 });
        console.log(`[Control] Cleaned agent projects dir: ${projectDir}`);
    } catch (e) { /* ignore */ }

    // 2. 清理 .claude/teams/{teamName}/ (大小写变体)
    const teamsBase = path.join(CLAUDE_USER_HOME, '.claude/teams');
    try {
        const entries = fs.readdirSync(teamsBase);
        const lowerName = teamName.toLowerCase();
        for (const entry of entries) {
            if (entry.toLowerCase() === lowerName) {
                const dirPath = path.join(teamsBase, entry);
                execSync(`sudo -n rm -rf "${dirPath}" 2>/dev/null`, { timeout: 10000 });
                console.log(`[Control] Cleaned agent teams dir: ${dirPath}`);
            }
        }
    } catch (e) { /* ignore - dir may not exist */ }

    // 3. 清理 .claude/tasks/{teamName}/ (大小写变体)
    const tasksBase = path.join(CLAUDE_USER_HOME, '.claude/tasks');
    try {
        const entries = fs.readdirSync(tasksBase);
        const lowerName = teamName.toLowerCase();
        for (const entry of entries) {
            if (entry.toLowerCase() === lowerName) {
                const dirPath = path.join(tasksBase, entry);
                execSync(`sudo -n rm -rf "${dirPath}" 2>/dev/null`, { timeout: 10000 });
                console.log(`[Control] Cleaned agent tasks dir: ${dirPath}`);
            }
        }
    } catch (e) { /* ignore - dir may not exist */ }
}

// 启动任务 (重试/恢复)
router.post('/:taskId/start', (req, res) => {
    const { taskId } = req.params;
    if (!isTaskOwnerOrAdmin(req, res, taskId)) return;
    const { modelId } = req.body || {};
    console.log(`[Control] Starting task ${taskId}${modelId ? ` for model ${modelId}` : ''}`);

    try {
        if (modelId) {
            console.log(`[Control] Restarting model ${modelId} for task ${taskId}`);

            const modelRun = db.prepare("SELECT id, status FROM model_runs WHERE task_id = ? AND model_id = ?").get(taskId, modelId);
            if (!modelRun) {
                // 新模型：验证用户组权限后创建 model_run
                console.log(`[Control] Model ${modelId} not found for task ${taskId}, attempting to add new model`);

                const enabledModel = db.prepare(`
                    SELECT mc.model_id
                    FROM model_configs mc
                    LEFT JOIN model_group_settings mgs ON mc.id = mgs.model_id AND mgs.group_id = ?
                    WHERE mc.model_id = ? AND COALESCE(mgs.is_enabled, 1) = 1
                `).get(req.user.group_id, modelId);

                if (!enabledModel) {
                    console.log(`[Control] Model ${modelId} not enabled for group ${req.user.group_id}`);
                    return res.status(403).json({ error: `Model ${modelId} is not available for your user group` });
                }

                try {
                    db.prepare('INSERT INTO model_runs (task_id, model_id, status) VALUES (?, ?, ?)').run(taskId, modelId, 'pending');
                    console.log(`[Control] Created new model_run for ${taskId}/${modelId}`);
                } catch (insertErr) {
                    if (insertErr.message && insertErr.message.includes('UNIQUE constraint')) {
                        return res.status(409).json({ error: `Model ${modelId} already exists for task ${taskId}` });
                    }
                    throw insertErr;
                }

                // 确保 task_queue 处于活跃状态
                const queueEntry = db.prepare("SELECT status FROM task_queue WHERE task_id = ?").get(taskId);
                if (queueEntry) {
                    db.prepare("UPDATE task_queue SET status = 'pending', started_at = NULL, completed_at = NULL WHERE task_id = ?").run(taskId);
                } else {
                    db.prepare("INSERT INTO task_queue (task_id, status) VALUES (?, 'pending')").run(taskId);
                }

                processQueue();
                return res.json({ success: true, action: 'added' });
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
                    count_edit = NULL,
                    count_glob = NULL,
                    count_grep = NULL,
                    count_agent = NULL,
                    previewable = NULL,
                    pid = NULL,
                    stdout_file = NULL,
                    stdout_offset = 0,
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

            // 清理 stdout/stderr 文件
            const stdoutFile = path.join(config.TASKS_DIR, taskId, 'logs', `${folderName}.stdout`);
            const stderrFile = path.join(config.TASKS_DIR, taskId, 'logs', `${folderName}.stderr`);
            try { if (fs.existsSync(stdoutFile)) fs.unlinkSync(stdoutFile); } catch (e) { /* ignore */ }
            try { if (fs.existsSync(stderrFile)) fs.unlinkSync(stderrFile); } catch (e) { /* ignore */ }

            // 清理 Agent Teams 残留数据
            cleanupAgentTeamsData(taskId, modelId);
        } else {
            const runningSubtasks = db.prepare("SELECT COUNT(*) as count FROM model_runs WHERE task_id = ? AND status = 'running'").get(taskId);
            if (runningSubtasks.count > 0) {
                return res.status(400).json({ error: 'Some subtasks are still running. Stop them first or restart individual models.' });
            }

            // 获取所有需要重启的 model_runs，清理旧日志和文件
            const runsToRestart = db.prepare("SELECT id, model_id FROM model_runs WHERE task_id = ? AND status NOT IN ('completed', 'evaluated')").all(taskId);
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

                // 清理 stdout/stderr 文件
                const stdoutFile = path.join(config.TASKS_DIR, taskId, 'logs', `${run.model_id}.stdout`);
                const stderrFile = path.join(config.TASKS_DIR, taskId, 'logs', `${run.model_id}.stderr`);
                try { if (fs.existsSync(stdoutFile)) fs.unlinkSync(stdoutFile); } catch (e) { /* ignore */ }
                try { if (fs.existsSync(stderrFile)) fs.unlinkSync(stderrFile); } catch (e) { /* ignore */ }

                // 清理 Agent Teams 残留数据
                cleanupAgentTeamsData(taskId, run.model_id);
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
                    count_edit = NULL,
                    count_glob = NULL,
                    count_grep = NULL,
                    count_agent = NULL,
                    previewable = NULL,
                    retry_count = 0,
                    pid = NULL,
                    stdout_file = NULL,
                    stdout_offset = 0,
                    updated_at = CURRENT_TIMESTAMP
                WHERE task_id = ? AND status NOT IN ('completed', 'evaluated')
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
    if (req.user.group_name === '外部众测用户') {
        return res.status(403).json({ error: '您的用户组没有删除任务的权限' });
    }
    if (!isTaskOwnerOrAdmin(req, res, taskId)) return;

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

// 下载任务轨迹 (流式打包任务目录，避免代理超时)
router.get('/:taskId/download', (req, res) => {
    const { taskId } = req.params;
    if (req.user.group_name === '外部众测用户') {
        return res.status(403).json({ error: '您的用户组没有下载轨迹的权限' });
    }
    if (!isTaskOwnerOrAdmin(req, res, taskId)) return;
    const taskDir = path.join(config.TASKS_DIR, taskId);

    if (!fs.existsSync(taskDir)) {
        return res.status(404).json({ error: 'Task directory not found' });
    }

    // 埋点：记录下载启动
    const startTime = Date.now();
    try {
        db.prepare(`INSERT INTO download_events (event_type, user_id, username, task_id) VALUES (?, ?, ?, ?)`)
            .run('download_start', req.user.id, req.user.username, taskId);
    } catch (e) {
        console.error('[Download Tracking] Failed to log download_start:', e.message);
    }

    // 埋点：记录下载完成
    res.on('finish', () => {
        const durationMs = Date.now() - startTime;
        try {
            db.prepare(`INSERT INTO download_events (event_type, user_id, username, task_id, duration_ms) VALUES (?, ?, ?, ?, ?)`)
                .run('download_complete', req.user.id, req.user.username, taskId, durationMs);
        } catch (e) {
            console.error('[Download Tracking] Failed to log download_complete:', e.message);
        }
    });

    streamZip(taskDir, `task_${taskId}.zip`, req, res);
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

        const insertTask = db.prepare('INSERT INTO tasks (task_id, title, prompt, base_dir, user_id, source_type) VALUES (?, ?, ?, ?, ?, ?)');
        const insertRun = db.prepare('INSERT INTO model_runs (task_id, model_id, status) VALUES (?, ?, ?)');
        const insertQueue = db.prepare("INSERT INTO task_queue (task_id, status) VALUES (?, 'pending')");
        const batchUserId = req.user.id;

        const processBatch = db.transaction((lines) => {
            lines.forEach((prompt, index) => {
                const taskId = crypto.randomBytes(4).toString('hex').toUpperCase();
                const title = `Batch Task ${index + 1}`;

                insertTask.run(taskId, title, prompt, null, batchUserId, 'prompt');
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
