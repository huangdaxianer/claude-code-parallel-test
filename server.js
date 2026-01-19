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
const net = require('net');


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

    // 2. 预定义变量
    let finalBaseDir = task.baseDir;
    const taskDir = path.join(TASKS_DIR, task.taskId);

    // 1.5 处理增量开发：如果指定了 srcTaskId，则从该任务目录复制文件作为新任务的 source
    if (task.srcTaskId) {
        let srcTaskDir = path.join(TASKS_DIR, task.srcTaskId);
        let targetPath = path.join(taskDir, 'source');

        if (task.srcModelName) {
            // 如果仅想基于特定的 output 文件夹继续（如 tasks/7L6WXV/strawberry/）
            // 我们将其内容复制到 tasks/NewID/source/strawberry/ 中
            // 注意：新的任务脚本通常期望 source 文件夹下就是文件根目录。
            // 之前的 copyFiles(srcTaskDir, targetPath) 是把 tasks/ID/* 复制到 tasks/NewID/source/*

            // 如果用户选了 strawberry 文件夹，我们应该把 tasks/ID/strawberry/* 复制到 tasks/NewID/source/* 
            // 这样新任务就以 strawberry 的产物作为根目录开始。
            // 否则，如果还是复制到 tasks/NewID/source/strawberry/，那么新任务脚本可能找不到文件（取决于它去哪找）。
            // 通常项目上传是上传一个文件夹，比如 'my-project'，然后脚本在 'source/my-project' 下面找？
            // 之前的上传逻辑是：上传到 `TASK/source/FolderName`。

            // 所以如果我们选了 strawberry，应该把内容复制到 `TASK/source/strawberry`，然后 baseDir 指向 `TASK/source`。

            srcTaskDir = path.join(srcTaskDir, task.srcModelName);
            targetPath = path.join(targetPath, task.srcModelName);
        }

        if (fs.existsSync(srcTaskDir)) {
            try {
                if (!fs.existsSync(taskDir)) fs.mkdirSync(taskDir, { recursive: true });
                if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });

                console.log(`[Incremental] Copying files from ${srcTaskDir} to ${targetPath}`);

                // Recursive Copy Function excluding logs and hidden files
                const copyFiles = (src, dest) => {
                    const items = fs.readdirSync(src);
                    items.forEach(item => {
                        if (item.endsWith('.txt')) return; // Logs
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

                // baseDir 统一指向 source 目录的父级（如果是上传文件夹，baseDir 是 source/FolderName 的相对路径）
                // 不，看之前的 upload 逻辑，res.json({ path: targetBase }) 返回的是 source/FolderName。
                // 这里的 finalBaseDir 就应该是 path.relative(__dirname, targetPath)。
                finalBaseDir = path.relative(__dirname, targetPath);
                task.baseDir = finalBaseDir;
                console.log(`[Incremental] Setup complete. Base dir: ${finalBaseDir}`);

            } catch (err) {
                console.error('[Incremental] Copy failed:', err);
            }
        }
    }


    // 2. 处理上传的项目文件夹：如果是从 temp_uploads 上传的，移动到任务专属目录
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

    // 3. (Refactored) Invoke script with Task ID. Content is fetched from DB.
    console.log(`[ID: ${task.taskId}] Spawning task with script: ${SCRIPT_FILE} and ID: ${task.taskId}`);
    // Explicitly set LANG environment variable to ensure proper encoding for child process
    const child = spawn('bash', [SCRIPT_FILE, task.taskId], {
        env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
    });

    child.stdout.on('data', (data) => console.log(`[Task ${task.taskId} STDOUT] ${data}`));
    child.stderr.on('data', (data) => console.error(`[Task ${task.taskId} STDERR] ${data}`));

    child.on('error', (err) => {
        console.error(`[Task ${task.taskId} ERROR] Failed to spawn process:`, err);
    });

    child.on('exit', (code, signal) => {
        console.log(`[Task ${task.taskId} EXIT] Process exited with code ${code} and signal ${signal}`);
        // Cleanup not needed as prompt file is no longer used
    });

    child.on('close', (code) => {
        console.log(`[Task ${task.taskId} CLOSE] Stream closed with code ${code}`);
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

// --- Dynamic Preview Logic ---

const runningPreviews = {}; // folderName -> { proc, port, url, lastAccess }

// Helper Methods
const http = require('http');

function checkPort(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') resolve(true);
            else resolve(false);
        });
        server.once('listening', () => {
            server.close();
            resolve(false);
        });
        server.listen(port);
    });
}

