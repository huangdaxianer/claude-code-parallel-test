/**
 * Watchdog Service - 检测并恢复卡死的子任务
 * 定期检查活跃进程的健康状态，自动清理超时和孤儿任务
 */
const db = require('../db');
const config = require('../config');

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
 * 执行一次健康检查
 */
function checkHealth() {
    // 延迟 require 避免循环依赖
    const executorService = require('./executorService');
    const queueService = require('./queueService');

    const appConfig = config.getAppConfig();
    const activityTimeoutMs = (appConfig.activityTimeoutMinutes || 10) * 60 * 1000;
    const wallClockTimeoutMs = (appConfig.subtaskTimeoutMinutes || 60) * 60 * 1000;
    const now = Date.now();

    // Phase 1: 检查活跃进程是否卡死或超时
    for (const [key, info] of executorService.activeProcesses) {
        const { lastActivityTime } = info;

        // 活动超时：stdout 长时间无输出
        if (lastActivityTime && (now - lastActivityTime) > activityTimeoutMs) {
            const idleMinutes = Math.floor((now - lastActivityTime) / 60000);
            console.warn(`[Watchdog] Activity timeout: ${key} (${idleMinutes}min idle, limit: ${appConfig.activityTimeoutMinutes || 10}min)`);
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
                    const totalMinutes = Math.floor((now - startedAt) / 60000);
                    console.warn(`[Watchdog] Wall-clock timeout: ${key} (${totalMinutes}min elapsed, limit: ${appConfig.subtaskTimeoutMinutes || 60}min)`);
                    killStuckSubtask(key, info, 'wall_clock_timeout', executorService, queueService);
                }
            }
        } catch (e) {
            console.error(`[Watchdog] Error checking wall-clock for ${key}:`, e.message);
        }
    }

    // Phase 2: 检测孤儿记录（DB 中 running 但进程已不存在）
    try {
        const runningRuns = db.prepare(
            "SELECT task_id, model_id FROM model_runs WHERE status = 'running'"
        ).all();
        for (const run of runningRuns) {
            const key = `${run.task_id}/${run.model_id}`;
            if (!executorService.activeProcesses.has(key)) {
                console.warn(`[Watchdog] Orphaned DB record: ${key}, marking as stopped`);
                db.prepare(
                    "UPDATE model_runs SET status = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_id = ?"
                ).run(run.task_id, run.model_id);
                queueService.checkAndUpdateTaskStatus(run.task_id);
            }
        }
    } catch (e) {
        console.error('[Watchdog] Error checking orphaned records:', e.message);
    }
}

/**
 * 杀死卡死的子任务并更新状态
 */
function killStuckSubtask(key, info, reason, executorService, queueService) {
    const { child, ingestHandler } = info;
    const [taskId, modelId] = key.split('/');

    console.log(`[Watchdog] Killing stuck subtask ${key} (reason: ${reason})`);

    // 1. 杀进程（进程组 kill，因为 detached: true 创建了新进程组）
    try {
        process.kill(-child.pid, 'SIGTERM');
        // 5 秒后强制 SIGKILL 兜底
        setTimeout(() => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* already dead */ }
        }, 5000);
    } catch (e) {
        // 进程组 kill 失败，尝试直接 kill
        try { child.kill('SIGKILL'); } catch (e2) { /* already dead */ }
    }

    // 2. 完成 ingest handler（刷新待写入的统计数据到 DB）
    if (ingestHandler && !ingestHandler.isFinished()) {
        try {
            ingestHandler.finish();
        } catch (e) {
            console.error(`[Watchdog] Error finishing ingest for ${key}:`, e.message);
        }
    }

    // 3. 更新 DB 状态为 stopped
    try {
        db.prepare(
            "UPDATE model_runs SET status = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_id = ? AND status = 'running'"
        ).run(taskId, modelId);
    } catch (e) {
        console.error(`[Watchdog] Error updating DB for ${key}:`, e.message);
    }

    // 4. 清理进程引用
    executorService.activeProcesses.delete(key);
    delete queueService.activeSubtaskProcesses[key];

    // 5. 重新计算父任务状态
    queueService.checkAndUpdateTaskStatus(taskId);
}

/**
 * 服务器启动时恢复上次遗留的卡死任务
 * 上次服务器实例的进程已全部消失，running 状态的记录都是孤儿
 */
function recoverOrphanedTasks() {
    // 延迟 require 避免循环依赖
    const queueService = require('./queueService');

    console.log('[Watchdog] Checking for orphaned tasks from previous run...');

    try {
        const orphanedRuns = db.prepare(
            "SELECT task_id, model_id FROM model_runs WHERE status = 'running'"
        ).all();

        if (orphanedRuns.length === 0) {
            console.log('[Watchdog] No orphaned tasks found');
            return;
        }

        console.log(`[Watchdog] Found ${orphanedRuns.length} orphaned running model_runs`);

        // 标记所有孤儿为 stopped
        const updateStmt = db.prepare(
            "UPDATE model_runs SET status = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_id = ?"
        );
        for (const run of orphanedRuns) {
            updateStmt.run(run.task_id, run.model_id);
        }

        // 重新计算受影响任务的状态
        const taskIds = [...new Set(orphanedRuns.map(r => r.task_id))];
        for (const taskId of taskIds) {
            queueService.checkAndUpdateTaskStatus(taskId);
        }

        console.log(`[Watchdog] Recovered ${orphanedRuns.length} orphaned runs across ${taskIds.length} tasks`);
    } catch (e) {
        console.error('[Watchdog] Error during startup recovery:', e.message);
    }
}

module.exports = { start, checkHealth, recoverOrphanedTasks };
