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
app.use(bodyParser.json());
app.use(express.static('public'));
app.use('/artifacts', express.static(TASKS_DIR)); // Allow serving task files for preview


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

// 上传文件夹接口 (保持目录结构)
app.post('/api/upload', upload.array('files'), (req, res) => {
    const folderName = req.body.folderName;
    if (!folderName) return res.status(400).json({ error: 'Missing folderName' });

    // 使用单一时间戳确保本次上传的所有文件都在同一个目录下
    const uploadId = Date.now();
    const targetBase = path.join(UPLOAD_DIR, `${uploadId}_${folderName}`);

    try {
        if (!fs.existsSync(targetBase)) fs.mkdirSync(targetBase, { recursive: true });

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: '没有接收到文件' });
        }

        req.files.forEach(file => {
            // file.originalname 包含了前端传来的相对路径 (webkitRelativePath)
            const relPath = file.originalname;
            const fullPath = path.join(targetBase, relPath);
            const dir = path.dirname(fullPath);

            // 递归创建子目录
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            // 将临时随机命名的文件移动到正确的相对位置
            fs.renameSync(file.path, fullPath);
        });

        res.json({ path: targetBase });
    } catch (err) {
        console.error('Upload error:', err);
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
            // 立即同步更新 history.json 中的路径，以免重启丢失迁移状态
            const updatedHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
            const idx = updatedHistory.findIndex(t => t.taskId === task.taskId);
            if (idx !== -1) {
                updatedHistory[idx].baseDir = finalBaseDir;
                fs.writeFileSync(HISTORY_FILE, JSON.stringify(updatedHistory, null, 2));
            }
        } catch (err) {
            console.error('Error moving uploaded source:', err);
        }
    }

    // 3. 创建该任务专属的 prompt 文件
    const specificPromptFile = path.join(TASKS_DIR, `prompt_${task.taskId}.txt`);
    const modelsStr = Array.isArray(task.models) ? task.models.join(',') : '';
    const taskPromptContent = `${finalBaseDir || ''};${task.title};${task.prompt};${task.taskId};${modelsStr}\n`;
    fs.writeFileSync(specificPromptFile, taskPromptContent);

    // 4. 异步启动脚本执行，不阻塞响应
    const child = spawn('bash', [SCRIPT_FILE, specificPromptFile]);
    child.stdout.on('data', (data) => console.log(`[Task ${task.taskId}] ${data}`));
    child.on('close', () => {
        // 完成后删除临时 prompt 文件
        try { fs.unlinkSync(specificPromptFile); } catch (e) { }
    });

    // 5. 异步生成 AI 标题，并在生成后更新历史记录
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

    // 6. 立即返回成功，前端此时已能看到任务出现在列表中
    res.json({ success: true, taskId: task.taskId });
});


// ... (other endpoints)

// 执行脚本
app.post('/api/execute', (req, res) => {
    console.log('Starting parallel batch execution...');

    // 使用 spawn 替代 exec，避免 maxBuffer 限制导致长运行任务被杀
    const child = spawn('bash', [SCRIPT_FILE]);

    // 立即返回，不等待执行结束
    res.json({ success: true, message: 'Execution started in background' });

    // 实时流式输出日志
    child.stdout.on('data', (data) => {
        process.stdout.write(data); // 输出到主进程控制台
    });

    child.stderr.on('data', (data) => {
        process.stderr.write(data);
    });

    child.on('close', (code) => {
        console.log(`Batch execution process exited with code ${code}`);
    });

    child.on('error', (err) => {
        console.error('Failed to start subprocess:', err);
    });
});

// 获取任务详情：根据 nested structure (TaskID/ModelName)
app.get('/api/task_details/:taskId', (req, res) => {
    const { taskId } = req.params;
    const taskDir = path.join(TASKS_DIR, taskId);


    if (!fs.existsSync(taskDir) || !fs.statSync(taskDir).isDirectory()) {
        // 兼容旧逻辑：尝试查找旧格式的文件夹 (base_title_model_taskId)
        // 如果找不到新结构，才去遍历根目录找旧结构
        fs.readdir(rootDir, { withFileTypes: true }, (err, files) => {
            if (err) return res.status(500).json({ error: 'Failed to read directory' });
            const oldTaskFolders = files.filter(dirent => dirent.isDirectory() && dirent.name.endsWith(`_${taskId}`));
            if (oldTaskFolders.length === 0) {
                return res.json({ runs: [] });
            }
            // ... Old logic handler could be here, but let's assume valid ID leads to new structure mostly.
            // For simplicity, reusing old logic logic block if needed or just return empty for now to force new structure usage.
            // Let's implement a quick fallback for old folders if really needed, OR just support new structure.
            // Given the prompt "modify all logic", let's prioritize new structure.
            return res.json({ runs: [] });
        });
        return;
    }

    // New Structure Logic
    fs.readdir(taskDir, { withFileTypes: true }, (err, files) => {
        if (err) return res.status(500).json({ error: 'Failed to read task directory' });

        // 每个子文件夹就是一个 Model Run
        const modelDirs = files.filter(dirent => dirent.isDirectory());

        const details = modelDirs.map(dirent => {
            const modelName = dirent.name;
            const folderPath = path.join(taskDir, modelName);
            // 构造一个相对路径或者 ID 供前端引用 (folderName 现在只是 model 名，不唯一，需结合 taskId)
            // 为了兼容前端 task.js 的逻辑 (它使用 folderName 作为唯一标识符去 fetch file_content)，
            // 我们这里返回 "taskId/modelName" 作为 folderName 给前端
            const uniqueFolderIdentifier = path.join(taskId, modelName);

            // 读取 output.txt
            let outputLog = '';
            try {
                outputLog = fs.readFileSync(path.join(folderPath, 'output.txt'), 'utf8');
            } catch (e) {
                outputLog = '(No output log yet)';
            }

            // 读取文件夹内的文件列表
            let generatedFiles = [];
            try {
                const readDirRecursive = (dir) => {
                    let results = [];
                    const list = fs.readdirSync(dir, { withFileTypes: true });
                    list.forEach(file => {
                        // 排除系统文件和日志
                        if (file.name === 'node_modules' || file.name === '.git' || file.name === '.DS_Store' || file.name === 'output.txt' || file.name.startsWith('prompt')) return;

                        const fullPath = path.join(dir, file.name);
                        const relPath = path.relative(folderPath, fullPath);
                        if (file.isDirectory()) {
                            results = results.concat(readDirRecursive(fullPath));
                        } else {
                            results.push(relPath);
                        }
                    });
                    return results;
                };
                generatedFiles = readDirRecursive(folderPath);
            } catch (e) {
                generatedFiles = ['Error reading files'];
            }

            return {
                folderName: uniqueFolderIdentifier, // format: "taskId/modelName"
                modelName,
                outputLog,
                generatedFiles
            };
        });

        res.json({ runs: details });
    });
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

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
