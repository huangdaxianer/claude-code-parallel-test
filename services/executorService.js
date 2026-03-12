const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('../db');
const config = require('../config');
const { buildSafeEnv } = require('../utils/envWhitelist');
const { FileTailer } = require('../utils/fileTailer');

// 活跃进程 Map<"taskId/modelId", ChildProcess>
const activeProcesses = new Map();

// firejail CPU 核心轮转分配计数器
// firejail 0.9.72 硬编码最多支持 32 核 (0-31)，需要 cap 到 32
let sandboxCounter = 0;
const CPU_CORES_PER_SANDBOX = 4;
const TOTAL_CPU_CORES = Math.min(os.cpus().length, 32);

// 环境配置（启动时初始化）
let executorConfig = {
    useIsolation: false,
    claudeBin: null,
    hasFirejail: false
};

/**
 * 初始化执行器环境
 */
function initialize() {
    console.log('[Executor] Initializing...');

    // 设置 locale
    process.env.LANG = 'en_US.UTF-8';
    process.env.LC_ALL = 'en_US.UTF-8';

    // 检测 Claude CLI 路径
    executorConfig.claudeBin = findClaudeBin();
    if (!executorConfig.claudeBin) {
        console.error('[Executor] ERROR: Claude CLI not found!');
    } else {
        console.log(`[Executor] Claude CLI: ${executorConfig.claudeBin}`);
    }

    // 检测隔离用户
    executorConfig.useIsolation = checkIsolation();
    console.log(`[Executor] Isolation mode: ${executorConfig.useIsolation}`);

    // 检测 firejail
    executorConfig.hasFirejail = checkFirejail();
    console.log(`[Executor] Firejail: ${executorConfig.hasFirejail}`);

    // 确保临时目录存在
    ensureTempDir();

    console.log('[Executor] Initialization complete');
}

/**
 * 查找 Claude CLI 路径
 */
