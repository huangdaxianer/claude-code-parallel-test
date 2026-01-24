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

    // 3. 分配端口
    let allocatedPort;
    try {
        allocatedPort = await previewService.findFreePort();
    } catch (e) {
        return res.status(500).json({ error: 'No free ports available' });
    }

    // 4. 初始化状态
    previewService.runningPreviews[folderName] = {
        status: 'starting',
        port: allocatedPort,
        url: `http://localhost:${allocatedPort}`,
        logs: [{ msg: `Initializing Claude Code preview on port ${allocatedPort}...`, ts: Date.now() }],
        startTime: Date.now()
    };

    const addLog = (msg) => {
        if (previewService.runningPreviews[folderName]) {
            previewService.runningPreviews[folderName].logs.push({ msg, ts: Date.now() });
        }
    };

    // 5. 设置 5 分钟超时
    const timeoutMsg = "Preview timeout (5 minutes). Closing environment.";
    const timeoutId = setTimeout(async () => {
        console.log(`[Preview] Timeout reached for ${folderName}`);
        const info = previewService.runningPreviews[folderName];
        if (info) {
            addLog(timeoutMsg);
            if (info.proc && info.proc.pid) {
                await previewService.killProcessTree(info.proc.pid);
            }
            delete previewService.runningPreviews[folderName];
        }
    }, 5 * 60 * 1000);

    previewService.runningPreviews[folderName].timeoutId = timeoutId;

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
    const prompt = `请你启动该项目的前端预览，使用 ${allocatedPort} 端口。请确保服务能够正常访问。如果是静态页面也可以直接告知。`;

    // 增加调试信息打印
    addLog(`[Debug] Prompt: ${prompt}`);
    addLog(`[Debug] Project Path: ${projectPath}`);
    addLog(`[Debug] Allocated Port: ${allocatedPort}`);

    console.log(`[Preview] Starting Claude Code for ${folderName} on port ${allocatedPort}`);

    const claudeModel = 'tomato'; // 强制使用 tomato 模型
    const args = [
        '--model', claudeModel,
        '--allowedTools', 'Read(./**),Edit(./**),Bash(./**)',
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose'
    ];

    addLog(`[Debug] Executing: ${claudeBin} ${args.join(' ')}`);

    const child = spawn(claudeBin, args, {
        cwd: projectPath,
        env: { ...process.env, PORT: allocatedPort, HOST: '0.0.0.0' },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    previewService.runningPreviews[folderName].proc = child;
    addLog(`Claude Code process started with PID ${child.pid}`);

    child.stdin.write(prompt + "\n");
    child.stdin.end();

    // 8. 解析输出内容
    let buffer = '';
    child.stdout.on('data', (data) => {
        const raw = data.toString();
        // 如果是 JSON 流，尝试分行解析，但如果解析失败或者不是标准的 JSON 行，也记录下来
        buffer += raw;
        const lines = buffer.split('\n');
        buffer = lines.pop();

        lines.forEach(line => {
            if (!line.trim()) return;
            addLog(`[stdout] ${line}`); // 记录原始输出以便调试

            try {
                const obj = JSON.parse(line);
                // 处理 assistant 的回复文本
                if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
                    obj.message.content.forEach(block => {
                        if (block.type === 'text') addLog(`>> ${block.text}`);
                        if (block.type === 'thought') addLog(`>> *Thought: ${block.thought.slice(0, 200)}...*`);
                    });
                }

                // 处理工具调用
                if (obj.type === 'tool_use') {
                    addLog(`>> Tool: ${obj.name} input: ${JSON.stringify(obj.input)}`);
                }

                // 处理最终结果
                if (obj.type === 'result') {
                    if (obj.is_error) {
                        addLog(`>> [Error Result] ${obj.error?.message || 'Unknown error'}`);
                        previewService.runningPreviews[folderName].status = 'error';
                    } else {
                        addLog(">> [Success Result] Claude Code cleanup/exit signal received.");
                        previewService.runningPreviews[folderName].status = 'ready';
                    }
                }
            } catch (e) {
                // Ignore parse errors as we already logged the raw line
            }
        });
    });

    child.stderr.on('data', (data) => {
        addLog(`[stderr] ${data.toString().trim()}`);
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
        res.json(infoToSend);
    } else {
        res.status(404).json({ status: 'not_running', logs: [{ msg: 'Preview not running.', ts: Date.now() }] });
    }
});

module.exports = router;
