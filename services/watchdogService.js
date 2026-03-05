/**
 * Watchdog Service - 检测并恢复卡死的子任务 + 进程重连
 * 定期检查活跃进程的健康状态，自动清理超时和孤儿任务
 * 服务重启时尝试重连仍在运行的子进程（而非一律标记为 server_restart）
 */
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const { FileTailer } = require('../utils/fileTailer');

let watchdogInterval = null;

/**
 * 启动定期健康检查（每 30 秒）
 */
function start() {
    if (watchdogInterval) return;
    console.log('[Watchdog] Starting health monitor (30s interval)');
    watchdogInterval = setInterval(checkHealth, 30000);
}

/**
 * 检查进程是否存活（先尝试进程组，再尝试单进程）
 */
function isProcessAlive(pid) {
    try { process.kill(-pid, 0); return true; } catch (e) {
        try { process.kill(pid, 0); return true; } catch (e2) { return false; }
    }
}

/**
 * PID 安全校验：确认 PID 确实是我们的 Claude CLI 进程（防 PID 重用）
 * 通过检查 stdout 文件是否还在增长或近期有修改来判断
 */
function isOurProcess(pid, stdoutFile, lastOffset) {
    if (!isProcessAlive(pid)) return false;
    try {
        const stat = fs.statSync(stdoutFile);
        if (stat.size > lastOffset) return true;       // 文件还在增长
        if (Date.now() - stat.mtimeMs < 300000) return true;  // 5 分钟内有修改
        return false;  // PID 可能已被复用
    } catch (e) { return false; }
}

/**
 * 执行一次健康检查
 */
function checkHealth() {
    // 延迟 require 避免循环依赖
    const executorService = require('./executorService');
    const queueService = require('./queueService');

    const appConfig = config.getAppConfig();
    const defaultActivityTimeoutMs = (appConfig.activityTimeoutMinutes || 10) * 60 * 1000;
    const defaultWallClockTimeoutMs = (appConfig.subtaskTimeoutMinutes || 60) * 60 * 1000;
    const now = Date.now();

    // Phase 1: 检查活跃进程是否卡死或超时
    for (const [key, info] of executorService.activeProcesses) {
        const { lastActivityTime } = info;

        // 使用模型级别的超时配置，如果未设置则回退到全局默认值
        const activityTimeoutMs = info.activityTimeoutSeconds != null
            ? info.activityTimeoutSeconds * 1000
            : defaultActivityTimeoutMs;
        const wallClockTimeoutMs = info.taskTimeoutSeconds != null
            ? info.taskTimeoutSeconds * 1000
            : defaultWallClockTimeoutMs;

        // 活动超时：stdout 长时间无输出
        if (lastActivityTime && (now - lastActivityTime) > activityTimeoutMs) {
            const idleSec = Math.floor((now - lastActivityTime) / 1000);
            const limitSec = Math.floor(activityTimeoutMs / 1000);
            console.warn(`[Watchdog] Activity timeout: ${key} (${idleSec}s idle, limit: ${limitSec}s)`);
            killStuckSubtask(key, info, 'activity_timeout', executorService, queueService);
            continue;
        }

        // 墙钟超时：总执行时间超限
        const [taskId, modelId] = key.split('/');
        try {
            const run = db.prepare(
                'SELECT started_at FROM model_runs WHERE task_id = ? AND model_id = ?'
            ).get(taskId, modelId);
            if (run && run.started_at) {
                const startedAt = new Date(run.started_at + 'Z').getTime();
                if ((now - startedAt) > wallClockTimeoutMs) {
                    const totalSec = Math.floor((now - startedAt) / 1000);
                    const limitSec = Math.floor(wallClockTimeoutMs / 1000);
                    console.warn(`[Watchdog] Wall-clock timeout: ${key} (${totalSec}s elapsed, limit: ${limitSec}s)`);
                    killStuckSubtask(key, info, 'wall_clock_timeout', executorService, queueService);
                }
            }
        } catch (e) {
            console.error(`[Watchdog] Error checking wall-clock for ${key}:`, e.message);
        }
    }

    // Phase 2: 检测孤儿记录（DB 中 running 但进程已不存在）
    // 双重校验：同时检查 executorService 和 queueService 的进程引用
    // 时间窗口保护：updated_at 距现在不足 60 秒的记录跳过（可能正在重试调度中）
    try {
        const runningRuns = db.prepare(
            "SELECT task_id, model_id, updated_at FROM model_runs WHERE status = 'running'"
        ).all();
        for (const run of runningRuns) {
            const key = `${run.task_id}/${run.model_id}`;
            // 双重校验：任一 Map 中存在即视为活跃
            if (executorService.activeProcesses.has(key) || queueService.activeSubtaskProcesses[key]) {
                continue;
            }
            // 时间窗口保护：刚变为 running 的记录可能还在调度中，不立即判定为 orphaned
            if (run.updated_at) {
                const updatedAt = new Date(run.updated_at + (run.updated_at.endsWith('Z') ? '' : 'Z')).getTime();
                if ((now - updatedAt) < 60000) {
                    continue;
                }
            }
            console.warn(`[Watchdog] Orphaned DB record: ${key}, marking as stopped`);
            db.prepare(
                "UPDATE model_runs SET status = 'stopped', stop_reason = 'orphaned', pid = NULL, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_id = ?"
            ).run(run.task_id, run.model_id);
            queueService.checkAndUpdateTaskStatus(run.task_id);
        }
    } catch (e) {
        console.error('[Watchdog] Error checking orphaned records:', e.message);
    }

    // Phase 3: 监控重连进程的存活状态
    for (const [key, info] of executorService.activeProcesses) {
        if (!info.isReattached) continue;

        const pid = info.pid;
        if (!pid || !isProcessAlive(pid)) {
            console.log(`[Watchdog] Reattached process died: ${key} (PID ${pid})`);
            handleReattachedProcessDeath(key, info, executorService, queueService);
        }
    }
}

