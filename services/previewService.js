/**
 * 预览服务
 * 管理动态预览的端口分配、进程检测等辅助功能
 */
const { exec, spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 运行中的预览 Map<folderName, { proc, port, url, lastAccess, status, logs, timeoutId, lastHeartbeat }>
const runningPreviews = {};

// 任务级别的心跳记录 Map<taskId, lastHeartbeatTime>
const lastTaskHeartbeats = {};

// 更新心跳
function updateHeartbeat(folderName) {
    if (runningPreviews[folderName]) {
        runningPreviews[folderName].lastHeartbeat = Date.now();

        // 提取 taskId 并更新任务级心跳
        const taskId = folderName.split('/')[0];
        lastTaskHeartbeats[taskId] = Date.now();
    }
}

// 启动心跳监控 (每1秒检查一次)
function startHeartbeatMonitor() {
    console.error("[Monitor] Starting Heartbeat Monitor...");
    setInterval(async () => {
        const now = Date.now();
        console.error(`[MonitorPulse] ${new Date().toISOString()} | Previews: ${Object.keys(runningPreviews).length}`);
        const folderNames = Object.keys(runningPreviews);
        if (folderNames.length > 0) {
            console.error(`[Monitor] Checking ${folderNames.length} previews: ${folderNames.join(', ')}`);
        }
        for (const [folderName, info] of Object.entries(runningPreviews)) {
            // 提取 taskId
            const taskId = folderName.split('/')[0];
            const taskHeartbeat = lastTaskHeartbeats[taskId] || info.lastHeartbeat || info.startTime || now;
            const timeSinceTaskHeartbeat = now - taskHeartbeat;

            // 1. 如果是 Ready 状态，检测任务级心跳 (5s 无心跳则清理)
            if (info.status === 'ready') {
                if (timeSinceTaskHeartbeat > 5000) { // 5s timeout
                    console.error(`[PreviewMonitor] Kill stale READY preview ${folderName} (Task ${taskId} idle for ${Math.floor(timeSinceTaskHeartbeat / 1000)}s)`);
                    await forceCleanup(folderName);
                }
            }
            // 2. 如果是 Starting 状态，给予较长宽限期 (10分钟)
            else if (info.status === 'starting') {
                const timeSinceStart = now - (info.startTime || now);
                if (timeSinceStart > 600000) { // 10 mins
                    console.error(`[PreviewMonitor] Kill stale STARTING preview ${folderName} (Timeout 10m)`);
                    await forceCleanup(folderName);
                }
            }
        }
    }, 1000); // Check every 1s
}

async function forceCleanup(folderName) {
    const info = runningPreviews[folderName];
    if (info) {
        // 1. Kill by PID (if attached)
        if (info.proc && info.proc.pid) {
            await killProcessTree(info.proc.pid);
        }
        // 2. Kill by Port (if detached)
        if (info.port) {
            await killProcessOnPort(info.port);
        }
        delete runningPreviews[folderName];
    }
}

// Start the monitor immediately
startHeartbeatMonitor();

// 已分配的端口集合
const allocatedPorts = new Set();

// 检查端口是否被占用
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

// 查找空闲端口
const config = require('../config');
async function findFreePort(start = config.PREVIEW_PORT_START, end = config.PREVIEW_PORT_END) {
    for (let p = start; p <= end; p++) {
        if (allocatedPorts.has(p)) continue;
        if (!(await checkPort(p))) {
            allocatedPorts.add(p);
            setTimeout(() => allocatedPorts.delete(p), 30000);
            return p;
        }
    }
    throw new Error('No free ports available');
}

// 递归获取所有子进程 PID
async function getAllPids(pid) {
    const pids = [pid];
    try {
        const children = await getChildPids(pid);
        for (const child of children) {
            const grandChildren = await getAllPids(child);
            pids.push(...grandChildren);
        }
    } catch (e) { }
    return Array.from(new Set(pids));
}

// 彻底杀死进程树
async function killProcessTree(pid) {
    console.log(`[Preview] Killing process tree for PID ${pid}`);
    const pids = await getAllPids(pid);
    // 从后往前杀（叶子节点先杀）
    for (const p of pids.reverse()) {
        try {
            process.kill(p, 'SIGKILL');
        } catch (e) { }
    }
}

// 杀死指定端口的进程
function killProcessOnPort(port) {
    return new Promise((resolve) => {
        if (!port) return resolve();
        console.log(`[Preview] Killing process on port ${port}`);
        exec(`lsof -t -i:${port}`, (err, stdout) => {
            if (err || !stdout) return resolve();
            const pids = stdout.trim().split(/\s+/);
            for (const pid of pids) {
                try {
                    process.kill(pid, 'SIGKILL');
                } catch (e) { }
            }
            resolve();
        });
    });
}

// 递归获取子进程 PID (pgrep -P)
function getChildPids(pid) {
    return new Promise((resolve) => {
        exec(`pgrep -P ${pid}`, (err, stdout) => {
            if (err || !stdout) return resolve([]);
            const pids = stdout.trim().split(/\s+/).map(p => parseInt(p, 10));
            resolve(pids);
        });
    });
}

// 获取 PIDs 监听的端口
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

// 探测端口服务类型
async function probePort(port) {
    return new Promise(resolve => {
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

// 检测启动命令
async function detectStartCommand(projectPath) {
    // 1. Check for Node.js
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const scripts = pkg.scripts || {};
            // Prioritize explicit start scripts
            if (scripts.start) return { type: 'node', cmd: 'npm', args: ['run', 'start'] };
            if (scripts.dev) return { type: 'node', cmd: 'npm', args: ['run', 'dev'] };
            if (scripts.server) return { type: 'node', cmd: 'npm', args: ['run', 'server'] };
        } catch (e) {
            console.warn(`[Preview] Failed to parse package.json: ${e.message}`);
        }
    }

    // Check for common Node entry points if no package.json scripts found
    const commonNodeEntries = ['server.js', 'app.js', 'index.js', 'main.js'];
    for (const entry of commonNodeEntries) {
        if (fs.existsSync(path.join(projectPath, entry))) {
            return { type: 'node', cmd: 'node', args: [entry] };
        }
    }

    // 2. Check for Python
    // Streamlit
    // specific check: look for "streamlit" in requirements.txt or *.py files importing it? 
    // For speed, we just check existence of common files or requirements.
    const requirementsPath = path.join(projectPath, 'requirements.txt');
    let hasStreamlit = false;
    let hasGradio = false;
    let hasFlask = false;
    let hasDjango = false;

    if (fs.existsSync(requirementsPath)) {
        const reqContent = fs.readFileSync(requirementsPath, 'utf8').toLowerCase();
        if (reqContent.includes('streamlit')) hasStreamlit = true;
        if (reqContent.includes('gradio')) hasGradio = true;
        if (reqContent.includes('flask')) hasFlask = true;
        if (reqContent.includes('django')) hasDjango = true;
    }

    // Attempt to find main python file
    const files = fs.readdirSync(projectPath);
    const pythonFiles = files.filter(f => f.endsWith('.py'));

    // Simple heuristic: if there's an app.py or main.py, it's a strong candidate
    const mainPy = pythonFiles.find(f => ['app.py', 'main.py', 'server.py', 'web.py'].includes(f.toLowerCase())) || pythonFiles[0];

    // If requirements.txt didn't give us a clue, scan the main file content
    if (mainPy && !hasStreamlit && !hasGradio && !hasFlask && !hasDjango) {
        try {
            const mainContent = fs.readFileSync(path.join(projectPath, mainPy), 'utf8').toLowerCase();
            if (mainContent.includes('import streamlit') || mainContent.includes('from streamlit')) hasStreamlit = true;
            if (mainContent.includes('import gradio') || mainContent.includes('from gradio')) hasGradio = true;
            if (mainContent.includes('import flask') || mainContent.includes('from flask')) hasFlask = true;
            if (mainContent.includes('import django') || mainContent.includes('from django')) hasDjango = true;
        } catch (e) { }
    }

    // Detect Virtual Environment
    let pythonCmd = 'python3';
    if (fs.existsSync(path.join(projectPath, 'venv/bin/python'))) {
        pythonCmd = path.join(projectPath, 'venv/bin/python');
    } else if (fs.existsSync(path.join(projectPath, '.venv/bin/python'))) {
        pythonCmd = path.join(projectPath, '.venv/bin/python');
    }

    if (mainPy) {
        if (hasStreamlit) {
            return { type: 'python', cmd: 'streamlit', args: ['run', mainPy, '--server.port', '{PORT}', '--server.headless', 'true'] };
        }

        if (hasFlask) {
            return {
                type: 'python',
                cmd: pythonCmd,
                args: ['-m', 'flask', 'run', '--host=0.0.0.0', '--port={PORT}'],
                env: { FLASK_APP: mainPy, FLASK_DEBUG: '1' }
            };
        }

        if (hasGradio) {
            return { type: 'python', cmd: pythonCmd, args: [mainPy], env: { GRADIO_SERVER_PORT: '{PORT}', GRADIO_SERVER_NAME: '0.0.0.0' } };
        }
        if (hasDjango && fs.existsSync(path.join(projectPath, 'manage.py'))) {
            return { type: 'python', cmd: pythonCmd, args: ['manage.py', 'runserver', '0.0.0.0:{PORT}'] };
        }
        // Generic python fallback 
        return { type: 'python', cmd: pythonCmd, args: [mainPy] };
    }

    // 3. Java (basic support)
    if (fs.existsSync(path.join(projectPath, 'pom.xml'))) {
        return { type: 'java', cmd: 'mvn', args: ['spring-boot:run', '-Dserver.port={PORT}'] };
    }

    return null;
}

// 检测项目类型
async function detectProjectType(projectPath) {
    if (fs.existsSync(path.join(projectPath, 'package.json'))) return 'node';
    if (fs.existsSync(path.join(projectPath, 'pom.xml'))) return 'java';

    if (fs.existsSync(path.join(projectPath, 'backend', 'pom.xml'))) return 'java';
    if (fs.existsSync(path.join(projectPath, 'server', 'package.json'))) return 'node';
    if (fs.existsSync(path.join(projectPath, 'web', 'package.json'))) return 'node';
    if (fs.existsSync(path.join(projectPath, 'frontend', 'package.json'))) return 'node';

    try {
        const files = fs.readdirSync(projectPath);
        if (files.some(f => f.endsWith('.html'))) return 'html';
    } catch (e) {
        // ignore
    }

    return 'unknown';
}

/**
 * 确保存在隔离的预览路径
 * @param {string} originalPath 原始路径
 * @returns {string} 隔离路径
 */
function ensureIsolatedPath(originalPath) {
    const parentDir = path.dirname(originalPath);
    const baseName = path.basename(originalPath);
    const isolatedPath = path.join(parentDir, `${baseName}_preview`);

    try {
        if (!fs.existsSync(isolatedPath)) {
            console.log(`[Preview] Creating isolated path: ${isolatedPath}`);
            const { execSync } = require('child_process');
            execSync(`cp -R "${originalPath}/" "${isolatedPath}"`);
        } else {
            console.log(`[Preview] Syncing isolated path: ${isolatedPath}`);
            const { execSync } = require('child_process');
            // Use rsync for faster sync, excluding heavy folders
            try {
                execSync(`rsync -a --delete --exclude 'venv' --exclude '.venv' --exclude 'node_modules' "${originalPath}/" "${isolatedPath}"`);
            } catch (rsyncErr) {
                // Background fallback to cp if rsync fails
                execSync(`cp -R "${originalPath}/" "${isolatedPath}"`);
            }
        }
        return isolatedPath;
    } catch (e) {
        console.error(`[Preview] Failed to isolate path: ${e.message}`);
        return originalPath;
    }
}

module.exports = {
    ensureIsolatedPath,
    runningPreviews,
    checkPort,
    findFreePort,
    getChildPids,
    getAllPids,
    killProcessTree,
    killProcessOnPort,
    getListeningPorts,
    probePort,
    detectStartCommand,
    detectStartCommand,
    detectProjectType,
    updateHeartbeat
};
