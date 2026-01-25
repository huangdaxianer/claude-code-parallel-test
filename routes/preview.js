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

// 启动预览
router.post('/start', async (req, res) => {
    const { taskId, modelName } = req.body;
    if (!taskId || !modelName) return res.status(400).json({ error: 'Missing params' });

    const folderName = `${taskId}/${modelName}`;
    const projectPath = path.join(config.TASKS_DIR, taskId, modelName);

    const addLog = (msg) => {
        if (previewService.runningPreviews[folderName]) {
            previewService.runningPreviews[folderName].logs.push({ msg, ts: Date.now() });
        }
    };

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

    // Check for isolation user availability (similar to batch script)
    let useIsolation = false;
    try {
        // Simple check: can we sudo without password and does claude-user exist?
        require('child_process').execSync('sudo -n true && id claude-user', { stdio: 'ignore' });
        useIsolation = true;
        addLog('Using isolation user: claude-user');
    } catch (e) {
        addLog('Running with current user (sudo/claude-user not available)');
    }

    // Change ownership if using isolation
    if (useIsolation) {
        try {
            // Recursive chown to claude-user
            require('child_process').execSync(`sudo -n chown -R claude-user "${activePath}"`);
        } catch (e) {
            console.error(`[Preview] Failed to chown project path: ${e.message}`);
            addLog(`Warning: Failed to set permissions for isolation user.`);
        }
    }

    // 3. 检测项目类型 (先在原始路径检测，因为隔离路径可能还没 Ready)
    const originalProjectType = await previewService.detectProjectType(projectPath);

    // 4. 隔离路径
    const isolatedPath = previewService.ensureIsolatedPath(projectPath);
    const activePathResolved = isolatedPath; // 后续所有操作都基于 activePathResolved

    // 如果是纯 HTML 项目，直接返回静态服务 URL
    if (originalProjectType === 'html') {
        const files = fs.readdirSync(activePathResolved);
        const indexFile = files.find(f => f.toLowerCase() === 'index.html') || files.find(f => f.endsWith('.html'));

        if (indexFile) {
            const staticUrl = `/api/preview/view/${taskId}/${modelName}_preview/${indexFile}`;
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
        url: `http://${config.PUBLIC_HOST}:${allocatedPort}`,
        logs: [{ msg: '正在分配端口', ts: Date.now() }],
        startTime: Date.now()
    };



    // 6. 设置初始超时 (安装/启动阶段给 10 分钟)
    // 注意：Runtime 阶段现在由 Heartbeat 监控，不再设置硬性超时
    const setupTimeoutLimit = 10 * 60 * 1000;

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

    // 7. Fast Path: 尝试直接启动 (智能加速)
    try {
        const startCmd = await previewService.detectStartCommand(activePathResolved);
        if (startCmd) {
            addLog(`⚡️ Fast Path detected: ${startCmd.type} project`);
            addLog(`Command: ${startCmd.cmd} ${startCmd.args.join(' ')}`);

            // Prepare command
            const finalArgs = startCmd.args.map(arg => arg.replace('{PORT}', allocatedPort));
            let finalEnv = { ...process.env, PORT: allocatedPort, HOST: '0.0.0.0' };

            // Merge extra env vars if any (e.g. for Gradio)
            if (startCmd.env) {
                for (const [key, val] of Object.entries(startCmd.env)) {
                    finalEnv[key] = val.replace('{PORT}', allocatedPort);
                }
            }

            let fastSpawnCmd = startCmd.cmd;
            let fastSpawnArgs = finalArgs;
            let fastSpawnOptions = {
                cwd: activePathResolved,
                env: finalEnv,
                stdio: ['ignore', 'pipe', 'pipe']
            };

            if (useIsolation) {
                // Adjust for isolation
                // Re-construct env vars for `env` command
                const envVars = Object.entries(finalEnv).map(([k, v]) => `${k}=${v}`);
                // Filter out non-string values just in case, though process.env usually has strings
                const safeEnvVars = envVars.filter(e => !e.includes('[object Object]'));

                fastSpawnCmd = 'sudo';
                fastSpawnArgs = ['-n', '-H', '-u', 'claude-user', 'env', ...safeEnvVars, startCmd.cmd, ...finalArgs];
                fastSpawnOptions.env = {}; // sudo handles env
            }

            console.log(`[Preview] Attempting Fast Path: ${fastSpawnCmd} ${fastSpawnArgs.join(' ')}`);

            const fastChild = spawn(fastSpawnCmd, fastSpawnArgs, fastSpawnOptions);

            // Temporary logging for Fast Path
            fastChild.stdout.on('data', d => addLog(`[FastPath] ${d.toString().trim().substring(0, 100)}`));
            fastChild.stderr.on('data', d => addLog(`[FastPath] ${d.toString().trim().substring(0, 100)}`));

            // Wait 5 seconds to see if it crashes or port opens
            const fastStartResult = await new Promise(resolve => {
                let crashed = false;
                fastChild.on('exit', (code) => {
                    if (!crashed) { // Only handle if we haven't resolved yet
                        crashed = true;
                        resolve({ success: false, reason: `Process exited code ${code}` });
                    }
                });

                setTimeout(async () => {
                    if (crashed) return;

                    // Check port
                    try {
                        const { score } = await previewService.probePort(allocatedPort);
                        if (score > 0) {
                            resolve({ success: true });
                        } else {
                            resolve({ success: false, reason: 'Port not accessible after 5s' });
                        }
                    } catch (e) {
                        resolve({ success: false, reason: 'Probe error' });
                    }
                }, 5000);
            });

            if (fastStartResult.success) {
                addLog('✅ Fast Path successful! Service is running.');
                previewService.runningPreviews[folderName].proc = fastChild;
                previewService.runningPreviews[folderName].status = 'ready';
                previewService.runningPreviews[folderName].type = startCmd.type; // 'node', 'python', etc.
                previewService.runningPreviews[folderName].lastHeartbeat = Date.now();
                return res.json({ status: 'ready', port: allocatedPort, url: previewService.runningPreviews[folderName].url });
            } else {
                const failureMsg = `⚠️ Fast Path failed: ${fastStartResult.reason}. Falling back to Smart Agent...`;
                addLog(failureMsg);
                console.log(`[Preview][FastPathFailure] Task: ${taskId}/${modelName} | Type: ${startCmd.type} | Cmd: ${fastSpawnCmd} ${fastSpawnArgs.join(' ')} | Reason: ${fastStartResult.reason}`);

                // Kill the failed fast process ensure cleanup
                try {
                    if (fastChild.pid) process.kill(fastChild.pid);
                } catch (e) { }
                // Proceed to normal flow...
            }
        }
    } catch (e) {
        console.error(`[Preview] Fast Path error: ${e.message}`);
        addLog(`Fast Path error, skipping: ${e.message}`);
    }

    // 8. 启动 Claude Code (Fallback)
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
    const fileStructure = getFileStructure(activePathResolved);
    const prompt = `现在请你启动该项目的前端预览。使用 ${allocatedPort} 端口。请确保服务能够正常访问。如果是静态页面也请将页面预览启动到该端口。如果该端口被占用，请尝试终止占用该端口的任务。你如果需要安装依赖，请使用虚拟环境。如果代码中硬编码了端口，你是被允许且应当修改代码以适配当前端口的（如果是 Node.js 请优先使用 process.env.PORT || ${allocatedPort}，如果是 Python 请使用 os.environ.get('PORT', ${allocatedPort})）。禁止使用其它端口，禁止查看非本文件夹的内容。你工作目录下的文件结构是\n${fileStructure},`;

    // 增加调试信息打印
    addLog(`端口分配成功`);

    console.log(`[Preview] Starting Claude Code for ${folderName} (Isolated) on port ${allocatedPort}`);

    const claudeModel = 'tomato'; // 强制使用 tomato 模型
    const args = [
        '--model', claudeModel,
        '--allowedTools', 'Read(./**),Bash(./**)',
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose'
    ];

    console.log(`[Preview] Executing (Isolated): ${claudeBin} ${args.join(' ')}`);

    let spawnCmd = claudeBin;
    let spawnArgs = args;
    let spawnOptions = {
        cwd: activePathResolved,
        env: { ...process.env, PORT: allocatedPort, HOST: '0.0.0.0' },
        stdio: ['pipe', 'pipe', 'pipe']
    };

    if (useIsolation) {
        // Construct sudo command: sudo -n -H -u claude-user env PORT=... claude ...
        spawnCmd = 'sudo';
        // Pass essential env vars through 'env'
        const envVars = [
            `PORT=${allocatedPort}`,
            `HOST=0.0.0.0`,
            // Pass through current PATH and key vars
            `PATH=${process.env.PATH}`,
            `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ''}`,
            // Add other necessary keys if needed
        ];

        spawnArgs = ['-n', '-H', '-u', 'claude-user', 'env', ...envVars, claudeBin, ...args];
        // When using sudo, we don't pass the process.env directly to spawn, 
        // as sudo cleans environment. We relies on 'env' command to set them.
        spawnOptions.env = {};
    }

    const child = spawn(spawnCmd, spawnArgs, spawnOptions);

    child.on('error', (err) => {
        console.error(`[Preview] Failed to start subprocess: ${err}`);
        addLog(`Error: Failed to launch Claude Code: ${err.message}`);
        previewService.runningPreviews[folderName].status = 'error';
    });

    previewService.runningPreviews[folderName].proc = child;
    addLog(`尝试启动服务`);

    // Give it a tick to start
    setTimeout(() => {
        if (child.stdin && child.stdin.writable) {
            try {
                child.stdin.write(prompt + "\n");
                child.stdin.end();
            } catch (e) {
                console.error(`[Preview] Write to stdin failed: ${e}`);
            }
        }
    }, 100);

    // 8. 解析输出内容
    let buffer = '';
    child.stdout.on('data', (data) => {
        const raw = data.toString();
        // Print raw output to server console
        process.stdout.write(`[ClaudeCode][STDOUT] ${raw}`);

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
                        addLog("验证网页可用性");

                        (async () => {
                            try {
                                const checkInfo = previewService.runningPreviews[folderName];
                                if (!checkInfo) return; // Removed during waiting

                                const { serviceType, score } = await previewService.probePort(allocatedPort);
                                console.log(`[Preview] Probe port ${allocatedPort} result: ${serviceType}, score=${score}`);

                                if (score > 0) {
                                    addLog(">> Verification successful. Preview runtime starts now.");
                                    if (previewService.runningPreviews[folderName]) {
                                        previewService.runningPreviews[folderName].status = 'ready';
                                        previewService.runningPreviews[folderName].lastHeartbeat = Date.now();
                                    }
                                } else {
                                    addLog(">> Verification failed: Port is not accessible or returns error.");
                                    if (previewService.runningPreviews[folderName]) {
                                        // Special status to trigger "Preview not running" UI
                                        previewService.runningPreviews[folderName].status = 'not_running';
                                        previewService.runningPreviews[folderName].logs.push({ msg: 'Preview not running. Validation failed.', ts: Date.now() });
                                    }
                                }
                            } catch (e) {
                                console.error(`[Preview] Verification error: ${e}`);
                                if (previewService.runningPreviews[folderName]) {
                                    previewService.runningPreviews[folderName].status = 'not_running';
                                    previewService.runningPreviews[folderName].logs.push({ msg: 'Preview not running. Verification error.', ts: Date.now() });
                                }
                            }
                        })();
                    }
                }
            } catch (e) {
                // 非 JSON 或解析失败的消息一律不打印，保持界面干净
            }
        });
    });

    child.stderr.on('data', (data) => {
        process.stderr.write(`[ClaudeCode][STDERR] ${data.toString()}`);
    });

    child.on('exit', (code) => {
        if (previewService.runningPreviews[folderName]) {
            if (code !== 0 && code !== null) {
                addLog(`Claude Code process exited with code ${code}.`);
                // 但不一定要在这里销毁，因为子进程可能还在运行
            }
            // 如果 Claude 正常退出且没有报错，我们假设它已经启动了服务
            if (previewService.runningPreviews[folderName].status === 'starting') {
                previewService.runningPreviews[folderName].status = 'ready';
                previewService.runningPreviews[folderName].lastHeartbeat = Date.now(); // Reset heartbeat timer on ready
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
        res.status(404).json({ status: 'not_running', logs: [{ msg: 'Preview not running.', ts: Date.now() }] });
    }
});

module.exports = router;