/**
 * 杀死卡死的子任务并更新状态
 * 支持 child 对象和 PID-only 的重连条目
 */
function killStuckSubtask(key, info, reason, executorService, queueService) {
    const [taskId, modelId] = key.split('/');
    const pid = info.pid || (info.child && info.child.pid);

    console.log(`[Watchdog] Killing stuck subtask ${key} (reason: ${reason}, PID: ${pid})`);

    // 1. 杀进程
    if (pid) {
        try {
            process.kill(-pid, 'SIGTERM');
            // 5 秒后强制 SIGKILL 兜底
            setTimeout(() => {
                try { process.kill(-pid, 'SIGKILL'); } catch (e) { /* already dead */ }
            }, 5000);
        } catch (e) {
            // 进程组 kill 失败，尝试直接 kill
            try { process.kill(pid, 'SIGKILL'); } catch (e2) { /* already dead */ }
        }
    } else if (info.child) {
        try { info.child.kill('SIGKILL'); } catch (e) { /* already dead */ }
    }

    // 2. 停止 FileTailer
    if (info.fileTailer) {
        try { info.fileTailer.pollOnce(); info.fileTailer.stop(); } catch (e) { /* ignore */ }
    }
    if (info.stderrTailer) {
        try { info.stderrTailer.pollOnce(); info.stderrTailer.stop(); } catch (e) { /* ignore */ }
    }

    // 3. 关闭 logStream
    if (info.logStream) {
        try { info.logStream.end(); } catch (e) { /* ignore */ }
    }

    // 4. 完成 ingest handler（刷新待写入的统计数据到 DB）
    if (info.ingestHandler && !info.ingestHandler.isFinished()) {
        try {
            info.ingestHandler.finish();
        } catch (e) {
            console.error(`[Watchdog] Error finishing ingest for ${key}:`, e.message);
        }
    }

    // 5. 更新 DB 状态为 stopped，记录中止原因，清除 PID
    try {
        db.prepare(
            "UPDATE model_runs SET status = 'stopped', stop_reason = ?, pid = NULL, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_id = ? AND status = 'running'"
        ).run(reason, taskId, modelId);
    } catch (e) {
        console.error(`[Watchdog] Error updating DB for ${key}:`, e.message);
    }

    // 6. 清理进程引用
    executorService.activeProcesses.delete(key);
    delete queueService.activeSubtaskProcesses[key];

    // 7. 重新计算父任务状态
    queueService.checkAndUpdateTaskStatus(taskId);
}

/**
 * 处理重连进程自然结束
 */