const allocatedPorts = new Set(); // Track ports assigned but not yet bound

async function findFreePort(start = 4000, end = 5000) {
    for (let p = start; p <= end; p++) {
        if (allocatedPorts.has(p)) continue;
        if (!(await checkPort(p))) {
            allocatedPorts.add(p);
            // Release from set after 30 seconds (assumed bound by then or failed)
            setTimeout(() => allocatedPorts.delete(p), 30000);
            return p;
        }
    }
    throw new Error('No free ports available');
}

// 1. Recursive PID lookup
function getChildPids(pid) {
    return new Promise((resolve) => {
        exec(`pgrep -P ${pid}`, (err, stdout) => {
            if (err || !stdout) return resolve([]);
            const pids = stdout.trim().split(/\s+/).map(p => parseInt(p, 10));
            Promise.all(pids.map(getChildPids)).then(grandChildren => {
                const all = [...pids, ...grandChildren.flat()];
                resolve(all);
            });
        });
    });
}

// 2. Find listening ports for PIDs
async function getListeningPorts(pids) {
    if (pids.length === 0) return [];
    const pidList = pids.join(',');
    return new Promise((resolve) => {
        exec(`lsof -a -iTCP -sTCP:LISTEN -p ${pidList} -n -P -Fn`, (err, stdout) => {
            if (err || !stdout) return resolve([]);
            const ports = new Set();
            stdout.split('\n').forEach(line => {
                if (line.startsWith('n')) {
                    const part = line.substring(1);
                    const portMatch = part.match(/:(\d+)$/);
                    if (portMatch) ports.add(parseInt(portMatch[1], 10));
                }
            });
            resolve(Array.from(ports));
        });
    });
}

// 3. Probe service type
async function probePort(port) {
    return new Promise(resolve => {
        // Use localhost to allow Node to resolve to ::1 or 127.0.0.1 as needed
        const req = http.get(`http://localhost:${port}/`, { timeout: 2000 }, (res) => {
            let data = '';
            res.on('data', chunk => { if (data.length < 1000) data += chunk; });
            res.on('end', () => {
                const type = (res.headers['content-type'] || '').toLowerCase();
                const body = data.toString().toLowerCase();
                let score = 0;
                let serviceType = 'unknown';

                if (type.includes('text/html') || body.includes('<!doctype html>') || body.includes('<html')) {
                    score = 100;
                    serviceType = 'frontend';
                } else if (type.includes('application/json') || body.startsWith('{')) {
                    score = 10;
                    serviceType = 'backend';
                } else {
                    score = 1;
                }
                if (res.statusCode === 404) score /= 2;
                resolve({ port, score, serviceType, statusCode: res.statusCode });
            });
        });
        req.on('error', () => resolve({ port, score: -1, serviceType: 'error' }));
        req.on('timeout', () => { req.destroy(); resolve({ port, score: -1, serviceType: 'timeout' }); });
    });
}

// Helper: Determine startup command
async function detectStartCommand(projectPath) {
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const scripts = pkg.scripts || {};
            if (scripts.start) return { cmd: 'npm', args: ['start'] };
            if (scripts.dev) return { cmd: 'npm', args: ['run', 'dev'] };
        } catch (e) {
            console.warn(`[Preview] Failed to parse package.json: ${e.message}`);
        }
    }
    const commonEntries = ['server.js', 'app.js', 'index.js', 'main.js'];
    for (const entry of commonEntries) {
        if (fs.existsSync(path.join(projectPath, entry))) return { cmd: 'node', args: [entry] };
    }
    throw new Error('Unable to determine start command');
}

