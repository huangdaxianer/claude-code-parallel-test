/**
 * 队列服务
 * 管理任务队列调度和子任务执行
 */
const db = require('../db');
const config = require('../config');
const previewService = require('./previewService');

// 活跃的子任务进程 Map<"taskId/modelName", ChildProcess>
const activeSubtaskProcesses = {};
let isProcessingQueue = false;

// 处理队列 - 子任务级别调度
async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
        // 统计当前运行中的子任务数量
        const runningCount = db.prepare("SELECT COUNT(*) as count FROM model_runs WHERE status = 'running'").get().count;
        const maxParallel = config.getAppConfig().maxParallelSubtasks || 5;

        if (runningCount >= maxParallel) {
            console.log(`[Queue] Max parallel subtasks reached (${runningCount}/${maxParallel})`);
            return;
        }

        // 计算可用槽位
        const availableSlots = maxParallel - runningCount;

        // 获取待执行的子任务（包含模型的自定义 API 配置和超时设置）
        const pendingSubtasks = db.prepare(`
            SELECT mr.id, mr.task_id, mr.model_id, t.title,
                   mc.endpoint_name, mc.api_base_url, mc.api_key, mc.model_name,
                   mc.activity_timeout_seconds, mc.task_timeout_seconds
            FROM model_runs mr
            JOIN tasks t ON mr.task_id = t.task_id
            JOIN task_queue tq ON mr.task_id = tq.task_id
            LEFT JOIN model_configs mc ON mc.model_id = mr.model_id
            WHERE mr.status = 'pending' AND tq.status != 'stopped'
            ORDER BY tq.created_at ASC, mr.id ASC
            LIMIT ?
        `).all(availableSlots);

        if (pendingSubtasks.length === 0) {
            return;
        }

        console.log(`[Queue] Starting ${pendingSubtasks.length} subtasks (${runningCount}/${maxParallel} running)`);

        // 启动每个子任务
        for (const subtask of pendingSubtasks) {
            db.prepare("UPDATE model_runs SET status = 'running', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(subtask.id);
            db.prepare("UPDATE task_queue SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE task_id = ?").run(subtask.task_id);
            console.log(`[Queue] Starting subtask: ${subtask.task_id}/${subtask.model_id} (endpoint: ${subtask.endpoint_name}, model: ${subtask.model_name || subtask.endpoint_name})`);
            // Pass model_id for folder naming and modelConfig for API request + timeout settings
            executeSubtask(subtask.task_id, subtask.model_id, {
                endpointName: subtask.endpoint_name,
                apiBaseUrl: subtask.api_base_url || null,
                apiKey: subtask.api_key || null,
                modelName: subtask.model_name || null,
                activityTimeoutSeconds: subtask.activity_timeout_seconds ?? null,
                taskTimeoutSeconds: subtask.task_timeout_seconds ?? null
            });
        }
    } catch (e) {
        console.error('[Queue] Error processing queue:', e);
    } finally {
        isProcessingQueue = false;
        setTimeout(processQueue, 500);
    }
}

// 检查中止的子任务是否可以自动重试，返回 true 表示已安排重试
function tryAutoRetry(taskId, modelId) {
    try {
        const run = db.prepare("SELECT retry_count FROM model_runs WHERE task_id = ? AND model_id = ?").get(taskId, modelId);
        const modelConfig = db.prepare("SELECT auto_retry_limit FROM model_configs WHERE model_id = ?").get(modelId);

        if (!run || !modelConfig) return false;

        const retryLimit = modelConfig.auto_retry_limit || 0;
        const currentRetryCount = run.retry_count || 0;

        if (currentRetryCount < retryLimit) {
            const newRetryCount = currentRetryCount + 1;

            // 获取 run_id 用于清理日志
            const runRecord = db.prepare("SELECT id FROM model_runs WHERE task_id = ? AND model_id = ?").get(taskId, modelId);
            if (runRecord) {
                db.prepare("DELETE FROM log_entries WHERE run_id = ?").run(runRecord.id);
            }

            // 重置为 pending 状态，增加重试计数，清空之前的运行数据（保留 stop_reason 不清空，最终失败时显示最后一次原因）
            db.prepare(`
                UPDATE model_runs
                SET status = 'pending', retry_count = ?, updated_at = CURRENT_TIMESTAMP,
                    started_at = NULL, duration = NULL, turns = NULL,
                    input_tokens = NULL, output_tokens = NULL, cache_read_tokens = NULL,
                    count_todo_write = NULL, count_read = NULL, count_write = NULL, count_bash = NULL,
                    previewable = NULL
                WHERE task_id = ? AND model_id = ?
            `).run(newRetryCount, taskId, modelId);

            // 确保 task_queue 不是 stopped 状态，以便子任务可以被调度
            db.prepare("UPDATE task_queue SET status = 'pending', completed_at = NULL WHERE task_id = ? AND status = 'stopped'").run(taskId);

            console.log(`[Queue] Auto-retry ${newRetryCount}/${retryLimit} for ${taskId}/${modelId}`);
            return true;
        }

        return false;
    } catch (e) {
        console.error(`[Queue] Auto-retry check error for ${taskId}/${modelId}:`, e);
        return false;
    }
}