function handleReattachedProcessDeath(key, info, executorService, queueService) {
    const [taskId, modelId] = key.split('/');

    // 1. FileTailer 最终刷新
    if (info.fileTailer) {
        try { info.fileTailer.pollOnce(); info.fileTailer.stop(); } catch (e) { /* ignore */ }
    }
    if (info.stderrTailer) {
        try { info.stderrTailer.pollOnce(); info.stderrTailer.stop(); } catch (e) { /* ignore */ }
    }
    if (info.logStream) {
        try { info.logStream.end(); } catch (e) { /* ignore */ }
    }

    // 2. 完成 IngestHandler
    if (info.ingestHandler && !info.ingestHandler.isFinished()) {
        try { info.ingestHandler.finish(); } catch (e) { /* ignore */ }
    }

    // 3. 根据 IngestHandler 的最终状态决定后续处理
    const currentStatus = db.prepare("SELECT status, stop_reason FROM model_runs WHERE task_id = ? AND model_id = ?").get(taskId, modelId);
    if (currentStatus) {
        if (currentStatus.status === 'completed') {
            console.log(`[Watchdog] Reattached process completed successfully: ${key}`);
            // 触发预览
            const previewService = require('./previewService');
            previewService.preparePreview(taskId, modelId).catch(err => {
                console.error(`[Watchdog] Failed to trigger preview for ${key}:`, err);
            });
        } else if (currentStatus.status === 'running') {
            // 进程死了但 IngestHandler 没收到 result 事件 = 崩溃
            console.warn(`[Watchdog] Reattached process crashed without result: ${key}`);
            if (!queueService.tryAutoRetry(taskId, modelId)) {
                db.prepare("UPDATE model_runs SET status = 'stopped', stop_reason = 'non_zero_exit', pid = NULL, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_id = ?")
                    .run(taskId, modelId);
            }
        } else if (currentStatus.status === 'stopped' && currentStatus.stop_reason !== 'manual_stop') {
            // IngestHandler 检测到 is_error / abnormal_completion
            console.warn(`[Watchdog] Reattached process stopped with reason: ${currentStatus.stop_reason} for ${key}`);
            queueService.tryAutoRetry(taskId, modelId);
        }
    }

    // 4. 清除 DB 中的 pid
    try {
        db.prepare('UPDATE model_runs SET pid = NULL WHERE task_id = ? AND model_id = ?').run(taskId, modelId);
    } catch (e) { /* ignore */ }

    // 5. Agent Teams 快照保全
    try {
        const task = db.prepare('SELECT enable_agent_teams FROM tasks WHERE task_id = ?').get(taskId);
        if (task && task.enable_agent_teams) {
            const executorModule = require('./executorService');
            if (typeof executorModule.snapshotAgentTeamFiles === 'function') {
                const folderPath = path.join(config.TASKS_DIR, taskId, modelId);
                executorModule.snapshotAgentTeamFiles(taskId, modelId, folderPath);
            }
        }
    } catch (e) {
        console.error(`[Watchdog] Agent Teams snapshot failed for ${key}:`, e.message);
    }

    // 6. 清理引用
    executorService.activeProcesses.delete(key);
    delete queueService.activeSubtaskProcesses[key];

    // 7. 重新计算父任务状态 + 触发队列
    queueService.checkAndUpdateTaskStatus(taskId);
    setTimeout(() => queueService.processQueue(), 100);
}

/**
 * 重连单个进程
 */
