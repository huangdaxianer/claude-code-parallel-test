/**
 * 预览服务路由
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { exec, spawn, execSync } = require('child_process');
const config = require('../config');
const previewService = require('../services/previewService');

function getFileStructure(dir, depth = 0, maxDepth = 3) {
    let result = '';
    const prefix = '  '.repeat(depth);
    try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        // 排序：文件夹在前，文件在后
        items.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
        });

        for (const item of items) {
            // 忽略隐藏文件和常见的大目录
            if (item.name.startsWith('.') ||
                ['node_modules', 'dist', 'build', 'coverage', 'target', '__pycache__'].includes(item.name)) {
                continue;
            }

            if (item.isDirectory()) {
                result += `${prefix}${item.name}/\n`;
                if (depth < maxDepth) {
                    result += getFileStructure(path.join(dir, item.name), depth + 1, maxDepth);
                }
            } else {
                result += `${prefix}${item.name}\n`;
            }
        }
    } catch (e) {
        // 忽略错误
    }
    return result;
}

// 获取项目类型
router.get('/project/type/:taskId/:modelName', async (req, res) => {
    const { taskId, modelName } = req.params;
    const projectPath = path.join(config.TASKS_DIR, taskId, modelName);

    if (!fs.existsSync(projectPath)) {
        return res.json({ type: 'unknown', previewable: false });
    }

    const type = await previewService.detectProjectType(projectPath);
    // 现在的逻辑：只要文件夹存在，就允许尝试预览（通过 Claude Code）
    const previewable = true;

    res.json({ type, previewable });
});

// 静态文件代理服务
router.use('/view/:taskId/:modelName', (req, res, next) => {
    const { taskId, modelName } = req.params;
    // req.path will contain the rest of the path after mounting point
    const filePath = req.path;

    // Determine absolute path
    const projectPath = path.join(config.TASKS_DIR, taskId, modelName);
    const absolutePath = path.join(projectPath, filePath);

    // Prevent directory traversal
    if (!absolutePath.startsWith(projectPath)) {
        return res.status(403).send('Access Denied');
    }

    if (fs.existsSync(absolutePath)) {
        // Only sending file if it exists, otherwise pass to 404
        return res.sendFile(absolutePath);
    }

    // If not found as file, it might be a directory or next route?
    // For this use case, we just 404 if file is missing in this static view scope
    res.status(404).send('File not found');
});

const db = require('../db'); // Ensure DB imported

// ... (other imports)

// 启动预览
router.post('/start', async (req, res) => {
    const { taskId, modelName } = req.body;
    if (!taskId || !modelName) return res.status(400).json({ error: 'Missing params' });

    const folderName = `${taskId}/${modelName}`;
    const projectPath = path.join(config.TASKS_DIR, taskId, modelName);

    // 0. Check Database Status
    const runInfo = db.prepare("SELECT previewable FROM model_runs WHERE task_id = ? AND model_name = ?").get(taskId, modelName);
    const previewableStatus = runInfo ? runInfo.previewable : null;

    if (previewableStatus === 'preparing') {
        return res.status(202).json({ status: 'preparing', message: 'Preview environment is being prepared...' });
    }
    if (previewableStatus === 'unpreviewable') {
        return res.status(400).json({ status: 'unpreviewable', error: 'Project is not previewable' });
    }
    // If null or unknown, maybe we trigger preparation? But for now assume flow is correct.
    // Or if legacy task without status, we might need a fallback.
    // For this refactor, let's stick to the new flow. If null, maybe fallback to old logic or fail.
    // Let's assume we want to handle the case where it might be null (old task).
    // If null or unknown, maybe we trigger preparation? But for now assume flow is correct.
    // Or if legacy task without status, we might need a fallback.
    // For this refactor, let's stick to the new flow. If null, maybe fallback to old logic or fail.
    // Let's assume we want to handle the case where it might be null (old task).
    if (!previewableStatus || previewableStatus == 1) {
        // Fallback: Check if completed
        const runStatus = db.prepare("SELECT status FROM model_runs WHERE task_id = ? AND model_name = ?").get(taskId, modelName)?.status;
        if (runStatus !== 'completed') {
            return res.status(400).json({ error: 'Task not completed yet. Please wait.' });
        }

        // Trigger prep now
        previewService.preparePreview(taskId, modelName);
        return res.status(202).json({ status: 'preparing', message: 'Triggered preparation...' });
    }

    const addLog = (msg) => {
        if (previewService.runningPreviews[folderName]) {
            previewService.runningPreviews[folderName].logs.push({ msg, ts: Date.now() });
        }
    };

    // 1. Clean existing
    if (previewService.runningPreviews[folderName]) {
        const info = previewService.runningPreviews[folderName];
        if (info.proc && info.proc.pid) {
            await previewService.killProcessTree(info.proc.pid);
        }
        if (info.timeoutId) clearTimeout(info.timeoutId);
        delete previewService.runningPreviews[folderName];
    }

    // 2. Ensure Isolation Path (It should be there from prep, but safe to check/get path)
    const isolatedPath = previewService.ensureIsolatedPath(projectPath);

    // 3. Handle Static
    if (previewableStatus === 'static') {
        const files = fs.readdirSync(isolatedPath);
        const indexFile = files.find(f => f.toLowerCase() === 'index.html') || files.find(f => f.endsWith('.html'));

        if (indexFile) {
            const staticUrl = `/api/preview/view/${taskId}/${modelName}_preview/${indexFile}`;
            previewService.runningPreviews[folderName] = {
                status: 'ready',
                type: 'static',
                url: staticUrl,
                logs: [{ msg: 'Static project detected, ready.', ts: Date.now() }],
                startTime: Date.now()
            };
            return res.json({ status: 'ready', url: staticUrl });
        }
    }

    // 4. Handle Dynamic
    if (previewableStatus === 'dynamic') {
        // Allocate Port
        let allocatedPort;
        try {
            allocatedPort = await previewService.findFreePort();
        } catch (e) {
            return res.status(500).json({ error: 'No free ports available' });
        }

        // Init State
        previewService.runningPreviews[folderName] = {
            status: 'starting',
            port: allocatedPort,
            url: `http://${config.PUBLIC_HOST}:${allocatedPort}`,
            logs: [{ msg: `Starting dynamic preview on port ${allocatedPort}`, ts: Date.now() }],
            startTime: Date.now()
        };

        const runScript = path.join(isolatedPath, 'run_server.sh');
        if (!fs.existsSync(runScript)) {
            // Self-healing: if status says dynamic but script missing, downgrade it.
            db.prepare("UPDATE model_runs SET previewable = 'unpreviewable' WHERE task_id = ? AND model_name = ?").run(taskId, modelName);
            delete previewService.runningPreviews[folderName]; // Cleanup init state
            return res.status(500).json({ error: 'run_server.sh missing. Project marked as unpreviewable.' });
        }

        // Spawn ./run_server.sh <PORT>
        // Use isolation if possible
        let useIsolation = false;
        try {
            execSync('sudo -n true && id claude-user', { stdio: 'ignore' });
            useIsolation = true;
        } catch (e) { }

        let spawnCmd = '/bin/bash'; // Explicit interpreter
        let spawnArgs = [runScript, String(allocatedPort)];
        let spawnOptions = {
            cwd: isolatedPath,
            env: { ...process.env, PORT: allocatedPort, HOST: '0.0.0.0' },
            stdio: ['ignore', 'pipe', 'pipe']
        };

        if (useIsolation) {
            const envVars = [`PORT=${allocatedPort}`, `HOST=0.0.0.0`];
            spawnCmd = 'sudo';
            spawnArgs = ['-n', '-H', '-u', 'claude-user', 'env', ...envVars, '/bin/bash', runScript, String(allocatedPort)];
            spawnOptions.env = {};
        }

        // Ensure script is executable
        try { fs.chmodSync(runScript, '755'); } catch (e) { }

        console.log(`[Preview] Launching: ${spawnCmd} ${spawnArgs.join(' ')}`);
        const child = spawn(spawnCmd, spawnArgs, spawnOptions);

        previewService.runningPreviews[folderName].proc = child;

        child.stdout.on('data', d => addLog(`[STDOUT] ${d.toString().trim()}`));
        child.stderr.on('data', d => addLog(`[STDERR] ${d.toString().trim()}`));

        child.on('exit', (code) => {
            addLog(`Process exited with code ${code}`);
            if (code !== 0 && previewService.runningPreviews[folderName]) {
                previewService.runningPreviews[folderName].status = 'error';
            }
        });

        // Simple Probe to switch to ready
        let checks = 0;
        const checkInterval = setInterval(async () => {
            checks++;
            if (!previewService.runningPreviews[folderName]) {
                clearInterval(checkInterval);
                return;
            }
            if (checks > 20) { // 20 * 500ms = 10s timeout
                clearInterval(checkInterval);
                addLog('Startup timed out waiting for port.');
                return;
            }

            const { score } = await previewService.probePort(allocatedPort);
            if (score > 0) {
                clearInterval(checkInterval);
                previewService.runningPreviews[folderName].status = 'ready';
                previewService.runningPreviews[folderName].lastHeartbeat = Date.now();
                addLog('Service is ready!');
            }
        }, 500);

        return res.json({ status: 'starting', port: allocatedPort, url: previewService.runningPreviews[folderName].url });
    }

    return res.status(500).json({ error: 'Invalid state' });
});

// 停止预览接口
router.post('/stop', async (req, res) => {
    const { taskId, modelName } = req.body;
    const folderName = `${taskId}/${modelName}`;
    const info = previewService.runningPreviews[folderName];

    if (info) {
        console.log(`[Preview] Stopping ${folderName} on user request`);
        if (info.timeoutId) clearTimeout(info.timeoutId);

        // 1. First try to kill by process tree
        if (info.proc && info.proc.pid) {
            await previewService.killProcessTree(info.proc.pid);
        }

        // 2. Also try to kill by port to be safe (if port was allocated)
        if (info.port) {
            await previewService.killProcessOnPort(info.port);
        }

        delete previewService.runningPreviews[folderName];
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Preview not running' });
    }
});

// 心跳检测接口
router.post('/heartbeat', (req, res) => {
    const { taskId, modelName } = req.body;

    if (taskId) {
        previewService.updateTaskHeartbeat(taskId);
    }

    if (taskId && modelName) {
        const folderName = `${taskId}/${modelName}`;
        previewService.updateHeartbeat(folderName);
    }

    res.json({ success: true });
});

// 获取预览状态和日志
router.get('/status/:taskId/:modelName', (req, res) => {
    const { taskId, modelName } = req.params;
    const folderName = `${taskId}/${modelName}`;

    const previewInfo = previewService.runningPreviews[folderName];

    if (previewInfo) {
        const { proc, timeoutId, ...infoToSend } = previewInfo;
        // 计算剩余秒数
        if (previewInfo.expiresAt) {
            infoToSend.remainingSeconds = Math.max(0, Math.floor((previewInfo.expiresAt - Date.now()) / 1000));
        }
        res.json(infoToSend);
    } else {
        res.json({ status: 'not_running', logs: [{ msg: 'Preview not running.', ts: Date.now() }] });
    }
});

module.exports = router;
