require('dotenv').config();
console.log("Starting server at " + new Date().toISOString());
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { exec, spawn, execSync } = require('child_process');
const cors = require('cors');
const https = require('https');
const multer = require('multer');
const db = require('./db');
const net = require('net');
const archiver = require('archiver');


const app = express();
const PORT = 3001;

const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
server.timeout = 300000; // 5 minutes timeout for large uploads

const SCRIPT_FILE = path.join(__dirname, 'batch_claude_parallel.sh');
const TASKS_DIR = path.join(__dirname, '../tasks');
const UPLOAD_DIR = path.join(TASKS_DIR, 'temp_uploads');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Default configuration
const defaultConfig = {
    maxParallelSubtasks: 5  // 最大并行子任务数
};

// Load or initialize config
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[Config] Error loading config:', e);
    }
    return { ...defaultConfig };
}

function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('[Config] Error saving config:', e);
    }
}

let appConfig = loadConfig();

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

// Redirect root to login.html
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// ========== User Authentication API ==========

// Login / Register User
app.post('/api/login', (req, res) => {
    const { username } = req.body;
    
    if (!username || typeof username !== 'string') {
        return res.status(400).json({ error: 'Username is required' });
    }
    
    const trimmedUsername = username.trim();
    
    // Validate username format
    if (!/^[a-zA-Z0-9_]+$/.test(trimmedUsername)) {
        return res.status(400).json({ error: 'Username can only contain letters, numbers and underscores' });
    }
    
    if (trimmedUsername.length < 2 || trimmedUsername.length > 50) {
        return res.status(400).json({ error: 'Username must be between 2 and 50 characters' });
    }
    
    try {
        // Check if user exists
        let user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(trimmedUsername);
        
        if (!user) {
            // Create new user
            const result = db.prepare('INSERT INTO users (username) VALUES (?)').run(trimmedUsername);
            // Convert BigInt to Number to ensure JSON serialization works
            user = { id: Number(result.lastInsertRowid), username: trimmedUsername };
            console.log(`[Auth] New user created: ${trimmedUsername} (ID: ${user.id})`);
        } else {
            console.log(`[Auth] User logged in: ${trimmedUsername} (ID: ${user.id})`);
        }
        
        return res.json({ success: true, user });
    } catch (e) {
        console.error('Login error:', e);
        return res.status(500).json({ error: 'Login failed' });
    }
});

