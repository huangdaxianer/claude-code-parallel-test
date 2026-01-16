require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const cors = require('cors');
const https = require('https');
const multer = require('multer');


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


const HISTORY_FILE = path.join(TASKS_DIR, 'history.json');


// 获取所有任务 (从 history.json 读取)
app.get('/api/tasks', (req, res) => {
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
            // 按时间倒序返回
            return res.json(history.reverse());
        } catch (e) {
            console.error('Error reading history:', e);
            return res.json([]);
        }
    }
    // Fallback: 如果没有 history.json，尝试读取 prompt.txt (简单兼容)
    if (!fs.existsSync(PROMPT_FILE)) {
        return res.json([]);
    }
    return res.json([]);
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

    // 1. 立即加入历史记录 (此时标题是 "正在生成描述...")
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
        } catch (e) { }
    }
    history.push(task);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

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

    // 4. 异步生成 AI 标题，并在生成后更新历史记录
    generateTitle(task.prompt).then(aiTitle => {
        try {
            let currentHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
            const taskIndex = currentHistory.findIndex(t => t.taskId === task.taskId);
            if (taskIndex !== -1) {
                currentHistory[taskIndex].title = aiTitle;
                fs.writeFileSync(HISTORY_FILE, JSON.stringify(currentHistory, null, 2));
                console.log(`[ID: ${task.taskId}] Title updated to: ${aiTitle}`);
            }
        } catch (e) {
            console.error("Error updating title in history:", e);
        }
    });

    // 5. 立即返回成功，前端此时已能看到任务出现在列表中
    res.json({ success: true, taskId: task.taskId });
});

// ... (other endpoints)



// 获取任务详情：根据 nested structure (TaskID/ModelName)
app.get('/api/task_details/:taskId', (req, res) => {
    const { taskId } = req.params;
    const taskDir = path.join(TASKS_DIR, taskId);


    // 0. 从 history.json 获取该任务的原始信息 (为了知道预期的模型列表)
    let taskMeta = null;
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
            taskMeta = history.find(t => t.taskId === taskId);
        } catch (e) { }
    }

    const responseData = {
        taskId,
        title: taskMeta ? taskMeta.title : 'Unknown Task',
        prompt: taskMeta ? taskMeta.prompt : '',
        expectedModels: taskMeta ? taskMeta.models : [],
        runs: []
    };

    if (!fs.existsSync(taskDir) || !fs.statSync(taskDir).isDirectory()) {
        // 如果目录还没创建，也返回预期的模型列表，方便前端显示
        if (responseData.expectedModels) {
            responseData.runs = responseData.expectedModels.map(m => ({
                folderName: path.join(taskId, m),
                modelName: m,
                outputLog: 'Waiting for execution to start...',
                generatedFiles: [],
                status: 'pending'
            }));
        }
        return res.json(responseData);
    }

    // New Structure Logic
    fs.readdir(taskDir, { withFileTypes: true }, (err, files) => {
        if (err) return res.status(500).json({ error: 'Failed to read task directory' });

        // 每个子文件夹就是一个 Model Run
        const modelDirs = files.filter(dirent => dirent.isDirectory());
        const discoveredModels = modelDirs.map(d => d.name);

        // 如果 history 里记录了模型，我们按照 history 里的顺序和列表返回
        const modelsToReturn = responseData.expectedModels && responseData.expectedModels.length > 0
            ? responseData.expectedModels
            : discoveredModels;

        // Load Stats Cache
        const statsCachePath = path.join(taskDir, 'task_stats.json');
        let statsCache = {};
        if (fs.existsSync(statsCachePath)) {
            try {
                statsCache = JSON.parse(fs.readFileSync(statsCachePath, 'utf8'));
            } catch (e) { }
        }
        let cacheDirty = false;

        responseData.runs = modelsToReturn.map(modelName => {
            const folderPath = path.join(taskDir, modelName);
            const uniqueFolderIdentifier = path.join(taskId, modelName);

            let outputLog = null;
            let generatedFiles = [];
            let status = 'pending';
            let stats = null;

            if (fs.existsSync(folderPath)) {
                status = 'running';
                // 读取日志逻辑调整：从任务根目录读取 模型名.txt
                try {
                    const logFilePath = path.join(taskDir, `${modelName}.txt`);
                    if (fs.existsSync(logFilePath)) {
                        const logStat = fs.statSync(logFilePath);
                        const mtime = logStat.mtimeMs;

                        // Check Cache
                        if (statsCache[modelName] && statsCache[modelName].mtime === mtime && statsCache[modelName].stats) {
                            // Cache Hit
                            stats = statsCache[modelName].stats;
                            status = statsCache[modelName].status;
                        } else {
                            // Cache Miss - Read File
                            const fullLog = fs.readFileSync(logFilePath, 'utf8');
                            outputLog = null;

                            // Check status
                            const lines = fullLog.split('\n').filter(l => l.trim());
                            if (lines.length > 0) {
                                status = 'running';
                                try {
                                    const lastLine = lines[lines.length - 1];
                                    const lastObj = JSON.parse(lastLine);
                                    if (lastObj.type === 'result') {
                                        status = 'completed';
                                    }
                                } catch (err) { }
                            } else {
                                status = 'pending';
                            }

                            // Calculate Stats
                            stats = calculateLogStats(fullLog);

                            // Update Cache
                            statsCache[modelName] = {
                                mtime: mtime,
                                stats: stats,
                                status: status
                            };
                            cacheDirty = true;
                        }
                    }
                } catch (err) {
                    console.error(`Error processing log for ${modelName}:`, err);
                }
            }

            // Find generated files
            if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
                try {
                    const walkSync = (dir, filelist = []) => {
                        const files = fs.readdirSync(dir);
                        files.forEach(file => {
                            const filepath = path.join(dir, file);
                            if (fs.statSync(filepath).isDirectory()) {
                                walkSync(filepath, filelist);
                            } else {
                                // Return relative path from model folder
                                filelist.push(path.relative(folderPath, filepath));
                            }
                        });
                        return filelist;
                    };
                    generatedFiles = walkSync(folderPath);
                } catch (e) {
                    console.error(`Error reading generated files for ${modelName}:`, e);
                }
            }

            return {
                folderName: uniqueFolderIdentifier,
                modelName,
                // outputLog, // Exclude heavy log
                stats,     // Include calculated stats
                generatedFiles,
                status
            };
        });

        // Save Cache if dirty
        if (cacheDirty) {
            try {
                fs.writeFileSync(statsCachePath, JSON.stringify(statsCache, null, 2));
            } catch (e) {
                console.error("Failed to save stats cache:", e);
            }
        }

        res.json(responseData);
    });
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

    // 1. 从 history.json 删除
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            let history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
            const initialLength = history.length;
            history = history.filter(t => t.taskId !== taskId);

            if (history.length < initialLength) {
                fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
            }
        } catch (e) {
            console.error('Error updating history:', e);
            return res.status(500).json({ error: 'Failed to update history' });
        }
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