function reattachProcess(run) {
    const executorService = require('./executorService');
    const queueService = require('./queueService');
    const { IngestHandler } = require('./ingestHandler');

    const key = `${run.task_id}/${run.model_id}`;
    console.log(`[Watchdog] Re-attaching to PID ${run.pid} for ${key} (offset: ${run.stdout_offset})`);

    try {
        // 构建 sanitizeLine 函数（从 DB 读取模型的 API 配置）
        const modelConfig = db.prepare("SELECT api_key, api_base_url FROM model_configs WHERE model_id = ?").get(run.model_id);
        const sensitiveValues = [];
        const authToken = (modelConfig && modelConfig.api_key) || process.env.ANTHROPIC_AUTH_TOKEN;
        const baseUrl = (modelConfig && modelConfig.api_base_url) || process.env.ANTHROPIC_BASE_URL;
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

        // 创建 resume 模式的 IngestHandler
        const ingestHandler = IngestHandler.resume(run.task_id, run.model_id);

        // 打开 logStream（append 模式）
        const logsDir = path.join(config.TASKS_DIR, run.task_id, 'logs');
        const logFile = path.join(logsDir, `${run.model_id}.txt`);
        fs.mkdirSync(logsDir, { recursive: true });
        const logStream = fs.createWriteStream(logFile, { flags: 'a' });

        // 获取模型超时配置
        const timeoutConfig = db.prepare("SELECT activity_timeout_seconds, task_timeout_seconds FROM model_configs WHERE model_id = ?").get(run.model_id);

        // FileTailer 从断点续读
        const fileTailer = new FileTailer(run.stdout_file, run.stdout_offset || 0, (line) => {
            const sanitized = sanitizeLine(line);
            logStream.write(sanitized + '\n');
            ingestHandler.processLine(sanitized);
            const entry = executorService.activeProcesses.get(key);
            if (entry) entry.lastActivityTime = Date.now();
        });
        fileTailer.start();

        // stderr tailer（从头开始，无需精确续读）
        const stderrFile = run.stdout_file.replace(/\.stdout$/, '.stderr');
        let stderrTailer = null;
        try {
            if (fs.existsSync(stderrFile)) {
                stderrTailer = new FileTailer(stderrFile, 0, (line) => {
                    const sanitized = sanitizeLine(line);
                    logStream.write(sanitized + '\n');
                    console.error(`[Executor ${key} STDERR] ${sanitized.slice(0, 200)}`);
                }, { pollInterval: 1000 });
                stderrTailer.start();
            }
        } catch (e) { /* ignore */ }

        // 注册到 activeProcesses（child 为 null，标记为重连）
        executorService.activeProcesses.set(key, {
            child: null,
            ingestHandler,
            fileTailer,
            stderrTailer,
            logStream,
            lastActivityTime: Date.now(),
            activityTimeoutSeconds: timeoutConfig ? timeoutConfig.activity_timeout_seconds : null,
            taskTimeoutSeconds: timeoutConfig ? timeoutConfig.task_timeout_seconds : null,
            pid: run.pid,
            isReattached: true
        });

        // 注册到 queueService 的 activeSubtaskProcesses
        queueService.activeSubtaskProcesses[key] = { pid: run.pid, isReattached: true };

        console.log(`[Watchdog] Successfully re-attached to ${key} (PID ${run.pid})`);
        return true;
    } catch (e) {
        console.error(`[Watchdog] Failed to re-attach ${key}:`, e.message);
        return false;
    }
}

/**
 * 处理 stdout 文件中剩余未消费的输出（进程已死但有残余数据）
 */
function processRemainingOutput(run) {
    const { IngestHandler } = require('./ingestHandler');
    const key = `${run.task_id}/${run.model_id}`;

    try {
        if (!run.stdout_file || !fs.existsSync(run.stdout_file)) return;

        const stat = fs.statSync(run.stdout_file);
        const offset = run.stdout_offset || 0;
        if (stat.size <= offset) return; // 没有新数据

        console.log(`[Watchdog] Processing remaining output for ${key} (${stat.size - offset} bytes)`);

        // 构建 sanitizeLine 函数
        const modelConfig = db.prepare("SELECT api_key, api_base_url FROM model_configs WHERE model_id = ?").get(run.model_id);
        const sensitiveValues = [];
        const authToken = (modelConfig && modelConfig.api_key) || process.env.ANTHROPIC_AUTH_TOKEN;
        const baseUrl = (modelConfig && modelConfig.api_base_url) || process.env.ANTHROPIC_BASE_URL;
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

        // 创建 resume 模式的 IngestHandler
        const ingestHandler = IngestHandler.resume(run.task_id, run.model_id);

        // 读取剩余内容
        const fd = fs.openSync(run.stdout_file, 'r');
        const buf = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buf, 0, stat.size - offset, offset);
        fs.closeSync(fd);

        const content = buf.toString('utf8');
        const lines = content.split('\n');
        for (const line of lines) {
            if (line.trim()) {
                ingestHandler.processLine(sanitizeLine(line));
            }
        }
        ingestHandler.finish();

        console.log(`[Watchdog] Processed remaining output for ${key}, final status: ${ingestHandler.stats ? ingestHandler.stats.status : 'unknown'}`);
    } catch (e) {
        console.error(`[Watchdog] Error processing remaining output for ${key}:`, e.message);
    }
}

