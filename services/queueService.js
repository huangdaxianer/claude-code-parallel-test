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

        // 获取待执行的子任务（包含模型的自定义 API 配置）
        const pendingSubtasks = db.prepare(`
            SELECT mr.id, mr.task_id, mr.model_id, t.title,
                   mc.endpoint_name, mc.api_base_url, mc.api_key, mc.model_name
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
            // Pass model_id for folder naming and modelConfig for API request
            executeSubtask(subtask.task_id, subtask.model_id, {
                endpointName: subtask.endpoint_name,
                apiBaseUrl: subtask.api_base_url || null,
                apiKey: subtask.api_key || null,
                modelName: subtask.model_name || null
            });
        }
    } catch (e) {
        console.error('[Queue] Error processing queue:', e);
    } finally {
        isProcessingQueue = false;
        setTimeout(processQueue, 500);
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
        db.prepare("UPDATE model_runs SET status = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_id = ?").run(taskId, modelId);
        checkAndUpdateTaskStatus(taskId);
        setTimeout(processQueue, 100);
        return;
    }

    activeSubtaskProcesses[subtaskKey] = child;

    child.on('error', (err) => {
        console.error(`[Subtask ${subtaskKey} ERROR] Failed to spawn process:`, err);
        db.prepare("UPDATE model_runs SET status = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_id = ?").run(taskId, modelId);
        delete activeSubtaskProcesses[subtaskKey];
        checkAndUpdateTaskStatus(taskId);
        setTimeout(processQueue, 100);
    });

    child.on('exit', (code, signal) => {
        console.log(`[Subtask ${subtaskKey} EXIT] Process exited with code ${code} and signal ${signal}`);
        delete activeSubtaskProcesses[subtaskKey];

        const currentStatus = db.prepare("SELECT status FROM model_runs WHERE task_id = ? AND model_id = ?").get(taskId, modelId);
        if (currentStatus && currentStatus.status === 'running') {
            const newStatus = (code === 0) ? 'completed' : 'stopped';
            db.prepare("UPDATE model_runs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_id = ?").run(newStatus, taskId, modelId);

            // 如果子任务成功完成，立即生成预览文件夹（隔离环境）并在后台进行 Preparation
            if (newStatus === 'completed') {
                // Fire and forget - processing happens in background
                previewService.preparePreview(taskId, modelId).catch(err => {
                    console.error(`[Queue] Failed to trigger preview prep for ${taskId}/${modelId}:`, err);
                });
            }
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