// 执行单个模型子任务
function executeSubtask(taskId, modelId, modelConfig) {
    const subtaskKey = `${taskId}/${modelId}`;
    const executorService = require('./executorService');

    let child;
    try {
        child = executorService.executeModel(taskId, modelId, modelConfig);
    } catch (err) {
        console.error(`[Queue] Executor error for ${subtaskKey}:`, err);
        if (!tryAutoRetry(taskId, modelId)) {
            db.prepare("UPDATE model_runs SET status = 'stopped', stop_reason = 'process_error', updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_id = ?").run(taskId, modelId);
        }
        checkAndUpdateTaskStatus(taskId);
        setTimeout(processQueue, 100);
        return;
    }

    activeSubtaskProcesses[subtaskKey] = child;

    child.on('error', (err) => {
        console.error(`[Subtask ${subtaskKey} ERROR] Failed to spawn process:`, err);
        if (!tryAutoRetry(taskId, modelId)) {
            db.prepare("UPDATE model_runs SET status = 'stopped', stop_reason = 'process_error', updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_id = ?").run(taskId, modelId);
        }
        delete activeSubtaskProcesses[subtaskKey];
        checkAndUpdateTaskStatus(taskId);
        setTimeout(processQueue, 100);
    });

    child.on('exit', (code, signal) => {
        console.log(`[Subtask ${subtaskKey} EXIT] Process exited with code ${code} and signal ${signal}`);
        delete activeSubtaskProcesses[subtaskKey];

        const currentStatus = db.prepare("SELECT status, stop_reason FROM model_runs WHERE task_id = ? AND model_id = ?").get(taskId, modelId);
        if (currentStatus && currentStatus.status === 'running') {
            if (code === 0) {
                db.prepare("UPDATE model_runs SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_id = ?").run(taskId, modelId);

                // 如果子任务成功完成，立即生成预览文件夹（隔离环境）并在后台进行 Preparation
                previewService.preparePreview(taskId, modelId).catch(err => {
                    console.error(`[Queue] Failed to trigger preview prep for ${taskId}/${modelId}:`, err);
                });
            } else {
                // 非零退出码 = 中止，尝试自动重试
                if (!tryAutoRetry(taskId, modelId)) {
                    db.prepare("UPDATE model_runs SET status = 'stopped', stop_reason = 'non_zero_exit', updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_id = ?").run(taskId, modelId);
                }
            }
        } else if (currentStatus && currentStatus.status === 'stopped' && currentStatus.stop_reason
                   && currentStatus.stop_reason !== 'manual_stop') {
            // IngestHandler 已将状态设为 stopped（is_error / abnormal_completion 等情况）
            // 进程正常退出（code=0）但 ingestHandler 检测到内容异常，需要尝试自动重试
            console.log(`[Queue] IngestHandler marked ${subtaskKey} as stopped (reason: ${currentStatus.stop_reason}), attempting auto-retry`);
            tryAutoRetry(taskId, modelId);
        }

        checkAndUpdateTaskStatus(taskId);
        setTimeout(processQueue, 100);
    });
}

// 检查并更新任务状态
function checkAndUpdateTaskStatus(taskId) {
    const subtasks = db.prepare("SELECT status FROM model_runs WHERE task_id = ?").all(taskId);

    const allCompleted = subtasks.every(s => s.status === 'completed');
    const allStopped = subtasks.every(s => s.status === 'stopped' || s.status === 'completed');
    const hasRunning = subtasks.some(s => s.status === 'running');
    const hasPending = subtasks.some(s => s.status === 'pending');

    if (allCompleted) {
        db.prepare("UPDATE task_queue SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE task_id = ?").run(taskId);
        console.log(`[Queue] Task ${taskId} completed (all subtasks done)`);
    } else if (allStopped && !hasRunning && !hasPending) {
        db.prepare("UPDATE task_queue SET status = 'stopped', completed_at = CURRENT_TIMESTAMP WHERE task_id = ?").run(taskId);
        console.log(`[Queue] Task ${taskId} stopped (all subtasks stopped or completed)`);
    } else if (hasRunning || hasPending) {
        db.prepare("UPDATE task_queue SET status = 'running' WHERE task_id = ? AND status != 'running'").run(taskId);
    }
}

module.exports = {
    activeSubtaskProcesses,
    processQueue,
    executeSubtask,
    checkAndUpdateTaskStatus
};
