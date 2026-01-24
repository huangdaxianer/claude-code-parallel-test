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

// 更新心跳
function updateHeartbeat(folderName) {
    if (runningPreviews[folderName]) {
        runningPreviews[folderName].lastHeartbeat = Date.now();
        // 如果有原来的超时逻辑，可以在这里清除或重置，但现在的需求是基于心跳保活
        // 我们假设前端会持续发送心跳
    }
}

// 启动心跳监控 (每1秒检查一次)
function startHeartbeatMonitor() {
    setInterval(async () => {
        const now = Date.now();
        for (const [folderName, info] of Object.entries(runningPreviews)) {
            const timeSinceHeartbeat = now - (info.lastHeartbeat || info.startTime || now);

            // 1. 如果是 Ready 状态，检测心跳 (5s 无心跳则清理)
            if (info.status === 'ready') {
                if (timeSinceHeartbeat > 5000) { // 5s timeout
                    console.log(`[PreviewMonitor] Kill stale READY preview ${folderName} (No heartbeat for ${Math.floor(timeSinceHeartbeat / 1000)}s)`);
                    await forceCleanup(folderName);
                }
            }
            // 2. 如果是 Starting 状态，给予较长宽限期 (10分钟)，防止安装过程被误杀
            // 注意：前端在 starting 阶段通常不发心跳 (因为还没轮询到 ready)，或者轮询到了但还没 ready
            // 所以 starting 阶段主要靠总时长限制
            else if (info.status === 'starting') {
                const timeSinceStart = now - info.startTime;
                if (timeSinceStart > 600000) { // 10 mins
                    console.log(`[PreviewMonitor] Kill stale STARTING preview ${folderName} (Timeout 10m)`);
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
async function findFreePort(start = 4000, end = 5000) {
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

module.exports = {
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
