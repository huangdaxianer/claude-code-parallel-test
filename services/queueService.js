/**
 * 队列服务
 * 管理任务队列调度和子任务执行
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const db = require('../db');
const config = require('../config');

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

        // 获取待执行的子任务
        const pendingSubtasks = db.prepare(`
            SELECT mr.id, mr.task_id, mr.model_name, t.title
            FROM model_runs mr
            JOIN tasks t ON mr.task_id = t.task_id
            JOIN task_queue tq ON mr.task_id = tq.task_id
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
            db.prepare("UPDATE model_runs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(subtask.id);
            db.prepare("UPDATE task_queue SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE task_id = ?").run(subtask.task_id);
            console.log(`[Queue] Starting subtask: ${subtask.task_id}/${subtask.model_name}`);
            executeSubtask(subtask.task_id, subtask.model_name);
        }
    } catch (e) {
        console.error('[Queue] Error processing queue:', e);
    } finally {
        isProcessingQueue = false;
        setTimeout(processQueue, 500);
    }
}

// 执行单个模型子任务
function executeSubtask(taskId, modelName) {
    const subtaskKey = `${taskId}/${modelName}`;

    const child = spawn('bash', [config.SCRIPT_FILE, taskId, modelName], {
        env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
        detached: true
    });

    activeSubtaskProcesses[subtaskKey] = child;

    child.stdout.on('data', (data) => console.log(`[Subtask ${subtaskKey} STDOUT] ${data}`));
    child.stderr.on('data', (data) => console.error(`[Subtask ${subtaskKey} STDERR] ${data}`));

    child.on('error', (err) => {
        console.error(`[Subtask ${subtaskKey} ERROR] Failed to spawn process:`, err);
        db.prepare("UPDATE model_runs SET status = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_name = ?").run(taskId, modelName);
        delete activeSubtaskProcesses[subtaskKey];
        checkAndUpdateTaskStatus(taskId);
        setTimeout(processQueue, 100);
    });

    child.on('exit', (code, signal) => {
        console.log(`[Subtask ${subtaskKey} EXIT] Process exited with code ${code} and signal ${signal}`);
        delete activeSubtaskProcesses[subtaskKey];

        const currentStatus = db.prepare("SELECT status FROM model_runs WHERE task_id = ? AND model_name = ?").get(taskId, modelName);
        if (currentStatus && currentStatus.status === 'running') {
            const newStatus = (code === 0) ? 'completed' : 'stopped';
            db.prepare("UPDATE model_runs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND model_name = ?").run(newStatus, taskId, modelName);
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