/**
 * 服务器启动时恢复上次遗留的卡死任务
 * 对每条 status='running' 的 model_run:
 *   1. 有 pid + stdout_file 且进程存活？→ 重连
 *   2. 有 pid + stdout_file 但进程已死？→ 处理剩余输出 → 标记 stopped
 *   3. 无 pid（旧进程 / pre-migration）？→ 标记 server_restart（保持原有行为）
 */
function recoverOrphanedTasks() {
    // 延迟 require 避免循环依赖
    const queueService = require('./queueService');

    console.log('[Watchdog] Checking for orphaned tasks from previous run...');

    try {
        const orphanedRuns = db.prepare(
            "SELECT task_id, model_id, pid, stdout_file, stdout_offset FROM model_runs WHERE status = 'running'"
        ).all();

        if (orphanedRuns.length === 0) {
            console.log('[Watchdog] No orphaned tasks found');
            return;
        }

        console.log(`[Watchdog] Found ${orphanedRuns.length} orphaned running model_runs`);

        let reattached = 0;
        let processed = 0;
        let markedRestart = 0;

        for (const run of orphanedRuns) {
            const key = `${run.task_id}/${run.model_id}`;

            if (run.pid && run.stdout_file && fs.existsSync(run.stdout_file)) {
                // 有 PID + stdout_file：尝试重连
                if (isOurProcess(run.pid, run.stdout_file, run.stdout_offset || 0)) {
                    // 进程还活着，重连！
                    if (reattachProcess(run)) {
                        reattached++;
                        continue;
                    }
                }
                // 进程已死，处理残余输出
                processRemainingOutput(run);
                // 检查 IngestHandler 是否已经将状态更新为 completed/stopped
                const currentStatus = db.prepare("SELECT status FROM model_runs WHERE task_id = ? AND model_id = ?").get(run.task_id, run.model_id);
                if (currentStatus && currentStatus.status === 'running') {
                    // IngestHandler 没有将状态改为 completed，说明进程异常结束
                    if (!queueService.tryAutoRetry(run.task_id, run.model_id)) {
                        db.prepare(
                            "UPDATE model_runs SET status = 'stopped', stop_reason = 'server_restart', pid = NULL, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_id = ?"
                        ).run(run.task_id, run.model_id);
                    }
                } else {
                    // 状态已由 IngestHandler 更新，清除 PID
                    db.prepare('UPDATE model_runs SET pid = NULL WHERE task_id = ? AND model_id = ?').run(run.task_id, run.model_id);
                    // 如果 completed，触发预览
                    if (currentStatus && currentStatus.status === 'completed') {
                        const previewService = require('./previewService');
                        previewService.preparePreview(run.task_id, run.model_id).catch(() => {});
                    }
                }
                processed++;
            } else {
                // 无 PID 或无 stdout_file（旧进程 / pre-migration）
                // 如果有 PID 且进程还活着，kill 它
                if (run.pid && isProcessAlive(run.pid)) {
                    console.warn(`[Watchdog] Killing legacy process PID ${run.pid} for ${key}`);
                    try { process.kill(-run.pid, 'SIGTERM'); } catch (e) {
                        try { process.kill(run.pid, 'SIGKILL'); } catch (e2) { /* ignore */ }
                    }
                }
                // 标记为 server_restart
                db.prepare(
                    "UPDATE model_runs SET status = 'stopped', stop_reason = 'server_restart', pid = NULL, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_id = ?"
                ).run(run.task_id, run.model_id);
                markedRestart++;
            }
        }

        // 重新计算受影响任务的状态
        const taskIds = [...new Set(orphanedRuns.map(r => r.task_id))];
        for (const taskId of taskIds) {
            queueService.checkAndUpdateTaskStatus(taskId);
        }

        console.log(`[Watchdog] Recovery complete: ${reattached} re-attached, ${processed} processed remaining output, ${markedRestart} marked as server_restart (across ${taskIds.length} tasks)`);
    } catch (e) {
        console.error('[Watchdog] Error during startup recovery:', e.message);
    }
}

module.exports = { start, checkHealth, recoverOrphanedTasks };
