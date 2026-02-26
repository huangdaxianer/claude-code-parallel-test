const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('../db');
const config = require('../config');
const { buildSafeEnv } = require('../utils/envWhitelist');

// 活跃进程 Map<"taskId/modelId", ChildProcess>
const activeProcesses = new Map();

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
            '- Read the team config file at `~/.claude/teams/*/config.json` to find your team name and your agent name.',
            '- Then read your inbox file at `~/.claude/teams/{team-name}/inboxes/{your-agent-name}.json`.',
            '- Process any unread messages (where `read` is false) and act on them.',
            '',
            'IMPORTANT: Do NOT rely on automatic message delivery. Always manually check your inbox at the moments described above.',
            '',
            '## Team Naming Convention',
            '',
            'When creating a team with TeamCreate, you MUST use the exact string "' + taskId + '-' + modelId + '" as the team_name.',
            'Do NOT invent your own team name. This naming convention is required for the platform to track your sub-agents.',
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

    // 选择执行方式
    let child;

    if (executorConfig.hasFirejail) {
        // 使用 firejail 沙箱
        const firejailArgs = buildFirejailArgs(taskRoot, modelId);
        const fullArgs = [...firejailArgs, '--', executorConfig.claudeBin, ...claudeArgs];

        console.log(`[Executor] Using firejail sandbox for ${subtaskKey}`);

        const envVars = buildSafeEnv(modelId);
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
                ...(envVars.alwaysThinkingEnabled ? [`alwaysThinkingEnabled=${envVars.alwaysThinkingEnabled}`] : []),
                ...(envVars.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS ? [`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=${envVars.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS}`] : []),
                'firejail', ...fullArgs
            ], {
                cwd: folderPath,
                env: envVars,
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: true
            });
        } else {
            child = spawn('firejail', fullArgs, {
                cwd: folderPath,
                env: envVars,
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: true
            });
        }
    } else {
        // 无沙箱模式
        console.log(`[Executor] Running without sandbox for ${subtaskKey}`);
        const envVars = buildSafeEnv(modelId);
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
                ...(envVars.alwaysThinkingEnabled ? [`alwaysThinkingEnabled=${envVars.alwaysThinkingEnabled}`] : []),
                ...(envVars.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS ? [`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=${envVars.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS}`] : []),
                executorConfig.claudeBin, ...claudeArgs
            ], {
                cwd: folderPath,
                env: envVars,
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: true
            });
        } else {
            child = spawn(executorConfig.claudeBin, claudeArgs, {
                cwd: folderPath,
                env: envVars,
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: true
            });
        }
    }

    // 写入 prompt 到 stdin
    child.stdin.write(prompt);
    child.stdin.end();

    // 使用 IngestHandler 直接处理输出（不再 spawn 独立进程）
    const { IngestHandler } = require('./ingestHandler');
    const readline = require('readline');

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

    // 创建 readline 接口处理 stdout
    const rl = readline.createInterface({
        input: child.stdout,
        terminal: false
    });

    rl.on('line', (line) => {
        const sanitized = sanitizeLine(line);
        logStream.write(sanitized + '\n');
        ingestHandler.processLine(sanitized);
        // 更新最后活动时间，供 watchdog 检测卡死
        const entry = activeProcesses.get(subtaskKey);
        if (entry) entry.lastActivityTime = Date.now();
    });

    child.stderr.on('data', (data) => {
        const sanitized = sanitizeLine(data.toString());
        logStream.write(sanitized);
        console.error(`[Executor ${subtaskKey} STDERR] ${sanitized.slice(0, 200)}`);
    });

    child.on('close', () => {
        logStream.end();
        rl.close();
        if (!ingestHandler.isFinished()) {
            ingestHandler.finish();
        }
    });

    // 保存进程引用（包含每模型超时配置，供 watchdog 使用）
    activeProcesses.set(subtaskKey, {
        child,
        ingestHandler,
        lastActivityTime: Date.now(),
        activityTimeoutSeconds: modelConfig.activityTimeoutSeconds ?? null,
        taskTimeoutSeconds: modelConfig.taskTimeoutSeconds ?? null
    });

    // 清理完成时的回调
    child.on('exit', (code, signal) => {
        console.log(`[Executor ${subtaskKey}] Exited with code ${code}, signal ${signal}`);
        activeProcesses.delete(subtaskKey);

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
 * 清理所有活跃进程
 */
function cleanupAll() {
    console.log('[Executor] Cleaning up all processes...');
    for (const [key, processes] of activeProcesses) {
        try {
            processes.child.kill('SIGTERM');
            if (processes.ingestHandler && !processes.ingestHandler.isFinished()) {
                processes.ingestHandler.finish();
            }
        } catch (e) { }
    }
    activeProcesses.clear();
}

// 进程退出时清理
process.on('exit', cleanupAll);
process.on('SIGTERM', () => { cleanupAll(); process.exit(0); });
process.on('SIGINT', () => { cleanupAll(); process.exit(0); });

// 初始化
initialize();

module.exports = {
    executeModel,
    cleanup,
    cleanupAll,
    activeProcesses,
    getConfig: () => executorConfig
};