// Preview API
app.post('/api/preview/start', async (req, res) => {
    const { taskId, modelName } = req.body;
    if (!taskId || !modelName) return res.status(400).json({ error: 'Missing params' });

    const folderName = `${taskId}/${modelName}`;
    const projectPath = path.join(TASKS_DIR, taskId, modelName);

    // 1. Check if folder exists
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        return res.json({ type: 'static', url: `/artifacts/${folderName}/index.html` });
    }

    // 2. Check if already running
    if (runningPreviews[folderName]) {
        const info = runningPreviews[folderName];
        try {
            // Check if process exists
            process.kill(info.proc.pid, 0);
            runningPreviews[folderName].lastAccess = Date.now();
            return res.json({ type: 'server', url: runningPreviews[folderName].url });
        } catch (e) {
            delete runningPreviews[folderName]; // Process dead
        }
    }

    try {
        const allocatedPort = await findFreePort();

        // Install deps if needed
        if (fs.existsSync(path.join(projectPath, 'package.json')) && !fs.existsSync(path.join(projectPath, 'node_modules'))) {
            await new Promise((resolve, reject) => {
                exec('npm install', { cwd: projectPath }, (err) => err ? reject(err) : resolve());
            });
        }

        const { cmd, args } = await detectStartCommand(projectPath);
        console.log(`[Preview] Starting ${folderName} using ${cmd} ${args.join(' ')} (Allocated: ${allocatedPort})`);

        const child = spawn(cmd, args, {
            cwd: projectPath,
            env: { ...process.env, PORT: allocatedPort, HOST: '0.0.0.0' },
            detached: false
        });

        child.stdout.on('data', d => console.log(`[P ${folderName}] ${d}`.trim()));
        child.stderr.on('data', d => console.error(`[P ${folderName} ERR] ${d}`.trim()));

        // --- Multi-port Scanning Strategy ---
        const MAX_RETRIES = 30; // 30 seconds
        let retries = 0;
        let bestCandidate = null;

        const scanInterval = setInterval(async () => {
            retries++;

            // 1. Find PIDs
            const pids = [child.pid, ...(await getChildPids(child.pid))];

            // 2. Find Ports
            const ports = await getListeningPorts(pids);

            if (ports.length > 0) {
                // 3. Probe Ports
                const results = await Promise.all(ports.map(probePort));
                // Sort: Frontend (HTML) > Backend (JSON) > Unknown
                results.sort((a, b) => b.score - a.score);

                const best = results[0];
                if (best && best.score > 0) {
                    // Check if we found the allocated port too?
                    // We prefer any port that serves HTML.

                    if (best.serviceType === 'frontend') {
                        // Found HTML! Resolve immediately.
                        console.log(`[Preview] Found Frontend at port ${best.port}`);
                        clearInterval(scanInterval);
                        finish(best.port);
                        return;
                    }

                    // Keep track of best candidate (e.g. backend) in case we timeout
                    if (!bestCandidate || best.score > bestCandidate.score) {
                        bestCandidate = best;
                    }
                }
            }

            if (retries >= MAX_RETRIES) {
                clearInterval(scanInterval);
                if (bestCandidate) {
                    console.log(`[Preview] Timeout. Fallback to best candidate: ${bestCandidate.port} (${bestCandidate.serviceType})`);
                    finish(bestCandidate.port);
                } else {
                    // Fail
                    if (!res.headersSent) res.status(500).json({ error: 'Timeout: Service started but no accessible ports detected.' });
                    try { child.kill(); } catch (e) { }
                }
            }
        }, 1000);

        function finish(finalPort) {
            const url = `http://localhost:${finalPort}`;
            runningPreviews[folderName] = { proc: child, port: finalPort, url, lastAccess: Date.now() };
            if (!res.headersSent) res.json({ type: 'server', url });
        }

        child.on('exit', (code) => {
            clearInterval(scanInterval);
            if (code !== 0 && code !== null && !res.headersSent) {
                res.status(500).json({ error: `Process exited with code ${code}` });
            }
        });

    } catch (err) {
        console.error(`[Preview] Failed: ${err.message}`);
        if (!res.headersSent) res.json({ type: 'static', url: `/artifacts/${folderName}/index.html`, warning: err.message });
    }
});



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
                    runId: run.id,
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

// 新增：获取结构化日志事件（Trajectory 预览列表）
app.get('/api/task_events/:runId', (req, res) => {
    const { runId } = req.params;
    try {
        const events = db.prepare(`
            SELECT id, type, tool_name, tool_use_id, preview_text, status_class 
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

// 新增：获取特定日志条目的完整 JSON 内容 (并自动关联相关的 tool_result)
app.get('/api/log_event_content/:eventId', (req, res) => {
    const { eventId } = req.params;
    try {
        const entry = db.prepare('SELECT run_id, tool_use_id, content FROM log_entries WHERE id = ?').get(eventId);
        if (!entry) return res.status(404).json({ error: 'Log entry not found' });

        if (entry.tool_use_id) {
            // Fetch all entries for this tool_use_id (e.g. use + result)
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


