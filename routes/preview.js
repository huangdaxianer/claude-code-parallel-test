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

// 启动预览
router.post('/start', async (req, res) => {
    const { taskId, modelName } = req.body;
    if (!taskId || !modelName) return res.status(400).json({ error: 'Missing params' });

    const folderName = `${taskId}/${modelName}`;
    const projectPath = path.join(config.TASKS_DIR, taskId, modelName);

    // 1. 如果已经在运行，先彻底关闭
    if (previewService.runningPreviews[folderName]) {
        const info = previewService.runningPreviews[folderName];
        console.log(`[Preview] Restarting: Stopping existing preview for ${folderName}`);
        if (info.proc && info.proc.pid) {
            await previewService.killProcessTree(info.proc.pid);
        }
        if (info.timeoutId) clearTimeout(info.timeoutId);
        delete previewService.runningPreviews[folderName];
    }

    // 2. 准备环境
    if (!fs.existsSync(projectPath)) {
        return res.status(404).json({ error: 'Project directory not found' });
    }

    // 3. 检测项目类型
    const projectType = await previewService.detectProjectType(projectPath);

    // 如果是纯 HTML 项目，直接返回静态服务 URL，不启动 Claude Code
    if (projectType === 'html') {
        const files = fs.readdirSync(projectPath);
        const indexFile = files.find(f => f.toLowerCase() === 'index.html') || files.find(f => f.endsWith('.html'));

        if (indexFile) {
            const staticUrl = `/api/preview/view/${taskId}/${modelName}/${indexFile}`;
            previewService.runningPreviews[folderName] = {
                status: 'ready',
                type: 'static',
                url: staticUrl,
                logs: [{ msg: '检测到静态页面，直接预览...', ts: Date.now() }],
                startTime: Date.now()
            };
            return res.json({ status: 'ready', url: staticUrl });
        }
    }

    // 4. 分配端口 (仅非静态项目需要)
    let allocatedPort;
    try {
        allocatedPort = await previewService.findFreePort();
    } catch (e) {
        return res.status(500).json({ error: 'No free ports available' });
    }

    // 5. 初始化状态
    previewService.runningPreviews[folderName] = {
        status: 'starting',
        port: allocatedPort,
        url: `http://localhost:${allocatedPort}`,
        logs: [{ msg: '正在分配端口', ts: Date.now() }],
        startTime: Date.now()
    };

    const addLog = (msg) => {
        if (previewService.runningPreviews[folderName]) {
            previewService.runningPreviews[folderName].logs.push({ msg, ts: Date.now() });
        }
    };

    // 6. 设置初始超时 (安装/启动阶段给 10 分钟)
    const setupTimeoutLimit = 10 * 60 * 1000;
    const runtimeTimeoutLimit = 5 * 60 * 1000; // 启动后给 5 分钟

    const setKillTimeout = (durationMs, reason) => {
        const info = previewService.runningPreviews[folderName];
        if (info && info.timeoutId) clearTimeout(info.timeoutId);

        const timeoutId = setTimeout(async () => {
            console.log(`[Preview] Timeout reached for ${folderName}: ${reason}`);
            const currentInfo = previewService.runningPreviews[folderName];
            if (currentInfo) {
                addLog(`Preview timeout: ${reason}. Closing environment.`);
                if (currentInfo.proc && currentInfo.proc.pid) {
                    await previewService.killProcessTree(currentInfo.proc.pid);
                }
                delete previewService.runningPreviews[folderName];
            }
        }, durationMs);

        if (previewService.runningPreviews[folderName]) {
            previewService.runningPreviews[folderName].timeoutId = timeoutId;
            previewService.runningPreviews[folderName].expiresAt = Date.now() + durationMs;
        }
    };

    // 初始设置 Setup 超时
    setKillTimeout(setupTimeoutLimit, "Setup Phase Timeout");

    // 6. 查找 Claude 二进制文件
    let claudeBin = 'claude';
    try {
        const whichClaude = execSync('which claude').toString().trim();
        if (whichClaude) claudeBin = whichClaude;
    } catch (e) {
        // 尝试常见路径
        const paths = [
            path.join(process.env.HOME, '.npm-global/bin/claude'),
            '/usr/local/bin/claude'
        ];
        for (const p of paths) {
            if (fs.existsSync(p)) {
                claudeBin = p;
                break;
            }
        }
    }

    // 7. 启动 Claude Code
    const prompt = `请你启动该项目的前端预览，使用 ${allocatedPort} 端口。请确保服务能够正常访问。如果是静态页面也可以直接告知，禁止查看非本文件夹的项目内容，禁止改动文件。`;

    // 增加调试信息打印
    addLog(`端口分配成功`);

    console.log(`[Preview] Starting Claude Code for ${folderName} on port ${allocatedPort}`);

    const claudeModel = 'tomato'; // 强制使用 tomato 模型
    const args = [
        '--model', claudeModel,
        '--allowedTools', 'Read(./**),Bash(./**)',
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose'
    ];

    const child = spawn(claudeBin, args, {
        cwd: projectPath,
        env: { ...process.env, PORT: allocatedPort, HOST: '0.0.0.0' },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    previewService.runningPreviews[folderName].proc = child;
    addLog(`尝试启动服务`);

    child.stdin.write(prompt + "\n");
    child.stdin.end();

    // 8. 解析输出内容
    let buffer = '';
    child.stdout.on('data', (data) => {
        const raw = data.toString();
        buffer += raw;
        const lines = buffer.split('\n');
        buffer = lines.pop();

        lines.forEach(line => {
            if (!line.trim()) return;

            try {
                const obj = JSON.parse(line);

                // 1. 处理直接的 tool_use
                if (obj.type === 'tool_use' && obj.name === 'Bash') {
                    if (obj.input && obj.input.description) {
                        addLog(obj.input.description);
                    }
                }

                // 2. 处理 assistant 消息中的 tool_use (常见格式)
                if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
                    obj.message.content.forEach(block => {
                        if (block.type === 'tool_use' && block.name === 'Bash') {
                            if (block.input && block.input.description) {
                                addLog(block.input.description);
                            }
                        }
                    });
                }

                // 3. 处理最终结果 (保留状态更新，但不打印 JSON)
                if (obj.type === 'result') {
                    if (obj.is_error) {
                        addLog(`Error: ${obj.error?.message || 'Unknown error'}`);
                        previewService.runningPreviews[folderName].status = 'error';
                        setKillTimeout(2 * 60 * 1000, "Error state cleanup");
                    } else {
                        addLog(">> Setup complete. Preview runtime starts now.");
                        previewService.runningPreviews[folderName].status = 'ready';
                        setKillTimeout(runtimeTimeoutLimit, "Runtime Limit Exceeded");
                    }
                }
            } catch (e) {
                // 非 JSON 或解析失败的消息一律不打印，保持界面干净
            }
        });
    });

    child.stderr.on('data', (data) => {
    });

    child.on('exit', (code) => {
        console.log(`[Preview] Claude Code (PID ${child.pid}) exited with code ${code}`);
        if (previewService.runningPreviews[folderName]) {
            if (code !== 0 && code !== null) {
                addLog(`Claude Code process exited with code ${code}.`);
                // 但不一定要在这里销毁，因为子进程可能还在运行
            }
            // 如果 Claude 正常退出且没有报错，我们假设它已经启动了服务
            if (previewService.runningPreviews[folderName].status === 'starting') {
                previewService.runningPreviews[folderName].status = 'ready';
            }
        }
    });

    res.json({ status: 'starting', port: allocatedPort, url: previewService.runningPreviews[folderName].url });
});

// 停止预览接口
router.post('/stop', async (req, res) => {
    const { taskId, modelName } = req.body;
    const folderName = `${taskId}/${modelName}`;
    const info = previewService.runningPreviews[folderName];

    if (info) {
        console.log(`[Preview] Stopping ${folderName} on user request`);
        if (info.timeoutId) clearTimeout(info.timeoutId);
        if (info.proc && info.proc.pid) {
            await previewService.killProcessTree(info.proc.pid);
        }
        delete previewService.runningPreviews[folderName];
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Preview not running' });
    }
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
        res.status(404).json({ status: 'not_running', logs: [{ msg: 'Preview not running.', ts: Date.now() }] });
    }
});

module.exports = router;