// Helper to calculate stats on valid JSON logs
function calculateLogStats(logContent) {
    const stats = {
        duration: 0,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        toolCounts: {
            TodoWrite: 0,
            Read: 0,
            Write: 0,
            Bash: 0
        }
    };

    if (!logContent) return stats;

    // Handle duplicate newlines or concatenated JSON objects just in case
    const formattedContent = logContent.replace(/}\s*{/g, '}\n{');
    const lines = formattedContent.split(/\r\n|\n|\r/);

    lines.forEach(line => {
        if (!line.trim() || !line.trim().startsWith('{')) return;
        try {
            const obj = JSON.parse(line);

            if (obj.type === 'result') {
                if (obj.duration_ms) stats.duration = (obj.duration_ms / 1000).toFixed(1);
                else if (obj.duration) stats.duration = (obj.duration / 1000).toFixed(1);

                if (obj.usage) {
                    stats.inputTokens = obj.usage.input_tokens || 0;
                    stats.outputTokens = obj.usage.output_tokens || 0;
                    stats.cacheReadTokens = obj.usage.cache_read_input_tokens || 0;
                } else if (obj.tokenUsage) {
                    stats.inputTokens = obj.tokenUsage.input || obj.tokenUsage.input_tokens || 0;
                    stats.outputTokens = obj.tokenUsage.output || obj.tokenUsage.output_tokens || 0;
                    stats.cacheReadTokens = obj.tokenUsage.cacheRead || obj.tokenUsage.cache_read_input_tokens || 0;
                }
            }

            if (obj.type === 'user') stats.turns++;

            if (obj.type === 'tool_use') {
                const name = obj.name;
                if (stats.toolCounts.hasOwnProperty(name)) stats.toolCounts[name]++;
            }
            if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
                obj.message.content.forEach(block => {
                    if (block.type === 'tool_use') {
                        const name = block.name;
                        if (stats.toolCounts.hasOwnProperty(name)) stats.toolCounts[name]++;
                    }
                });
            }
        } catch (e) { }
    });
    return stats;
}

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


