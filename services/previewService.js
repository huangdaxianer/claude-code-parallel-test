/**
 * 预览服务
 * 管理动态预览的端口分配、进程检测等辅助功能
 */
const { exec, spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 运行中的预览 Map<folderName, { proc, port, url, lastAccess, status, logs }>
const runningPreviews = {};

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

// 递归获取子进程 PID
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
    getListeningPorts,
    probePort,
    detectStartCommand,
    detectProjectType
};
