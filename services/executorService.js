const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('../db');
const config = require('../config');

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

/**
 * 构建环境变量（支持每个模型独立的 API 配置）
 * @param {Object} modelConfig - 模型配置，可包含 apiBaseUrl 和 apiKey
 */
function buildEnv(modelConfig = {}) {
    return {
        ...process.env,
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        ANTHROPIC_AUTH_TOKEN: modelConfig.apiKey || process.env.ANTHROPIC_AUTH_TOKEN,
        ANTHROPIC_BASE_URL: modelConfig.apiBaseUrl || process.env.ANTHROPIC_BASE_URL,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || '1'
    };
}

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

    // 构建 Claude CLI 参数（使用 modelName 作为 --model 值）
    const claudeArgs = [
        '--model', actualModelName,
        '--allowedTools', 'Read(./**),Edit(./**),Bash(.**/*)',
        '--disallowedTools', 'EnterPlanMode,ExitPlanMode',
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose'
    ];

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

        const envVars = buildEnv(modelConfig);
        if (executorConfig.useIsolation) {
            // 隔离用户模式
            child = spawn('sudo', [
                '-n', '-H', '-u', 'claude-user',
                'env',
                `ANTHROPIC_AUTH_TOKEN=${envVars.ANTHROPIC_AUTH_TOKEN}`,
                `ANTHROPIC_BASE_URL=${envVars.ANTHROPIC_BASE_URL}`,
                `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=${envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC}`,
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
        const envVars = buildEnv(modelConfig);

        if (executorConfig.useIsolation) {
            child = spawn('sudo', [
                '-n', '-H', '-u', 'claude-user',
                'env',
                `ANTHROPIC_AUTH_TOKEN=${envVars.ANTHROPIC_AUTH_TOKEN}`,
                `ANTHROPIC_BASE_URL=${envVars.ANTHROPIC_BASE_URL}`,
                `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=${envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC}`,
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
    });

    return child;
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