function findClaudeBin() {
    // 尝试 which claude
    try {
        const result = execSync('which claude', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        if (result.trim()) return result.trim();
    } catch (e) { }

    // 常见路径
    const locations = [
        path.join(os.homedir(), '.npm-global/bin/claude'),
        '/usr/local/bin/claude',
        '/usr/bin/claude'
    ];

    for (const loc of locations) {
        if (fs.existsSync(loc)) return loc;
    }

    return null;
}

/**
 * 检测是否可以使用隔离用户
 */
function checkIsolation() {
    try {
        execSync('sudo -n true', { stdio: 'ignore' });
        execSync('id claude-user', { stdio: 'ignore' });
        console.log('[Executor] Isolation user claude-user available');
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * 检测 firejail 是否可用
 */
function checkFirejail() {
    try {
        execSync('which firejail', { stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * 确保临时目录存在
 */
function ensureTempDir() {
    const tmpDir = '/tmp/claude';
    try {
        if (executorConfig.useIsolation) {
            execSync(`sudo -n mkdir -p ${tmpDir}`, { stdio: 'ignore' });
            execSync(`sudo -n chmod 777 ${tmpDir}`, { stdio: 'ignore' });
        } else {
            fs.mkdirSync(tmpDir, { recursive: true });
            fs.chmodSync(tmpDir, 0o777);
        }
    } catch (e) {
        console.warn('[Executor] Failed to create temp dir:', e.message);
    }
}

/**
 * 获取任务的 prompt
 */
function getPrompt(taskId) {
    const task = db.prepare('SELECT prompt FROM tasks WHERE task_id = ?').get(taskId);
    if (!task) {
        throw new Error(`Task ${taskId} not found`);
    }
    return task.prompt || '';
}

/**
 * 获取任务的 base_dir
 */
function getBaseDir(taskId) {
    const task = db.prepare('SELECT base_dir FROM tasks WHERE task_id = ?').get(taskId);
    return task?.base_dir || null;
}

/**
 * 复制基础文件到工作目录
 */
function copyBaseFiles(taskId, folderPath) {
    const baseDir = getBaseDir(taskId);
    if (!baseDir || !fs.existsSync(baseDir)) return;

    // 只在目录为空时复制
    const files = fs.readdirSync(folderPath);
    if (files.length > 0) return;

    try {
        // 使用 cp -R 复制（保留目录结构）
        execSync(`cp -R "${baseDir}/." "${folderPath}/"`, { stdio: 'ignore' });
        console.log(`[Executor] Copied base files from ${baseDir} to ${folderPath}`);
    } catch (e) {
        console.error(`[Executor] Failed to copy base files:`, e.message);
    }
}

/**
 * 构建 firejail 沙箱参数
 */
function buildFirejailArgs(taskDir, modelId) {
    const args = ['--quiet', '--noprofile'];

    // 白名单：只允许访问当前模型的工作目录（home 下其他路径自动隔离）
    const modelDir = path.join(taskDir, modelId);
    args.push(`--whitelist=${modelDir}`);

    // 系统敏感文件（whitelist 只限制 home 目录，/etc 等系统路径需额外 blacklist）
    args.push('--blacklist=/etc/shadow');
    args.push('--blacklist=/etc/passwd');

    // 资源限制：降低调度优先级，防止沙箱内进程抢占过多 CPU
    args.push('--nice=10');

    // 限制每个沙箱可用的 CPU 核心数，防止单个任务吃满所有核心
    const startCore = (sandboxCounter * CPU_CORES_PER_SANDBOX) % TOTAL_CPU_CORES;
    const cores = [];
    for (let i = 0; i < CPU_CORES_PER_SANDBOX; i++) {
        cores.push((startCore + i) % TOTAL_CPU_CORES);
    }
    args.push(`--cpu=${cores.join(',')}`);
    sandboxCounter++;

    return args;
}

// buildEnv 已被 utils/envWhitelist.js 的 buildSafeEnv 取代
// 子进程通过内部代理访问 API，不再直接持有真实 token

/**
 * 执行单个模型任务
 * @returns {ChildProcess} 子进程对象
 */
function executeModel(taskId, modelId, modelConfig) {
    const subtaskKey = `${taskId}/${modelId}`;
    // modelConfig: { endpointName, apiBaseUrl, apiKey, modelName }
    const endpointName = modelConfig.endpointName || modelConfig;
    const actualModelName = modelConfig.modelName || endpointName;
    console.log(`[Executor] Starting: ${subtaskKey} (endpoint: ${endpointName}, model: ${actualModelName})`);

    if (!executorConfig.claudeBin) {
        throw new Error('Claude CLI not found');
    }

    // 准备目录
    const taskRoot = path.join(config.TASKS_DIR, taskId);
    const folderPath = path.join(taskRoot, modelId);
    const logsDir = path.join(taskRoot, 'logs');

    fs.mkdirSync(folderPath, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    // 复制基础文件
    copyBaseFiles(taskId, folderPath);

    // 设置权限（隔离模式）
    if (executorConfig.useIsolation) {
        try {
            execSync(`chmod -R 777 "${taskRoot}"`, { stdio: 'ignore' });
            execSync(`sudo -n chown -R claude-user "${taskRoot}"`, { stdio: 'ignore' });
        } catch (e) { }
    }

    // 获取 prompt
    const prompt = getPrompt(taskId);

    // 构建 Claude CLI 参数
    // Agent Teams 模式下，如果模型不是 Claude 系列，伪装为 claude-sonnet-4-6
    // 这样 Claude Code 内部的 inbox polling 等特性才会生效
    // proxy 会负责将请求中的 model 改写为实际上游模型名，并将响应中的 model 改写回来
    let cliModelName = actualModelName;
    if (modelConfig.enableAgentTeams && !actualModelName.match(/^(claude-|anthropic\/claude)/i)) {
        console.log(`[Executor] Agent Teams: masquerading model ${actualModelName} as claude-sonnet-4-6`);
        cliModelName = 'claude-sonnet-4-6';
    }
    const claudeArgs = [
        '--model', cliModelName,
        '--allowedTools', 'Read(./**),Edit(./**),Bash(.**/*)',
        '--disallowedTools', 'EnterPlanMode,ExitPlanMode',
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose'
    ];

    // Agent Teams: 追加 system prompt，要求模型在关键节点主动检查 inbox
    // 由于 headless 模式下 inbox 自动轮询存在已知 bug（GitHub #23415），
    // 需要通过 system prompt 引导模型手动 Read inbox 文件来获取子 agent 的消息
    if (modelConfig.enableAgentTeams) {
        const teamName = (taskId + '-' + modelId).toLowerCase();
        const inboxCheckPrompt = [
            '## Agent Teams Inbox Check Instructions',
            '',
            'You are running in Agent Teams mode. Due to a known limitation in headless mode,',
            'inbox messages from sub-agents may NOT be automatically delivered to you.',
            'You MUST proactively check your inbox by reading the inbox file at these critical moments:',
            '',
            '1. **After advancing a todo item** — When you complete a task or move to the next todo, check inbox for any messages from teammates.',
            '2. **Before finishing your work** — Before you consider your job done, check inbox to ensure no teammate has sent important messages or results.',
            '3. **When expecting a sub-agent reply** — After you send a message to a sub-agent (via SendMessage) or assign them a task, periodically check inbox while waiting.',
            '',
            'How to check inbox:',
            '- Read the team config file at `~/.claude/teams/' + teamName + '/config.json` to find your agent name.',
            '- Then read your inbox file at `~/.claude/teams/' + teamName + '/inboxes/{your-agent-name}.json`.',
            '- Process any unread messages (where `read` is false) and act on them.',
            '',
            '### Efficient Inbox Reading',
            '',
            'The inbox file can grow large over time. To read it efficiently:',
            '- Track the line count from your last read (e.g., you last read 120 lines).',
            '- On subsequent reads, use the `offset` parameter to skip already-read lines, and set `limit` to a reasonable number (e.g., 50–100 lines) to fetch only new content.',
            '- Example: if you last read 120 lines, use `offset: 120, limit: 50` to read lines 121–170.',
            '- This avoids re-reading the entire file every time and is much more efficient.',
            '',
            'IMPORTANT: Do NOT rely on automatic message delivery. Always manually check your inbox at the moments described above.',
            '',
            '## Team Naming Convention (CRITICAL)',
            '',
            'When creating a team with TeamCreate, you MUST use the exact string "' + teamName + '" as the team_name.',
            'The team_name MUST be ALL LOWERCASE. Do NOT use uppercase letters in team names.',
            'Do NOT invent your own team name. This exact lowercase naming convention is required for the platform to track your sub-agents.',
            '',
            '## Cleanup Policy',
            '',
            'When your work is complete, do NOT delete or clean up team files:',
            '- Do NOT call TeamDelete',
            '- Do NOT run rm -rf on ~/.claude/teams/ or ~/.claude/tasks/ directories',
            '- The platform will handle cleanup automatically.'
        ].join('\n');
        claudeArgs.push('--append-system-prompt', inboxCheckPrompt);
        console.log(`[Executor] Agent Teams: appended inbox check system prompt for ${subtaskKey}`);
    }

    // 日志文件
    const logFile = path.join(logsDir, `${modelId}.txt`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });

    // stdout/stderr 输出到文件（替代管道，使子进程在父进程死亡后仍可写入）
    const stdoutFile = path.join(logsDir, `${modelId}.stdout`);
    const stderrFile = path.join(logsDir, `${modelId}.stderr`);
    const stdoutFd = fs.openSync(stdoutFile, 'w');
    const stderrFd = fs.openSync(stderrFile, 'w');

    // 选择执行方式
    let child;

    if (executorConfig.hasFirejail) {
        // 使用 firejail 沙箱
        const firejailArgs = buildFirejailArgs(taskRoot, modelId);
        const fullArgs = [...firejailArgs, '--', executorConfig.claudeBin, ...claudeArgs];

        console.log(`[Executor] Using firejail sandbox for ${subtaskKey}`);

        const envVars = buildSafeEnv(modelId, {}, taskId);
        const maxOutputTokens = String(modelConfig.maxOutputTokens || 128000);
        envVars.CLAUDE_CODE_MAX_OUTPUT_TOKENS = maxOutputTokens;
        if (modelConfig.alwaysThinkingEnabled) {
            envVars.alwaysThinkingEnabled = 'true';
        }
        if (modelConfig.enableAgentTeams) {
            envVars.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
        }
        if (executorConfig.useIsolation) {
            // 隔离用户模式
            child = spawn('sudo', [
                '-n', '-H', '-u', 'claude-user',
                'env',
                `ANTHROPIC_AUTH_TOKEN=${envVars.ANTHROPIC_AUTH_TOKEN}`,
                `ANTHROPIC_BASE_URL=${envVars.ANTHROPIC_BASE_URL}`,
                `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=${envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC}`,
                `CLAUDE_CODE_MAX_OUTPUT_TOKENS=${maxOutputTokens}`,
                ...(envVars.alwaysThinkingEnabled ? [`alwaysThinkingEnabled=${envVars.alwaysThinkingEnabled}`] : []),
                ...(envVars.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS ? [`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=${envVars.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS}`] : []),
                'firejail', ...fullArgs
            ], {
                cwd: folderPath,
                env: envVars,
                stdio: ['pipe', stdoutFd, stderrFd],
                detached: true
            });
        } else {
            child = spawn('firejail', fullArgs, {
                cwd: folderPath,
                env: envVars,
                stdio: ['pipe', stdoutFd, stderrFd],
                detached: true
            });
        }
    } else {
        // 无沙箱模式
        console.log(`[Executor] Running without sandbox for ${subtaskKey}`);
        const envVars = buildSafeEnv(modelId, {}, taskId);
        const maxOutputTokens = String(modelConfig.maxOutputTokens || 128000);
        envVars.CLAUDE_CODE_MAX_OUTPUT_TOKENS = maxOutputTokens;
        if (modelConfig.alwaysThinkingEnabled) {
            envVars.alwaysThinkingEnabled = 'true';
        }
        if (modelConfig.enableAgentTeams) {
            envVars.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
        }

        if (executorConfig.useIsolation) {
            child = spawn('sudo', [
                '-n', '-H', '-u', 'claude-user',
                'env',
                `ANTHROPIC_AUTH_TOKEN=${envVars.ANTHROPIC_AUTH_TOKEN}`,
                `ANTHROPIC_BASE_URL=${envVars.ANTHROPIC_BASE_URL}`,
                `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=${envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC}`,
                `CLAUDE_CODE_MAX_OUTPUT_TOKENS=${maxOutputTokens}`,
                ...(envVars.alwaysThinkingEnabled ? [`alwaysThinkingEnabled=${envVars.alwaysThinkingEnabled}`] : []),
                ...(envVars.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS ? [`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=${envVars.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS}`] : []),
                executorConfig.claudeBin, ...claudeArgs
            ], {
                cwd: folderPath,
                env: envVars,
                stdio: ['pipe', stdoutFd, stderrFd],
                detached: true
            });
        } else {
            child = spawn(executorConfig.claudeBin, claudeArgs, {
                cwd: folderPath,
                env: envVars,
                stdio: ['pipe', stdoutFd, stderrFd],
                detached: true
            });
        }
    }

    // 关闭父进程端的 fd（子进程已通过继承的 fd 写入文件）
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);

    // 让子进程在父进程退出后继续运行
    child.unref();

    // 写入 prompt 到 stdin
    child.stdin.write(prompt);
    child.stdin.end();

    // PID + stdout_file 写入 DB
    try {
        db.prepare('UPDATE model_runs SET pid = ?, stdout_file = ?, stdout_offset = 0 WHERE task_id = ? AND model_id = ?')
            .run(child.pid, stdoutFile, taskId, modelId);
    } catch (e) {
        console.error(`[Executor] Failed to persist PID for ${subtaskKey}:`, e.message);
    }

    // 使用 IngestHandler 直接处理输出（不再 spawn 独立进程）
    const { IngestHandler } = require('./ingestHandler');

    let ingestHandler;
    try {
        ingestHandler = new IngestHandler(taskId, modelId);
    } catch (e) {
        console.error(`[Executor] Failed to create IngestHandler for ${subtaskKey}:`, e.message);
        child.kill();
        throw e;
    }

    // 构建敏感信息脱敏函数：精确匹配当前任务使用的 token 和 URL
    const sensitiveValues = [];
    const authToken = modelConfig.apiKey || process.env.ANTHROPIC_AUTH_TOKEN;
    const baseUrl = modelConfig.apiBaseUrl || process.env.ANTHROPIC_BASE_URL;
    if (authToken) sensitiveValues.push({ value: authToken, replacement: '***REDACTED_TOKEN***' });
    if (baseUrl) sensitiveValues.push({ value: baseUrl, replacement: '***REDACTED_URL***' });

    function sanitizeLine(line) {
        let result = line;
        for (const { value, replacement } of sensitiveValues) {
            if (result.includes(value)) {
                result = result.split(value).join(replacement);
            }
        }
        return result;
    }

    // 使用 FileTailer 替代 readline 消费 stdout 文件
    let lastOffsetSaveTime = Date.now();
    const fileTailer = new FileTailer(stdoutFile, 0, (line) => {
        const sanitized = sanitizeLine(line);
        logStream.write(sanitized + '\n');
        ingestHandler.processLine(sanitized);
        // 更新最后活动时间，供 watchdog 检测卡死
        const entry = activeProcesses.get(subtaskKey);
        if (entry) entry.lastActivityTime = Date.now();
        // 定期保存 stdout_offset 到 DB（每 10 秒），防止服务重启后从头重读
        const now = Date.now();
        if (now - lastOffsetSaveTime > 10000) {
            try {
                db.prepare('UPDATE model_runs SET stdout_offset = ? WHERE task_id = ? AND model_id = ?')
                    .run(fileTailer.getOffset(), taskId, modelId);
            } catch (e) { /* ignore */ }
            lastOffsetSaveTime = now;
        }
    });
    fileTailer.start();

    // stderr tailer
    const stderrTailer = new FileTailer(stderrFile, 0, (line) => {
        const sanitized = sanitizeLine(line);
        logStream.write(sanitized + '\n');
        console.error(`[Executor ${subtaskKey} STDERR] ${sanitized.slice(0, 200)}`);
    }, { pollInterval: 1000 });
    stderrTailer.start();

    // 进程结束时：延迟 500ms 等文件刷新完毕，再做最终处理
    child.on('close', () => {
        setTimeout(() => {
            if (fileTailer) { fileTailer.pollOnce(); fileTailer.stop(); }
            if (stderrTailer) { stderrTailer.pollOnce(); stderrTailer.stop(); }
            logStream.end();
            if (!ingestHandler.isFinished()) {
                ingestHandler.finish();
            }
        }, 500);
    });

    // 保存进程引用（包含每模型超时配置，供 watchdog 使用）
    activeProcesses.set(subtaskKey, {
        child,
        ingestHandler,
        fileTailer,
        stderrTailer,
        logStream,
        lastActivityTime: Date.now(),
        activityTimeoutSeconds: modelConfig.activityTimeoutSeconds ?? null,
        taskTimeoutSeconds: modelConfig.taskTimeoutSeconds ?? null,
        pid: child.pid,
        isReattached: false
    });

    // 清理完成时的回调
    child.on('exit', (code, signal) => {
        console.log(`[Executor ${subtaskKey}] Exited with code ${code}, signal ${signal}`);
        activeProcesses.delete(subtaskKey);

        // 清除 DB 中的 pid（进程已死，pid 不再有效）
        try {
            db.prepare('UPDATE model_runs SET pid = NULL WHERE task_id = ? AND model_id = ?').run(taskId, modelId);
        } catch (e) { /* ignore */ }

        // 恢复权限
        if (executorConfig.useIsolation) {
            try {
                execSync(`sudo -n -u claude-user chmod -R a+rX "${folderPath}"`, { stdio: 'ignore' });
            } catch (e) { }
        }

        // Agent Teams: 快照保全
        if (modelConfig.enableAgentTeams) {
            try {
                snapshotAgentTeamFiles(taskId, modelId, folderPath);
            } catch (e) {
                console.error(`[Executor ${subtaskKey}] Agent Teams snapshot failed:`, e.message);
            }
        }
    });

    return child;
}

/**
 * Agent Teams: 快照保全文件
 * 将 ~/.claude/ 下的 teams/tasks/subagents 文件拷贝到任务目录，防止模型清理后数据丢失
 */
function snapshotAgentTeamFiles(taskId, modelId, folderPath) {
    const teamName = `${taskId}-${modelId}`;
    const snapshotDir = path.join(folderPath, '.agent-snapshot');
    const claudeUserHome = '/home/claude-user';
    const teamsBase = path.join(claudeUserHome, '.claude/teams');
    const tasksBase = path.join(claudeUserHome, '.claude/tasks');

    // 查找所有大小写变体目录（Claude SDK 会用不同大小写创建目录）
    let allTeamDirs = [];
    let allTaskDirs = [];
    try {
        const allTeams = execSync(`sudo -n ls "${teamsBase}/" 2>/dev/null || echo ""`, { encoding: 'utf8' }).trim();
        if (allTeams) {
            const lowerName = teamName.toLowerCase();
            for (const dir of allTeams.split('\n').filter(Boolean)) {
                if (dir.toLowerCase() === lowerName) {
                    allTeamDirs.push(path.join(teamsBase, dir));
                }
            }
        }
    } catch (e) { /* ignore */ }

    try {
        const allTasks = execSync(`sudo -n ls "${tasksBase}/" 2>/dev/null || echo ""`, { encoding: 'utf8' }).trim();
        if (allTasks) {
            const lowerName = teamName.toLowerCase();
            for (const dir of allTasks.split('\n').filter(Boolean)) {
                if (dir.toLowerCase() === lowerName) {
                    allTaskDirs.push(path.join(tasksBase, dir));
                }
            }
        }
    } catch (e) { /* ignore */ }

    // Fallback: 扫描匹配 cwd 包含 taskId 的团队
    if (allTeamDirs.length === 0) {
        console.log(`[Snapshot] No case-variant team dirs found for ${teamName}, scanning by taskId...`);
        try {
            const allTeams = execSync(`sudo -n ls "${teamsBase}/" 2>/dev/null || echo ""`, { encoding: 'utf8' }).trim();
            if (allTeams) {
                for (const dir of allTeams.split('\n').filter(Boolean)) {
                    try {
                        const configContent = execSync(`sudo -n cat "${teamsBase}/${dir}/config.json" 2>/dev/null || echo ""`, { encoding: 'utf8' }).trim();
                        if (configContent && configContent.includes(taskId)) {
                            allTeamDirs.push(path.join(teamsBase, dir));
                            allTaskDirs.push(path.join(tasksBase, dir));
                            console.log(`[Snapshot] Found matching team by scan: ${dir}`);
                            break;
                        }
                    } catch (e) { /* ignore */ }
                }
            }
        } catch (e) { /* ignore */ }
    }

    if (allTeamDirs.length === 0) {
        console.log(`[Snapshot] No team dirs found for ${teamName}`);
        return;
    }

    // 创建快照目录
    try {
        fs.mkdirSync(snapshotDir, { recursive: true });
        fs.mkdirSync(path.join(snapshotDir, 'tasks'), { recursive: true });
        fs.mkdirSync(path.join(snapshotDir, 'inboxes'), { recursive: true });
        fs.mkdirSync(path.join(snapshotDir, 'subagents'), { recursive: true });
    } catch (e) {
        console.error(`[Snapshot] Failed to create snapshot dirs:`, e.message);
        return;
    }

    // 从所有 teams 目录变体复制 config.json 和 inboxes
    for (const teamDir of allTeamDirs) {
        try {
            execSync(`sudo -n cp -n "${teamDir}/config.json" "${snapshotDir}/config.json" 2>/dev/null`, { stdio: 'ignore' });
        } catch (e) { /* ignore */ }
        try {
            execSync(`sudo -n cp -n "${teamDir}/inboxes/"*.json "${snapshotDir}/inboxes/" 2>/dev/null`, { stdio: 'ignore' });
        } catch (e) { /* ignore */ }
    }
    console.log(`[Snapshot] Copied config.json and inboxes from ${allTeamDirs.length} team dir(s)`);

    // 从所有 tasks 目录变体复制 tasks
    for (const taskDir of allTaskDirs) {
        try {
            execSync(`sudo -n cp -n "${taskDir}/"*.json "${snapshotDir}/tasks/" 2>/dev/null`, { stdio: 'ignore' });
        } catch (e) { /* ignore */ }
    }
    console.log(`[Snapshot] Copied tasks from ${allTaskDirs.length} task dir(s)`);

    // 复制 subagents/ — 两种布局：
    //   新格式: projects/{cwdSlug}/{sessionId}/subagents/agent-*.jsonl
    //   旧格式: projects/{cwdSlug}/agent-*.jsonl
    try {
        const cwdSlug = folderPath.replace(/\//g, '-');
        const projectDir = path.join(claudeUserHome, '.claude/projects', cwdSlug);

        // 旧格式：直接在项目目录下
        try {
            execSync(`sudo -n cp "${projectDir}/"agent-*.jsonl "${snapshotDir}/subagents/" 2>/dev/null`, { stdio: 'ignore' });
        } catch (e) { /* ignore */ }

        // 新格式：通过 config 的 leadSessionId 定位
        try {
            const configContent = execSync(`sudo -n cat "${snapshotDir}/config.json" 2>/dev/null || echo ""`, { encoding: 'utf8' }).trim();
            if (configContent) {
                const teamConfig = JSON.parse(configContent);
                const sessionId = teamConfig.leadSessionId;
                if (sessionId) {
                    const subagentsDir = path.join(projectDir, sessionId, 'subagents');
                    try {
                        const saExists = execSync(`sudo -n test -d "${subagentsDir}" && echo yes || echo no`, { encoding: 'utf8' }).trim();
                        if (saExists === 'yes') {
                            execSync(`sudo -n cp "${subagentsDir}/"*.jsonl "${snapshotDir}/subagents/" 2>/dev/null`, { stdio: 'ignore' });
                            console.log(`[Snapshot] Copied subagents from ${subagentsDir}`);
                        }
                    } catch (e) { /* ignore */ }
                }
            }
        } catch (e) { /* ignore */ }
    } catch (e) { console.log(`[Snapshot] Failed to process subagents:`, e.message); }

    // 修复权限，确保服务进程可读
    try {
        execSync(`chmod -R a+rX "${snapshotDir}"`, { stdio: 'ignore' });
    } catch (e) { /* ignore */ }

    console.log(`[Snapshot] Agent Teams snapshot completed for ${taskId}/${modelId}`);
}

/**
 * 清理指定任务/模型的进程
 */
function cleanup(taskId, modelId) {
    const subtaskKey = `${taskId}/${modelId}`;
    const processes = activeProcesses.get(subtaskKey);

    if (processes) {
        console.log(`[Executor] Cleaning up ${subtaskKey}`);
        try {
            processes.child.kill('SIGTERM');
            if (processes.ingestHandler && !processes.ingestHandler.isFinished()) {
                processes.ingestHandler.finish();
            }
        } catch (e) { }
        activeProcesses.delete(subtaskKey);
    }
}

/**
 * 清理所有活跃进程 — 优雅分离模式
 * 不杀死子进程，只保存状态并断开连接，让子进程继续运行
 * 重启后由 watchdogService.recoverOrphanedTasks() 重连
 */
function cleanupAll() {
    console.log('[Executor] Graceful shutdown - detaching processes...');
    for (const [key, entry] of activeProcesses) {
        try {
            // 保存 stdout offset 到 DB（用于重启后续读）
            if (entry.fileTailer) {
                const offset = entry.fileTailer.getOffset();
                const [taskId, modelId] = key.split('/');
                try {
                    db.prepare('UPDATE model_runs SET stdout_offset = ? WHERE task_id = ? AND model_id = ?')
                        .run(offset, taskId, modelId);
                } catch (e) { /* DB may already be closing */ }
                entry.fileTailer.stop();
            }
            if (entry.stderrTailer) entry.stderrTailer.stop();
            if (entry.logStream) entry.logStream.end();
            // flush 统计但不 finish（进程还活着）
            if (entry.ingestHandler && !entry.ingestHandler.isFinished()) {
                try { entry.ingestHandler.flush(); } catch (e) { /* ignore */ }
            }
        } catch (e) {
            console.error(`[Executor] Detach error for ${key}:`, e.message);
        }
    }
    activeProcesses.clear();
    console.log('[Executor] All processes detached, server can safely exit');
}

// 信号处理：优雅分离后退出
process.on('SIGTERM', () => { cleanupAll(); process.exit(0); });
process.on('SIGINT', () => { cleanupAll(); process.exit(0); });

// 初始化
initialize();

module.exports = {
    executeModel,
    cleanup,
    cleanupAll,
    activeProcesses,
    getConfig: () => executorConfig,
    snapshotAgentTeamFiles
};
