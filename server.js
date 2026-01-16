require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const cors = require('cors');
const https = require('https');
const multer = require('multer');
const db = require('./db');


const app = express();
const PORT = 3001;

const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
server.timeout = 300000; // 5 minutes timeout for large uploads
const PROMPT_FILE = path.join(__dirname, 'prompt.txt');
const SCRIPT_FILE = path.join(__dirname, 'batch_claude_parallel.sh');
const TASKS_DIR = path.join(__dirname, 'tasks');
const UPLOAD_DIR = path.join(TASKS_DIR, 'temp_uploads');

// Ensure directories exist
[TASKS_DIR, UPLOAD_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Multer configuration to preserve directory structure
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    }
    // 不再自定义 filename，使用 multer 默认生成的随机唯一文件名
});
const upload = multer({ storage: storage });




const TITLE_GEN_API = process.env.TITLE_GEN_API || "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
const TITLE_GEN_MODEL = process.env.TITLE_GEN_MODEL || "doubao-seed-1-6-flash-250828";
const TITLE_GEN_KEY = process.env.TITLE_GEN_KEY || ""; // 移除硬编码 Key，改由环境变量获取

async function generateTitle(userPrompt) {
    return new Promise((resolve) => {
        const postData = JSON.stringify({
            model: TITLE_GEN_MODEL,
            messages: [
                { role: "system", content: "You are a helpful assistant that generates extremely short, descriptive task titles (3-5 words) based on a task prompt. The title should be in the same language as the prompt. Return ONLY the title text, no quotes or prefix." },
                { role: "user", content: `Generate a title for this task: ${userPrompt}` }
            ],
            max_tokens: 50
        });

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TITLE_GEN_KEY}`
            }
        };

        const req = https.request(TITLE_GEN_API, options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const title = data.choices[0].message.content.trim();
                    resolve(title);
                } catch (e) {
                    console.error("AI Title Gen Parse Error:", e);
                    resolve("New Task");
                }
            });
        });

        req.on('error', (e) => {
            console.error("AI Title Gen Request Error:", e);
            resolve("New Task");
        });

        req.write(postData);
        req.end();
    });
}

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));
app.use('/artifacts', express.static(TASKS_DIR)); // Allow serving task files for preview

// Redirect root to task.html
app.get('/', (req, res) => {
    res.redirect('/task.html');
});



// 获取所有任务 (从数据库读取)
app.get('/api/tasks', (req, res) => {
    try {
        const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
        // Convert camelCase if needed, but here we use taskId etc.
        // Actually, let's keep it consistent with what the front-end expects
        return res.json(tasks.map(t => ({
            taskId: t.task_id,
            title: t.title,
            prompt: t.prompt,
            baseDir: t.base_dir,
            createdAt: t.created_at
        })));
    } catch (e) {
        console.error('Error reading tasks from DB:', e);
        return res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

// 弹出原生文件夹选择器 (仅限 macOS)
app.post('/api/browse', (req, res) => {
    // 检查操作系统是否为 macOS
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

// 上传文件夹接口 (保持目录结构) - 使用 .any() 允许接收任意数量和字段的文件，彻底解决 Unexpected Field 报错
app.post('/api/upload', upload.any(), (req, res) => {
    const folderName = req.body.folderName;
    if (!folderName) {
        console.error('[Upload] Error: Missing folderName in request body');
        return res.status(400).json({ error: 'Missing folderName' });
    }

    const uploadId = Date.now();
    const targetBase = path.join(UPLOAD_DIR, `${uploadId}_${folderName}`);
    console.log(`[Upload] Starting process for folder: ${folderName} (ID: ${uploadId})`);

    try {
        if (!fs.existsSync(targetBase)) {
            fs.mkdirSync(targetBase, { recursive: true });
        }

        if (!req.files || req.files.length === 0) {
            console.error('[Upload] Error: No files received from multer');
            return res.status(400).json({ error: '没有接收到文件' });
        }

        const filesToProcess = req.files.filter(f => f.fieldname === 'files');
        const fileCount = filesToProcess.length;

        // Ensure filePaths is an array
        let filePaths = req.body.filePaths;
        if (!Array.isArray(filePaths)) {
            filePaths = [filePaths];
        }

        let totalBytes = 0;
        filesToProcess.forEach(f => totalBytes += f.size);
        const sizeInMB = (totalBytes / (1024 * 1024)).toFixed(2);

        console.log(`[Upload] Received ${fileCount} files, total size: ${sizeInMB} MB`);

        filesToProcess.forEach((file, index) => {
            // Use the explicit path sent from the client
            const relPath = filePaths[index] || file.originalname;

            // The path starts with the folder name, e.g. "my-project/src/index.js"
            // Since targetBase is already .../TIMESTAMP_my-project, we should join 
            // relative to the PARENT of targetBase to avoid double nesting, 
            // OR join relative to targetBase but strip the first component.

            // Let's join relative to targetBase's parent directory
            const parentDir = path.dirname(targetBase);
            const fullPath = path.join(parentDir, `${uploadId}_${relPath}`);
            const dir = path.dirname(fullPath);

            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            fs.renameSync(file.path, fullPath);

            if (index % 100 === 0 || index === fileCount - 1) {
                console.log(`[Upload] Processing: ${index + 1}/${fileCount} files...`);
            }
        });

        console.log(`[Upload] Successfully processed folder: ${targetBase}`);
        res.json({ path: targetBase });
    } catch (err) {
        console.error('[Upload] Fatal server error during processing:', err);
        res.status(500).json({ error: `处理上传文件失败: ${err.message}` });
    }
});




// 保存任务 并 启动执行
app.post('/api/tasks', (req, res) => {
    const task = req.body.task;
    if (!task || !task.taskId) {
        return res.status(400).json({ error: 'Invalid task format' });
    }

    // 1. 立即加入数据库记录
    try {
        const insertTask = db.prepare('INSERT INTO tasks (task_id, title, prompt, base_dir) VALUES (?, ?, ?, ?)');
        insertTask.run(task.taskId, task.title, task.prompt, task.baseDir);

        const insertRun = db.prepare('INSERT INTO model_runs (task_id, model_name, status) VALUES (?, ?, ?)');
        const models = Array.isArray(task.models) ? task.models : [];
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

    // 2. 处理上传的项目文件夹：如果是从 temp_uploads 上传的，移动到任务专属目录
    let finalBaseDir = task.baseDir;
    const taskDir = path.join(TASKS_DIR, task.taskId);

    if (finalBaseDir && finalBaseDir.includes('temp_uploads')) {
        const sourcePath = finalBaseDir;
        const targetPath = path.join(taskDir, 'source');

        try {
            if (!fs.existsSync(taskDir)) fs.mkdirSync(taskDir, { recursive: true });
            fs.renameSync(sourcePath, targetPath);
            finalBaseDir = path.relative(__dirname, targetPath); // 使用相对于根目录的路径
            task.baseDir = finalBaseDir; // 更新任务对象中的路径
        } catch (err) {
            console.error('Error moving uploaded source:', err);
        }
    }

    // 3. 创建该任务专属的 prompt 文件
    const specificPromptFile = path.join(TASKS_DIR, `prompt_${task.taskId}.txt`);
    const modelsStr = Array.isArray(task.models) ? task.models.join(',') : '';
    // Sanitize prompt and title to remove newlines, as they break the shell script's read command
    const safeTitle = (task.title || '').replace(/[\r\n]+/g, ' ');
    const safePrompt = (task.prompt || '').replace(/[\r\n]+/g, ' ');
    const promptContent = `${finalBaseDir || ''};${safeTitle};${safePrompt};${task.taskId};${modelsStr}\n`;
    fs.writeFileSync(specificPromptFile, promptContent);


    // 3. 异步启动脚本执行，不阻塞响应
    const child = spawn('bash', [SCRIPT_FILE, specificPromptFile]);
    child.stdout.on('data', (data) => console.log(`[Task ${task.taskId}] ${data}`));
    child.on('close', () => {
        // 完成后删除临时 prompt 文件
        try { fs.unlinkSync(specificPromptFile); } catch (e) { }
    });

    // 4. 异步生成 AI 标题，并在生成后更新数据库
    generateTitle(task.prompt).then(aiTitle => {
        try {
            const updateTitle = db.prepare('UPDATE tasks SET title = ? WHERE task_id = ?');
            updateTitle.run(aiTitle, task.taskId);
            console.log(`[ID: ${task.taskId}] Title updated to: ${aiTitle}`);
        } catch (e) {
            console.error("Error updating title in DB:", e);
        }
    });

    // 5. 立即返回成功，前端此时已能看到任务出现在列表中
    res.json({ success: true, taskId: task.taskId });
});

// ... (other endpoints)



// 获取任务详情：从数据库读取
app.get('/api/task_details/:taskId', (req, res) => {
    const { taskId } = req.params;
    const taskDir = path.join(TASKS_DIR, taskId);

    try {
        const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const runs = db.prepare('SELECT * FROM model_runs WHERE task_id = ?').all(taskId);

        const responseData = {
            taskId: task.task_id,
            title: task.title,
            prompt: task.prompt,
            runs: runs.map(run => {
                const folderPath = path.join(taskDir, run.model_name);
                let generatedFiles = [];

                if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
                    const walkSync = (dir, filelist = []) => {
                        fs.readdirSync(dir).forEach(file => {
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

                // Check if we need to update stats from log (if status is still running/pending or cache bit missing)
                // For now, we trust the DB stats. Real-time updates will be handled by ingestion.

                return {
                    folderName: path.join(taskId, run.model_name),
                    modelName: run.model_name,
                    status: run.status,
                    generatedFiles,
                    stats: {
                        duration: run.duration,
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

// 新增：单独获取特定模型的完整日志
app.get('/api/task_logs/:taskId/:modelName', (req, res) => {
    const { taskId, modelName } = req.params;
    const logFilePath = path.join(TASKS_DIR, taskId, `${modelName}.txt`);

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

const archiver = require('archiver');

// ... (existing code)

// 读取文件内容
app.get('/api/file_content', (req, res) => {
    const { folder, file } = req.query;
    if (!folder || !file) return res.status(400).json({ error: 'Missing folder or file' });

    const targetPath = path.join(TASKS_DIR, folder, file);

    if (!targetPath.startsWith(TASKS_DIR)) {
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
app.get('/api/download_zip', (req, res) => {
    const { folderName } = req.query;
    console.log(`[ZIP Request] Request for folder: ${folderName}`);

    if (!folderName) return res.status(400).json({ error: 'Missing folderName' });

    const folderPath = path.join(TASKS_DIR, folderName);

    // Security check
    if (!folderPath.startsWith(TASKS_DIR)) {
        console.error(`[ZIP Error] Access denied for path: ${folderPath}`);
        return res.status(403).send('Access denied');
    }


    if (!fs.existsSync(folderPath)) {
        console.error(`[ZIP Error] Folder not found: ${folderPath}`);
        return res.status(404).send('Folder not found');
    }

    try {
        const archive = archiver('zip', {
            zlib: { level: 1 } // Use lower compression level for speed
        });

        // Listen for all archive data to be written
        res.on('close', function () {
            // Client disconnected
        });

        res.on('end', function () {
            console.log('[ZIP] Data has been drained');
        });

        archive.on('warning', function (err) {
            if (err.code === 'ENOENT') {
                console.warn('[ZIP Warning]', err);
            } else {
                console.error('[ZIP Error from Warning]', err);
                if (!res.headersSent) res.status(500).send({ error: err.message });
            }
        });

        archive.on('error', function (err) {
            console.error('[ZIP Error]', err);
            if (!res.headersSent) res.status(500).send({ error: err.message });
        });

        // Set headers
        const downloadName = folderName.replace(/[\/\\]/g, '_') + '.zip';
        res.attachment(downloadName);

        // Pipe archive data to the result response
        archive.pipe(res);

        // Append files using glob to EXCLUDE node_modules and .git
        console.log(`[ZIP] Archiving directory: ${folderPath}`);

        // glob pattern to include all files
        archive.glob('**/*', {
            cwd: folderPath,
            ignore: [
                '**/node_modules/**', // Ignore contents
                '**/node_modules',    // Ignore the folder itself
                '**/.git/**',
                '**/.git',
                '**/.DS_Store'
            ],
            dot: true, // include dotfiles like .env
            follow: false // Do not follow symlinks to avoid loops or massive external files
        });

        archive.finalize();

    } catch (e) {
        console.error('[ZIP Exception]', e);
        if (!res.headersSent) res.status(500).send({ error: 'Internal Server Error during zip operation' });
    }
});

// 删除任务
app.delete('/api/tasks/:taskId', (req, res) => {
    const { taskId } = req.params;

    try {
        db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
    } catch (e) {
        console.error('Error deleting task from DB:', e);
        return res.status(500).json({ error: 'Failed to delete task from database' });
    }

    // 2. 删除目录和 prompt 文件
    const taskDir = path.join(TASKS_DIR, taskId);
    const specificPromptFile = path.join(TASKS_DIR, `prompt_${taskId}.txt`);

    if (fs.existsSync(taskDir)) {
        try {
            fs.rmSync(taskDir, { recursive: true, force: true });
        } catch (e) {
            console.error('Error deleting task directory:', e);
        }
    }
    if (fs.existsSync(specificPromptFile)) {
        try {
            fs.unlinkSync(specificPromptFile);
        } catch (e) {
            console.error('Error deleting prompt file:', e);
        }
    }


    res.json({ success: true });
});


// Legacy calculateLogStats removed as it is now handled by ingest.js or migrate.js

// Multer error handling middleware (must be after routes)
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        console.error('[MulterError]', err);
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({
                error: '文件数量超过上限或字段名错误。请检查上传的文件数量（当前上限 100,000）或联系管理员。',
                detail: err.message
            });
        }
        return res.status(400).json({ error: `上传错误: ${err.message}`, code: err.code });
    }
    // Generic error handler
    console.error('[ServerError]', err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
});


