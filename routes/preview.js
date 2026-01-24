/**
 * 预览服务路由
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const config = require('../config');
const previewService = require('../services/previewService');

// 获取项目类型
router.get('/project/type/:taskId/:modelName', async (req, res) => {
    const { taskId, modelName } = req.params;
    const projectPath = path.join(config.TASKS_DIR, taskId, modelName);

    if (!fs.existsSync(projectPath)) {
        return res.json({ type: 'unknown', previewable: false });
    }

    const type = await previewService.detectProjectType(projectPath);
    const previewable = (type === 'node' || type === 'html');

    res.json({ type, previewable });
});

// 启动预览
router.post('/start', async (req, res) => {
    const { taskId, modelName } = req.body;
    if (!taskId || !modelName) return res.status(400).json({ error: 'Missing params' });

    const folderName = `${taskId}/${modelName}`;
    const projectPath = path.join(config.TASKS_DIR, taskId, modelName);

    // 强制单活预览策略：关闭其他预览
    const runningKeys = Object.keys(previewService.runningPreviews);
    for (const key of runningKeys) {
        if (key !== folderName) {
            const info = previewService.runningPreviews[key];
            console.log(`[Preview] Switching context: Stopping ${key} (PID ${info.proc.pid})`);

            (async () => {
                try {
                    const children = await previewService.getChildPids(info.proc.pid);
                    children.forEach(pid => {
                        try { process.kill(pid, 'SIGTERM'); } catch (e) { }
                    });
                    info.proc.kill('SIGTERM');
                } catch (e) {
                    console.error(`[Preview] Error killing ${key}:`, e);
                }
            })();

            delete previewService.runningPreviews[key];
        }
    }

    // 检查文件夹是否存在
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        return res.json({ type: 'static', url: `/artifacts/${folderName}/index.html` });
    }

    // 检查项目类型
    const projectType = await previewService.detectProjectType(projectPath);
    if (projectType === 'html') {
        console.log(`[Preview] Detected static HTML project for ${folderName}. Serving directly.`);
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

    // 检查是否已在运行
    if (previewService.runningPreviews[folderName]) {
        const info = previewService.runningPreviews[folderName];
        if (info.status === 'ready') {
            try {
                process.kill(info.proc.pid, 0);
                previewService.runningPreviews[folderName].lastAccess = Date.now();
                return res.json({ type: 'server', url: previewService.runningPreviews[folderName].url });
            } catch (e) {
                delete previewService.runningPreviews[folderName];
            }
        } else if (info.status === 'starting') {
            return res.status(409).json({ error: 'Preview is already starting' });
        }
    }

    // 初始化状态追踪
    previewService.runningPreviews[folderName] = {
        status: 'starting',
        logs: [{ msg: 'Initializing preview environment...', ts: Date.now() }],
        startTime: Date.now()
    };

    const addLog = (msg) => {
        if (previewService.runningPreviews[folderName]) {
            previewService.runningPreviews[folderName].logs.push({ msg, ts: Date.now() });
        }
    };

    try {
        const allocatedPort = await previewService.findFreePort();
        addLog(`Allocated internal port: ${allocatedPort}`);

        // 安装依赖
        if (fs.existsSync(path.join(projectPath, 'package.json')) && !fs.existsSync(path.join(projectPath, 'node_modules'))) {
            addLog('Installing dependencies (npm install)...');
            await new Promise((resolve, reject) => {
                exec('npm install', { cwd: projectPath }, (err) => err ? reject(err) : resolve());
            });
            addLog('Dependencies installed.');
        }

        const { cmd, args } = await previewService.detectStartCommand(projectPath);
        addLog(`Starting process: ${cmd} ${args.join(' ')}`);
        console.log(`[Preview] Starting ${folderName} using ${cmd} ${args.join(' ')} (Allocated: ${allocatedPort})`);

        const child = spawn(cmd, args, {
            cwd: projectPath,
            env: { ...process.env, PORT: allocatedPort, HOST: '0.0.0.0' },
            detached: false
        });

        previewService.runningPreviews[folderName].proc = child;

        child.stdout.on('data', d => console.log(`[P ${folderName}] ${d}`.trim()));
        child.stderr.on('data', d => console.error(`[P ${folderName} ERR] ${d}`.trim()));

        // 多端口扫描策略
        const MAX_RETRIES = 30;
        let retries = 0;
        let bestCandidate = null;

        addLog('Scanning for service ports...');

        const scanInterval = setInterval(async () => {
            retries++;

            const childPids = await previewService.getChildPids(child.pid);
            const pids = [child.pid, ...childPids];

            const ports = await previewService.getListeningPorts(pids);

            if (ports.length > 0) {
                addLog(`Detected ports: ${ports.join(', ')}. Probing...`);

                const results = await Promise.all(ports.map(previewService.probePort));
                results.sort((a, b) => b.score - a.score);

                const best = results[0];
                if (best && best.score > 0) {
                    if (best.serviceType === 'frontend') {
                        addLog(`Success! Frontend found at port ${best.port}`);
                        console.log(`[Preview] Found Frontend at port ${best.port}`);
                        clearInterval(scanInterval);
                        finish(best.port);
                        return;
                    }

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
                    if (previewService.runningPreviews[folderName]) {
                        addLog(`Timeout. Falling back to ${bestCandidate.serviceType} at ${bestCandidate.port}`);
                        console.log(`[Preview] Timeout. Fallback to best candidate: ${bestCandidate.port} (${bestCandidate.serviceType})`);
                        finish(bestCandidate.port);
                    }
                } else {
                    if (previewService.runningPreviews[folderName]) {
                        addLog('Timeout. No usable ports found.');
                        previewService.runningPreviews[folderName].status = 'error';
                        if (!res.headersSent) res.status(500).json({ error: 'Timeout: Service started but no accessible ports detected.' });
                        try { child.kill(); } catch (e) { }
                        delete previewService.runningPreviews[folderName];
                    }
                }
            }
        }, 1000);

        function finish(finalPort) {
            if (!previewService.runningPreviews[folderName]) return;

            const url = `http://localhost:${finalPort}`;
            Object.assign(previewService.runningPreviews[folderName], {
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

            if (previewService.runningPreviews[folderName]) {
                if (code !== 0 && code !== null) {
                    previewService.runningPreviews[folderName].status = 'error';
                    if (!res.headersSent) res.status(500).json({ error: `Process exited with code ${code}` });
                    setTimeout(() => { if (previewService.runningPreviews[folderName]) delete previewService.runningPreviews[folderName]; }, 5000);
                } else {
                    delete previewService.runningPreviews[folderName];
                }
            }
        });

    } catch (err) {
        console.error(`[Preview] Failed: ${err.message}`);
        addLog(`Error: ${err.message}`);
        if (previewService.runningPreviews[folderName]) previewService.runningPreviews[folderName].status = 'error';

        if (!res.headersSent) res.json({ type: 'static', url: `/artifacts/${folderName}/index.html`, warning: err.message });
    }
});

// 获取预览状态和日志
router.get('/status/:taskId/:modelName', (req, res) => {
    const { taskId, modelName } = req.params;
    const folderName = `${taskId}/${modelName}`;

    const previewInfo = previewService.runningPreviews[folderName];

    if (previewInfo) {
        const { proc, ...infoToSend } = previewInfo;
        res.json(infoToSend);
    } else {
        res.status(404).json({ status: 'not_running', logs: [{ msg: 'Preview not running.', ts: Date.now() }] });
    }
});

module.exports = router;