// Get current user info
app.get('/api/user/:userId', (req, res) => {
    const { userId } = req.params;
    try {
        const user = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        return res.json({ user });
    } catch (e) {
        console.error('Error fetching user:', e);
        return res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// ========== Task Manager Admin API ==========

// 获取所有任务的管理视图（包含用户信息和队列状态）
app.get('/api/admin/tasks', (req, res) => {
    try {
        const tasks = db.prepare(`
            SELECT 
                t.task_id,
                t.title,
                t.prompt,
                t.base_dir,
                t.user_id,
                t.created_at,
                u.username,
                q.status as queue_status,
                q.started_at,
                q.completed_at
            FROM tasks t
            LEFT JOIN users u ON t.user_id = u.id
            LEFT JOIN task_queue q ON t.task_id = q.task_id
            ORDER BY t.created_at DESC
        `).all();

        // 获取每个任务的模型运行状态
        const tasksWithRuns = tasks.map(task => {
            const runs = db.prepare(`
                SELECT model_name, status, duration, input_tokens, output_tokens
                FROM model_runs 
                WHERE task_id = ?
            `).all(task.task_id);

            return {
                taskId: task.task_id,
                title: task.title,
                prompt: task.prompt,
                baseDir: task.base_dir,
                userId: task.user_id,
                username: task.username || 'Unknown',
                createdAt: task.created_at,
                queueStatus: task.queue_status || 'unknown',
                startedAt: task.started_at,
                completedAt: task.completed_at,
                runs: runs.map(r => ({
                    modelName: r.model_name,
                    status: r.status,
                    duration: r.duration,
                    inputTokens: r.input_tokens,
                    outputTokens: r.output_tokens
                }))
            };
        });

        return res.json(tasksWithRuns);
    } catch (e) {
        console.error('Error fetching admin tasks:', e);
        return res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

// 获取所有用户列表
app.get('/api/admin/users', (req, res) => {
    try {
        const users = db.prepare('SELECT id, username, created_at FROM users ORDER BY created_at DESC').all();
        return res.json(users);
    } catch (e) {
        console.error('Error fetching users:', e);
        return res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// ========== Config API ==========

// 获取系统配置
app.get('/api/admin/config', (req, res) => {
    res.json(appConfig);
});

// 更新系统配置
app.post('/api/admin/config', express.json(), (req, res) => {
    const { maxParallelSubtasks } = req.body;
    
    if (maxParallelSubtasks !== undefined) {
        const value = parseInt(maxParallelSubtasks, 10);
        if (isNaN(value) || value < 1 || value > 50) {
            return res.status(400).json({ error: 'maxParallelSubtasks must be between 1 and 50' });
        }
        appConfig.maxParallelSubtasks = value;
    }
    
    saveConfig(appConfig);
    console.log(`[Config] Updated config:`, appConfig);
    
    // Trigger queue processing in case we increased parallel limit
    setTimeout(processQueue, 100);
    
    res.json(appConfig);
});

// 获取队列状态（用于 Task Manager 显示）
app.get('/api/admin/queue-status', (req, res) => {
    try {
        const runningSubtasks = db.prepare("SELECT COUNT(*) as count FROM model_runs WHERE status = 'running'").get().count;
        const pendingSubtasks = db.prepare("SELECT COUNT(*) as count FROM model_runs WHERE status = 'pending'").get().count;
        
        res.json({
            maxParallelSubtasks: appConfig.maxParallelSubtasks,
            runningSubtasks,
            pendingSubtasks
        });
    } catch (e) {
        console.error('Error fetching queue status:', e);
        res.status(500).json({ error: 'Failed to fetch queue status' });
    }
});

// ========== Task API (with user filtering) ==========

// 获取所有任务 (从数据库读取，支持用户过滤)
app.get('/api/tasks', (req, res) => {
    const { userId } = req.query;
    
    try {
        let tasks;
        if (userId) {
            // Filter tasks by user
            tasks = db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC').all(userId);
        } else {
            // Return all tasks (for backward compatibility, though frontend should always pass userId)
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


const activeSubtaskProcesses = {}; // Map<"taskId/modelName", ChildProcess>
let isProcessingQueue = false;

// Function to process the queue - now at subtask (model_runs) level
async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
        // Count currently running subtasks across ALL users
        const runningCount = db.prepare("SELECT COUNT(*) as count FROM model_runs WHERE status = 'running'").get().count;
        const maxParallel = appConfig.maxParallelSubtasks || 5;

        if (runningCount >= maxParallel) {
            console.log(`[Queue] Max parallel subtasks reached (${runningCount}/${maxParallel})`);
            return;
        }

        // Calculate how many new subtasks we can start
        const availableSlots = maxParallel - runningCount;

        // Fetch pending subtasks ordered by task creation time, then by model_runs id
        // This ensures fair scheduling across all users
        const pendingSubtasks = db.prepare(`
            SELECT mr.id, mr.task_id, mr.model_name, t.title
            FROM model_runs mr
            JOIN tasks t ON mr.task_id = t.task_id
            JOIN task_queue tq ON mr.task_id = tq.task_id
            WHERE mr.status = 'pending' AND tq.status != 'stopped'
            ORDER BY tq.created_at ASC, mr.id ASC
            LIMIT ?
        `).all(availableSlots);

        if (pendingSubtasks.length === 0) {
            return; // No pending subtasks
        }

        console.log(`[Queue] Starting ${pendingSubtasks.length} subtasks (${runningCount}/${maxParallel} running)`);

        // Start each subtask
        for (const subtask of pendingSubtasks) {
            // Update subtask status to running
            db.prepare("UPDATE model_runs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(subtask.id);
            
            // Update parent task queue status to running if not already
            db.prepare("UPDATE task_queue SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE task_id = ?").run(subtask.task_id);

            console.log(`[Queue] Starting subtask: ${subtask.task_id}/${subtask.model_name}`);

            // Execute the subtask (non-blocking)
            executeSubtask(subtask.task_id, subtask.model_name);
        }
    } catch (e) {
        console.error('[Queue] Error processing queue:', e);
    } finally {
        isProcessingQueue = false;
        // Schedule next check
        setTimeout(processQueue, 500);
    }
}

// Function to execute a single model subtask
function executeSubtask(taskId, modelName) {
    const subtaskKey = `${taskId}/${modelName}`;
    
    const SCRIPT_FILE = path.join(__dirname, 'batch_claude_parallel.sh');
    const child = spawn('bash', [SCRIPT_FILE, taskId, modelName], {
        env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
        detached: true
    });

    // Track process
    activeSubtaskProcesses[subtaskKey] = child;

    child.stdout.on('data', (data) => console.log(`[Subtask ${subtaskKey} STDOUT] ${data}`));
    child.stderr.on('data', (data) => console.error(`[Subtask ${subtaskKey} STDERR] ${data}`));

    child.on('error', (err) => {
        console.error(`[Subtask ${subtaskKey} ERROR] Failed to spawn process:`, err);
        // Mark as stopped on error
        db.prepare("UPDATE model_runs SET status = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_name = ?").run(taskId, modelName);
        delete activeSubtaskProcesses[subtaskKey];
        checkAndUpdateTaskStatus(taskId);
        // Trigger queue processing to start next subtask
        setTimeout(processQueue, 100);
    });

    child.on('exit', (code, signal) => {
        console.log(`[Subtask ${subtaskKey} EXIT] Process exited with code ${code} and signal ${signal}`);
        delete activeSubtaskProcesses[subtaskKey];
        
        // Update subtask status based on exit code (if not already updated by ingest.js)
        const currentStatus = db.prepare("SELECT status FROM model_runs WHERE task_id = ? AND model_name = ?").get(taskId, modelName);
        if (currentStatus && currentStatus.status === 'running') {
            // Only update if still running (ingest.js may have already marked it as completed)
            const newStatus = (code === 0) ? 'completed' : 'stopped';
            db.prepare("UPDATE model_runs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_name = ?").run(newStatus, taskId, modelName);
        }
        
        checkAndUpdateTaskStatus(taskId);
        // Trigger queue processing to start next subtask
        setTimeout(processQueue, 100);
    });
}

// Check if all subtasks of a task are done and update task_queue status
function checkAndUpdateTaskStatus(taskId) {
    const subtasks = db.prepare("SELECT status FROM model_runs WHERE task_id = ?").all(taskId);
    
    const allCompleted = subtasks.every(s => s.status === 'completed');
    const allStopped = subtasks.every(s => s.status === 'stopped' || s.status === 'completed');
    const hasRunning = subtasks.some(s => s.status === 'running');
    const hasPending = subtasks.some(s => s.status === 'pending');

    if (allCompleted) {
        db.prepare("UPDATE task_queue SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE task_id = ?").run(taskId);
        console.log(`[Queue] Task ${taskId} completed (all subtasks done)`);
    } else if (allStopped && !hasRunning && !hasPending) {
        db.prepare("UPDATE task_queue SET status = 'stopped', completed_at = CURRENT_TIMESTAMP WHERE task_id = ?").run(taskId);
        console.log(`[Queue] Task ${taskId} stopped (all subtasks stopped or completed)`);
    } else if (hasRunning || hasPending) {
        // Task still has work to do, ensure it's marked as running
        db.prepare("UPDATE task_queue SET status = 'running' WHERE task_id = ? AND status != 'running'").run(taskId);
    }
}

// Legacy compatibility: keep activeTaskProcesses as alias
const activeTaskProcesses = activeSubtaskProcesses;

app.post('/api/tasks', (req, res) => {
    const task = req.body.task;
    if (!task || !task.taskId) {
        return res.status(400).json({ error: 'Invalid task format' });
    }

    // 0. Base setup
    let finalBaseDir = task.baseDir;
    const taskDir = path.join(TASKS_DIR, task.taskId);

    // 1.5 处理增量开发：如果指定了 srcTaskId，则从该任务目录复制文件作为新任务的 source
    if (task.srcTaskId) {
        let srcTaskDir = path.join(TASKS_DIR, task.srcTaskId);
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

    // 1. (Delayed) 写入数据库记录 - Now saving the UPDATED baseDir and user_id
    console.log(`[Task Create] taskId=${task.taskId}, userId=${task.userId}, typeof userId=${typeof task.userId}`);
    try {
        const insertTask = db.prepare('INSERT INTO tasks (task_id, title, prompt, base_dir, user_id) VALUES (?, ?, ?, ?, ?)');
        insertTask.run(task.taskId, task.title, task.prompt, task.baseDir, task.userId || null);

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

    // 3. (Refactored) Push to Task Queue instead of spawning immediately
    try {
        db.prepare("INSERT INTO task_queue (task_id, status) VALUES (?, 'pending')").run(task.taskId);
        console.log(`[ID: ${task.taskId}] Added to execution queue`);

        // Trigger queue processor (fire and forget)
        processQueue();

    } catch (e) {
        console.error('Error adding to task queue:', e);
        return res.status(500).json({ error: 'Failed to queue task' });
    }

    /* 
    // OLD SPAWN LOGIC REMOVED
    */

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

// Helper: Detect project type
async function detectProjectType(projectPath) {
    if (fs.existsSync(path.join(projectPath, 'package.json'))) return 'node';
    if (fs.existsSync(path.join(projectPath, 'pom.xml'))) return 'java';

    // Check subfolders frequently used in our monorepos for Java
    if (fs.existsSync(path.join(projectPath, 'backend', 'pom.xml'))) return 'java';
    // Check subfolders for Node (e.g. monorepo root might just have folders)
    if (fs.existsSync(path.join(projectPath, 'server', 'package.json'))) return 'node';
    if (fs.existsSync(path.join(projectPath, 'web', 'package.json'))) return 'node';
    if (fs.existsSync(path.join(projectPath, 'frontend', 'package.json'))) return 'node';

    // Check for simple HTML
    try {
        const files = fs.readdirSync(projectPath);
        if (files.some(f => f.endsWith('.html'))) return 'html';
    } catch (e) {
        // ignore error if read fails
    }

    return 'unknown';
}

// API: Get Project Type
app.get('/api/project/type/:taskId/:modelName', async (req, res) => {
    const { taskId, modelName } = req.params;
    const projectPath = path.join(TASKS_DIR, taskId, modelName);

    if (!fs.existsSync(projectPath)) {
        return res.json({ type: 'unknown', previewable: false });
    }

    const type = await detectProjectType(projectPath);
    // Currently only node projects are supported for preview
    const previewable = (type === 'node' || type === 'html');

    res.json({ type, previewable });
});

// Preview API
app.post('/api/preview/start', async (req, res) => {
    const { taskId, modelName } = req.body;
    if (!taskId || !modelName) return res.status(400).json({ error: 'Missing params' });

    const folderName = `${taskId}/${modelName}`;
    const projectPath = path.join(TASKS_DIR, taskId, modelName);

    // 0. Enforce Single Active Preview Policy: Kill others
    const runningKeys = Object.keys(runningPreviews);
    for (const key of runningKeys) {
        if (key !== folderName) {
            const info = runningPreviews[key];
            console.log(`[Preview] Switching context: Stopping ${key} (PID ${info.proc.pid})`);

            // Attempt to kill process tree to avoid zombies
            // We don't await this because we want to start the new one immediately
            // and the port allocator will find a new random port anyway.
            (async () => {
                try {
                    const children = await getChildPids(info.proc.pid);
                    children.forEach(pid => {
                        try { process.kill(pid, 'SIGTERM'); } catch (e) { }
                    });
                    info.proc.kill('SIGTERM');
                } catch (e) {
                    console.error(`[Preview] Error killing ${key}:`, e);
                }
            })();

            // Mark as dying so we don't accidentally return it
            delete runningPreviews[key];
        }
    }

    // 1. Check if folder exists
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        return res.json({ type: 'static', url: `/artifacts/${folderName}/index.html` });
    }

    // 1.5 Check Project Type: If static HTML, serve directly!
    const projectType = await detectProjectType(projectPath);
    if (projectType === 'html') {
        console.log(`[Preview] Detected static HTML project for ${folderName}. Serving directly.`);
        // Find the "best" html file (index.html or the first one found)
        let mainFile = 'index.html';
        try {
            const files = fs.readdirSync(projectPath);
            const htmlFiles = files.filter(f => f.endsWith('.html'));
            if (htmlFiles.length > 0) {
                if (htmlFiles.includes('index.html')) mainFile = 'index.html';
                else mainFile = htmlFiles[0];
            }
        } catch (e) { }
        return res.json({ type: 'static', url: `/artifacts/${folderName}/${mainFile}` });
    }

    // 2. Check if already running or starting
    if (runningPreviews[folderName]) {
        const info = runningPreviews[folderName];
        if (info.status === 'ready') {
            try {
                // Check if process exists
                process.kill(info.proc.pid, 0);
                runningPreviews[folderName].lastAccess = Date.now();
                return res.json({ type: 'server', url: runningPreviews[folderName].url });
            } catch (e) {
                delete runningPreviews[folderName]; // Process dead
            }
        } else if (info.status === 'starting') {
            // If currently starting, client should assume it's in progress.
            // We can't easily "join" the existing response stream here in this simple architecture,
            // but the client will be polling the status endpoint anyway.
            // We'll let this request wait or return "pending".
            // For simplicity, let's just proceed to try starting (race condition handling needed?
            // Ideally we shouldn't start two at once.
            // Let's block duplicate starts.
            return res.status(409).json({ error: 'Preview is already starting' });
        }
    }

    // Initialize status tracking
    runningPreviews[folderName] = {
        status: 'starting',
        logs: [{ msg: 'Initializing preview environment...', ts: Date.now() }],
        startTime: Date.now()
    };

    const addLog = (msg) => {
        if (runningPreviews[folderName]) {
            runningPreviews[folderName].logs.push({ msg, ts: Date.now() });
        }
    };

    try {
        const allocatedPort = await findFreePort();
        addLog(`Allocated internal port: ${allocatedPort}`);

        // Install deps if needed
        if (fs.existsSync(path.join(projectPath, 'package.json')) && !fs.existsSync(path.join(projectPath, 'node_modules'))) {
            addLog('Installing dependencies (npm install)...');
            await new Promise((resolve, reject) => {
                exec('npm install', { cwd: projectPath }, (err) => err ? reject(err) : resolve());
            });
            addLog('Dependencies installed.');
        }

        const { cmd, args } = await detectStartCommand(projectPath);
        addLog(`Starting process: ${cmd} ${args.join(' ')}`);
        console.log(`[Preview] Starting ${folderName} using ${cmd} ${args.join(' ')} (Allocated: ${allocatedPort})`);

        const child = spawn(cmd, args, {
            cwd: projectPath,
            env: { ...process.env, PORT: allocatedPort, HOST: '0.0.0.0' },
            detached: false
        });

        // Store proc temporarily even if not ready, for cleanup on error
        runningPreviews[folderName].proc = child;

        child.stdout.on('data', d => console.log(`[P ${folderName}] ${d}`.trim()));
        child.stderr.on('data', d => console.error(`[P ${folderName} ERR] ${d}`.trim()));

        // --- Multi-port Scanning Strategy ---
        const MAX_RETRIES = 30; // 30 seconds
        let retries = 0;
        let bestCandidate = null;

        addLog('Scanning for service ports...');

        const scanInterval = setInterval(async () => {
            retries++;

            // 1. Find PIDs
            const childPids = await getChildPids(child.pid);
            const pids = [child.pid, ...childPids];

            // 2. Find Ports
            const ports = await getListeningPorts(pids);

            if (ports.length > 0) {
                addLog(`Detected ports: ${ports.join(', ')}. Probing...`);

                // 3. Probe Ports
                const results = await Promise.all(ports.map(probePort));
                // Sort: Frontend (HTML) > Backend (JSON) > Unknown
                results.sort((a, b) => b.score - a.score);

                const best = results[0];
                if (best && best.score > 0) {
                    if (best.serviceType === 'frontend') {
                        // Found HTML! Resolve immediately.
                        addLog(`Success! Frontend found at port ${best.port}`);
                        console.log(`[Preview] Found Frontend at port ${best.port}`);
                        clearInterval(scanInterval);
                        finish(best.port);
                        return;
                    }

                    // Keep track of best candidate
                    if (!bestCandidate || best.score > bestCandidate.score) {
                        bestCandidate = best;
                        addLog(`Found candidate service: ${best.serviceType} at port ${best.port}. Continuing scan for frontend...`);
                    }
                }
            } else {
                if (retries % 3 === 0) addLog(`Waiting for ports... (Active PIDs: ${pids.length})`);
            }

            if (retries >= MAX_RETRIES) {
                clearInterval(scanInterval);
                if (bestCandidate) {
                    // Check if still valid before finishing
                    if (runningPreviews[folderName]) {
                        addLog(`Timeout. Falling back to ${bestCandidate.serviceType} at ${bestCandidate.port}`);
                        console.log(`[Preview] Timeout. Fallback to best candidate: ${bestCandidate.port} (${bestCandidate.serviceType})`);
                        finish(bestCandidate.port);
                    }
                } else {
                    if (runningPreviews[folderName]) {
                        addLog('Timeout. No usable ports found.');
                        // Fail
                        runningPreviews[folderName].status = 'error';
                        if (!res.headersSent) res.status(500).json({ error: 'Timeout: Service started but no accessible ports detected.' });
                        try { child.kill(); } catch (e) { }
                        delete runningPreviews[folderName];
                    }
                }
            }
        }, 1000);

        function finish(finalPort) {
            // Guard clause: If preview was deleted (e.g. by context switch), abort
            if (!runningPreviews[folderName]) return;

            const url = `http://localhost:${finalPort}`;
            // Update existing entry
            Object.assign(runningPreviews[folderName], {
                status: 'ready',
                port: finalPort,
                url,
                lastAccess: Date.now()
            });
            if (!res.headersSent) res.json({ type: 'server', url });
        }

        child.on('exit', (code) => {
            console.log(`[Preview ${folderName}] Child process ${child.pid} exited with code ${code}`);
            addLog(`Process exited with code ${code}`);
            clearInterval(scanInterval);

            // Only update status if the entry still exists (it might have been deleted by context switch)
            if (runningPreviews[folderName]) {
                if (code !== 0 && code !== null) {
                    runningPreviews[folderName].status = 'error';
                    if (!res.headersSent) res.status(500).json({ error: `Process exited with code ${code}` });
                    // Clean up after error response
                    setTimeout(() => { if (runningPreviews[folderName]) delete runningPreviews[folderName]; }, 5000);
                } else {
                    delete runningPreviews[folderName];
                }
            }
        });

    } catch (err) {
        console.error(`[Preview] Failed: ${err.message}`);
        addLog(`Error: ${err.message}`);
        if (runningPreviews[folderName]) runningPreviews[folderName].status = 'error';

        if (!res.headersSent) res.json({ type: 'static', url: `/artifacts/${folderName}/index.html`, warning: err.message });
    }
});

// New: Get preview status and logs
app.get('/api/preview/status/:taskId/:modelName', (req, res) => {
    const { taskId, modelName } = req.params;
    const folderName = `${taskId}/${modelName}`;

    const previewInfo = runningPreviews[folderName];

    if (previewInfo) {
        // Return a copy to prevent external modification of internal state
        const { proc, ...infoToSend } = previewInfo; // Exclude 'proc'
        res.json(infoToSend);
    } else {
        res.status(404).json({ status: 'not_running', logs: [{ msg: 'Preview not running.', ts: Date.now() }] });
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
                    previewable: !!run.previewable, // Convert 0/1 to boolean
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
    }
});

// 停止任务（支持按模型停止）
app.post('/api/tasks/:taskId/stop', async (req, res) => {
    const { taskId } = req.params;
    const { modelName } = req.body || {};
    
    if (modelName) {
        // 按模型停止
        console.log(`[Control] Stopping model ${modelName} for task ${taskId}`);
        
        // 1. Kill specific model's claude process
        const modelDir = path.join(TASKS_DIR, taskId, modelName);
        try {
            // 使用多种方式尝试杀掉 claude 进程
            // 方法1: 使用 pkill 匹配目录路径
            try {
                execSync(`pkill -9 -f "${modelDir}" 2>/dev/null || true`, { timeout: 5000 });
            } catch (e) { /* ignore */ }
            
            // 方法2: 使用 ps + grep + kill 更精确地查找并杀掉
            try {
                const pids = execSync(`ps aux | grep -E "claude.*${taskId}.*${modelName}" | grep -v grep | awk '{print $2}'`, { timeout: 5000 }).toString().trim();
                if (pids) {
                    pids.split('\n').forEach(pid => {
                        if (pid) {
                            try { execSync(`kill -9 ${pid} 2>/dev/null || true`); } catch (e) { /* ignore */ }
                        }
                    });
                }
            } catch (e) { /* ignore */ }
            
            // 方法3: 杀掉 ingest 进程
            try {
                execSync(`pkill -9 -f "ingest.js ${taskId} ${modelName}" 2>/dev/null || true`, { timeout: 5000 });
            } catch (e) { /* ignore */ }
            
            console.log(`[Control] Kill commands executed for model ${modelName}`);
        } catch (e) {
            console.log(`[Control] pkill for model ${modelName} completed (may have found no processes)`);
        }
        
        // 2. Update only this model's status in DB
        try {
            db.prepare("UPDATE model_runs SET status = 'stopped' WHERE task_id = ? AND model_name = ? AND status = 'running'").run(taskId, modelName);
            
            // Remove from active processes
            const subtaskKey = `${taskId}/${modelName}`;
            delete activeSubtaskProcesses[subtaskKey];
            
            // Check and update parent task status
            checkAndUpdateTaskStatus(taskId);
        } catch (e) {
            console.error('Error updating DB for model stop:', e);
            return res.status(500).json({ error: 'Failed to update model status' });
        }
    } else {
        // 停止整个任务（所有子任务）
        console.log(`[Control] Stopping entire task ${taskId}`);

        // 1. Kill all active subtask processes for this task
        const taskDir = path.join(TASKS_DIR, taskId);
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
        
        // Also try to kill any loose claude processes for this task
        try {
            execSync(`pkill -f "claude.*${taskDir}" 2>/dev/null || true`, { timeout: 5000 });
            console.log(`[Control] Attempted to kill loose processes for ${taskId}`);
        } catch (e) {
            // Ignore errors
        }

        // 2. Update DB status - stop all running and pending subtasks
        try {
            db.prepare("UPDATE task_queue SET status = 'stopped', completed_at = CURRENT_TIMESTAMP WHERE task_id = ?").run(taskId);
            db.prepare("UPDATE model_runs SET status = 'stopped' WHERE task_id = ? AND status IN ('running', 'pending')").run(taskId);
        } catch (e) {
            console.error('Error updating DB for stop:', e);
            return res.status(500).json({ error: 'Failed to update task status' });
        }
    }

    res.json({ success: true });
});

// 启动任务 (重试/恢复) - 支持针对特定模型的重启
app.post('/api/tasks/:taskId/start', (req, res) => {
    const { taskId } = req.params;
    const { modelName } = req.body || {};
    console.log(`[Control] Starting task ${taskId}${modelName ? ` for model ${modelName}` : ''}`);

    try {
        if (modelName) {
            // 针对特定模型的重启
            console.log(`[Control] Restarting model ${modelName} for task ${taskId}`);
            
            const modelRun = db.prepare("SELECT id, status FROM model_runs WHERE task_id = ? AND model_name = ?").get(taskId, modelName);
            if (!modelRun) {
                console.log(`[Control] Model ${modelName} not found`);
                return res.status(404).json({ error: `Model ${modelName} not found for task ${taskId}` });
            }
            
            if (modelRun.status === 'running') {
                console.log(`[Control] Model ${modelName} is still running`);
                return res.status(400).json({ error: `Model ${modelName} is already running` });
            }
            
            console.log(`[Control] Model ${modelName} found with id ${modelRun.id}, status: ${modelRun.status}`);

            // 1. 删除该模型的 log_entries 记录
            const deleteResult = db.prepare("DELETE FROM log_entries WHERE run_id = ?").run(modelRun.id);
            console.log(`[Control] Deleted ${deleteResult.changes} log entries for model ${modelName}`);

            // 2. 重置该模型的统计数据和状态
            db.prepare(`
                UPDATE model_runs SET 
                    status = 'pending',
                    duration = NULL,
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
                WHERE task_id = ? AND model_name = ?
            `).run(taskId, modelName);
            console.log(`[Control] Reset model run stats for ${modelName}`);

            // 3. 删除该模型的运行结果文件夹
            const modelDir = path.join(TASKS_DIR, taskId, modelName);
            console.log(`[Control] Checking model directory: ${modelDir}`);
            if (fs.existsSync(modelDir)) {
                fs.rmSync(modelDir, { recursive: true, force: true });
                console.log(`[Control] Deleted model directory: ${modelDir}`);
            } else {
                console.log(`[Control] Model directory does not exist: ${modelDir}`);
            }

            // 4. 删除该模型的日志文件
            const logFile = path.join(TASKS_DIR, taskId, `${modelName}.txt`);
            console.log(`[Control] Checking log file: ${logFile}`);
            if (fs.existsSync(logFile)) {
                fs.unlinkSync(logFile);
                console.log(`[Control] Deleted log file: ${logFile}`);
            } else {
                console.log(`[Control] Log file does not exist: ${logFile}`);
            }
        } else {
            // 整个任务重启时，检查是否有任何子任务在运行
            const runningSubtasks = db.prepare("SELECT COUNT(*) as count FROM model_runs WHERE task_id = ? AND status = 'running'").get(taskId);
            if (runningSubtasks.count > 0) {
                return res.status(400).json({ error: 'Some subtasks are still running. Stop them first or restart individual models.' });
            }
            // 原有逻辑：重置所有非已完成的模型
            db.prepare("UPDATE model_runs SET status = 'pending' WHERE task_id = ? AND status != 'completed'").run(taskId);
        }

        // Reset task queue status
        db.prepare("UPDATE task_queue SET status = 'pending', started_at = NULL, completed_at = NULL WHERE task_id = ?").run(taskId);

        // Trigger Queue
        processQueue();

        res.json({ success: true });
    } catch (e) {
        console.error('Error starting task:', e);
        res.status(500).json({ error: 'Failed to start task' });
    }
});

// 删除任务
app.delete('/api/tasks/:taskId', (req, res) => {
    const { taskId } = req.params;

    try {
        // Delete from all tables
        db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
        db.prepare('DELETE FROM model_runs WHERE task_id = ?').run(taskId);
        db.prepare('DELETE FROM task_queue WHERE task_id = ?').run(taskId);
    } catch (e) {
        console.error('Error deleting task from DB:', e);
        return res.status(500).json({ error: 'Failed to delete task from database' });
    }

    // 2. 删除目录
    const taskDir = path.join(TASKS_DIR, taskId);

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
app.get('/api/tasks/:taskId/download', (req, res) => {
    const { taskId } = req.params;
    const taskDir = path.join(TASKS_DIR, taskId);

    if (!fs.existsSync(taskDir)) {
        return res.status(404).json({ error: 'Task directory not found' });
    }

    // Set headers
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="task_${taskId}.zip"`);

    const archive = archiver('zip', {
        zlib: { level: 9 } // Maximum compression
    });

    // Handle archive errors
    archive.on('error', (err) => {
        console.error('[Download] Archive error:', err);
        // We can't really send a 500 here if headers were already sent,
        // but express handles piped errors decently.
        res.status(500).send({ error: err.message });
    });

    // Pipe archive data to the response
    archive.pipe(res);

    // Append files from task directory
    archive.directory(taskDir, false);

    // Finalize the archive
    archive.finalize();
});

// Legacy calculateLogStats removed as it is now handled by ingest.js or migrate.js

// Batch Tasks Upload Endpoint
app.post('/api/batch_tasks', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No CSV file uploaded' });
    }

    const tasksCreated = [];
    const fs = require('fs');
    const crypto = require('crypto');

    try {
        const content = fs.readFileSync(req.file.path, 'utf8');
        // Split by newlines, trim, and filter empty lines
        const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

        const baseModels = ["potato", "tomato", "strawberry", "watermelon", "banana", "avocado", "cherry", "pineapple"];

        const insertTask = db.prepare('INSERT INTO tasks (task_id, title, prompt, base_dir) VALUES (?, ?, ?, ?)');
        const insertRun = db.prepare('INSERT INTO model_runs (task_id, model_name, status) VALUES (?, ?, ?)');
        const insertQueue = db.prepare("INSERT INTO task_queue (task_id, status) VALUES (?, 'pending')");

        // Use transaction for consistency
        const processBatch = db.transaction((lines) => {
            lines.forEach((prompt, index) => {
                const taskId = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 chars
                const title = `Batch Task ${index + 1}`; // Temporary title

                // 1. Create Task
                insertTask.run(taskId, title, prompt, null); // Base dir null for pure batch prompt

                // 2. Create Runs
                baseModels.forEach(m => insertRun.run(taskId, m, 'pending'));

                // 3. Add to Queue
                insertQueue.run(taskId);

                tasksCreated.push(taskId);

                // Async Title Generation
                generateTitle(prompt).then(aiTitle => {
                    try {
                        db.prepare('UPDATE tasks SET title = ? WHERE task_id = ?').run(aiTitle, taskId);
                    } catch (e) { }
                });
            });
        });

        processBatch(lines);

        // Trigger queue
        processQueue();

        res.json({ success: true, count: lines.length, tasks: tasksCreated });

    } catch (e) {
        console.error('Batch upload error:', e);
        res.status(500).json({ error: 'Failed to process batch file' });
    } finally {
        // Cleanup uploaded file
        try { fs.unlinkSync(req.file.path); } catch (e) { }
    }
});

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



// Start queue processing on server start
processQueue();

// Error handling to ensure queue resilience
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (!isProcessingQueue) setTimeout(processQueue, 1000);
});
