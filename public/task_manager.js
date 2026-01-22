// Task Manager JavaScript

let allTasks = [];
let filteredTasks = [];
let selectedTasks = new Set();
let refreshInterval = null;
let queueStatus = { maxParallelSubtasks: 5, runningSubtasks: 0, pendingSubtasks: 0 };

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    init();
});

function init() {
    // Load initial data
    fetchUsers();
    fetchQueueStatus();
    refreshTasks();

    // Setup auto-refresh (every 3 seconds)
    refreshInterval = setInterval(() => {
        refreshTasks();
        fetchQueueStatus();
    }, 3000);

    // Close modal on outside click
    document.getElementById('prompt-modal').addEventListener('click', (e) => {
        if (e.target.id === 'prompt-modal') {
            closePromptModal();
        }
    });

    // ESC to close modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closePromptModal();
        }
    });
}

// Fetch all users for filter dropdown
async function fetchUsers() {
    try {
        const res = await fetch('/api/admin/users');
        const users = await res.json();
        
        const select = document.getElementById('filter-user');
        users.forEach(user => {
            const option = document.createElement('option');
            option.value = user.id;
            option.textContent = user.username;
            select.appendChild(option);
        });
    } catch (e) {
        console.error('Failed to fetch users:', e);
    }
}

// Fetch queue status (running/pending subtasks and config)
async function fetchQueueStatus() {
    try {
        const res = await fetch('/api/admin/queue-status');
        queueStatus = await res.json();
        
        // Update the max parallel input
        const input = document.getElementById('max-parallel-input');
        if (input && document.activeElement !== input) {
            input.value = queueStatus.maxParallelSubtasks;
        }
    } catch (e) {
        console.error('Failed to fetch queue status:', e);
    }
}

// Update max parallel subtasks setting
async function updateMaxParallel() {
    const input = document.getElementById('max-parallel-input');
    const value = parseInt(input.value, 10);
    
    if (isNaN(value) || value < 1 || value > 50) {
        alert('并行数必须在 1-50 之间');
        return;
    }
    
    try {
        const res = await fetch('/api/admin/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ maxParallelSubtasks: value })
        });
        
        if (res.ok) {
            const config = await res.json();
            queueStatus.maxParallelSubtasks = config.maxParallelSubtasks;
            alert('设置已保存');
        } else {
            const error = await res.json();
            alert('保存失败: ' + (error.error || '未知错误'));
        }
    } catch (e) {
        alert('保存失败: ' + e.message);
    }
}

// Fetch all tasks
async function refreshTasks() {
    const spinner = document.getElementById('loading-spinner');
    spinner.style.display = 'inline-block';

    try {
        const res = await fetch('/api/admin/tasks');
        allTasks = await res.json();
        
        updateStats();
        applyFilters();
        updateLastRefresh();
    } catch (e) {
        console.error('Failed to fetch tasks:', e);
    } finally {
        spinner.style.display = 'none';
    }
}

// Update statistics - now shows subtask-level stats for running/pending
function updateStats() {
    const total = allTasks.length;
    const completed = allTasks.filter(t => t.queueStatus === 'completed').length;

    document.getElementById('stat-total').textContent = total;
    // Use subtask-level stats from queue status
    document.getElementById('stat-running').textContent = queueStatus.runningSubtasks || 0;
    document.getElementById('stat-pending').textContent = queueStatus.pendingSubtasks || 0;
    document.getElementById('stat-completed').textContent = completed;
}

// Update last refresh time
function updateLastRefresh() {
    const now = new Date();
    document.getElementById('last-refresh').textContent = `更新于 ${now.toLocaleTimeString()}`;
}

// Apply filters
function applyFilters() {
    const userFilter = document.getElementById('filter-user').value;
    const statusFilter = document.getElementById('filter-status').value;
    const searchFilter = document.getElementById('filter-search').value.toLowerCase().trim();

    filteredTasks = allTasks.filter(task => {
        // User filter
        if (userFilter && task.userId != userFilter) return false;

        // Status filter
        if (statusFilter && task.queueStatus !== statusFilter) return false;

        // Search filter
        if (searchFilter) {
            const matchTitle = task.title && task.title.toLowerCase().includes(searchFilter);
            const matchPrompt = task.prompt && task.prompt.toLowerCase().includes(searchFilter);
            const matchId = task.taskId.toLowerCase().includes(searchFilter);
            if (!matchTitle && !matchPrompt && !matchId) return false;
        }

        return true;
    });

    renderTasks();
}

// Render tasks table
function renderTasks() {
    const tbody = document.getElementById('tasks-tbody');

    if (filteredTasks.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" class="empty-state">
                    <p>没有找到任务</p>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = filteredTasks.map(task => {
        const isChecked = selectedTasks.has(task.taskId);
        const statusClass = `status-${task.queueStatus || 'unknown'}`;
        const statusText = getStatusText(task.queueStatus);
        const createdAt = formatDateTime(task.createdAt);
        
        // Model runs badges
        const modelBadges = (task.runs || []).map(run => {
            let badgeClass = '';
            if (run.status === 'running') badgeClass = 'running';
            else if (run.status === 'completed') badgeClass = 'completed';
            else if (run.status === 'stopped') badgeClass = 'stopped';
            return `<span class="model-badge ${badgeClass}">${run.modelName}</span>`;
        }).join('');

        // Action buttons based on status
        let actionButtons = '';
        if (task.queueStatus === 'running') {
            actionButtons = `
                <button class="action-btn action-btn-stop" onclick="stopTask('${task.taskId}')">中止</button>
            `;
        }
        actionButtons += `
            <button class="action-btn action-btn-view" onclick="viewTask('${task.taskId}')">查看</button>
            <button class="action-btn action-btn-delete" onclick="deleteTask('${task.taskId}')">删除</button>
        `;

        return `
            <tr>
                <td class="checkbox-cell">
                    <input type="checkbox" class="task-checkbox" 
                           data-task-id="${task.taskId}" 
                           ${isChecked ? 'checked' : ''} 
                           onchange="toggleTaskSelection('${task.taskId}')">
                </td>
                <td>
                    <div class="task-title" title="${escapeHtml(task.title || 'Untitled')}">${escapeHtml(task.title || 'Untitled')}</div>
                    <div class="task-id">${task.taskId}</div>
                </td>
                <td>
                    <span class="user-badge">${escapeHtml(task.username)}</span>
                </td>
                <td>
                    <span class="status-badge ${statusClass}">${statusText}</span>
                </td>
                <td>
                    <div class="model-runs">${modelBadges || '-'}</div>
                </td>
                <td>
                    <span class="timestamp">${createdAt}</span>
                </td>
                <td>
                    <div class="action-buttons">
                        ${actionButtons}
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    updateBatchActions();
}

// Status text mapping
function getStatusText(status) {
    const map = {
        'pending': '排队中',
        'running': '运行中',
        'completed': '已完成',
        'stopped': '已中止',
        'unknown': '未知'
    };
    return map[status] || status || '未知';
}

// Format datetime
function formatDateTime(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Truncate text
function truncate(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
}

// Escape HTML
function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Selection management
function toggleTaskSelection(taskId) {
    if (selectedTasks.has(taskId)) {
        selectedTasks.delete(taskId);
    } else {
        selectedTasks.add(taskId);
    }
    updateBatchActions();
}

function toggleSelectAll() {
    const selectAll = document.getElementById('select-all');
    if (selectAll.checked) {
        filteredTasks.forEach(task => selectedTasks.add(task.taskId));
    } else {
        selectedTasks.clear();
    }
    renderTasks();
}

function clearSelection() {
    selectedTasks.clear();
    document.getElementById('select-all').checked = false;
    renderTasks();
}

function updateBatchActions() {
    const batchActions = document.getElementById('batch-actions');
    const selectedCount = document.getElementById('selected-count');

    if (selectedTasks.size > 0) {
        batchActions.classList.add('show');
        selectedCount.textContent = `已选择 ${selectedTasks.size} 个任务`;
    } else {
        batchActions.classList.remove('show');
    }
}

// Task Actions
async function stopTask(taskId) {
    if (!confirm(`确定要中止任务 ${taskId} 吗？`)) return;

    try {
        const res = await fetch(`/api/tasks/${taskId}/stop`, { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            refreshTasks();
        } else {
            alert('中止失败: ' + (data.error || '未知错误'));
        }
    } catch (e) {
        alert('中止请求失败: ' + e.message);
    }
}

async function deleteTask(taskId) {
    if (!confirm(`确定要删除任务 ${taskId} 吗？此操作不可恢复！`)) return;

    try {
        const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
        const data = await res.json();

        if (data.success) {
            selectedTasks.delete(taskId);
            refreshTasks();
        } else {
            alert('删除失败: ' + (data.error || '未知错误'));
        }
    } catch (e) {
        alert('删除请求失败: ' + e.message);
    }
}

function viewTask(taskId) {
    window.open(`/task.html?id=${taskId}`, '_blank');
}

// Batch Actions
async function batchStop() {
    if (selectedTasks.size === 0) return;

    const runningTasks = filteredTasks
        .filter(t => selectedTasks.has(t.taskId) && t.queueStatus === 'running')
        .map(t => t.taskId);

    if (runningTasks.length === 0) {
        alert('所选任务中没有正在运行的任务');
        return;
    }

    if (!confirm(`确定要中止 ${runningTasks.length} 个运行中的任务吗？`)) return;

    for (const taskId of runningTasks) {
        try {
            await fetch(`/api/tasks/${taskId}/stop`, { method: 'POST' });
        } catch (e) {
            console.error(`Failed to stop task ${taskId}:`, e);
        }
    }

    clearSelection();
    refreshTasks();
}

async function batchDelete() {
    if (selectedTasks.size === 0) return;

    if (!confirm(`确定要删除 ${selectedTasks.size} 个任务吗？此操作不可恢复！`)) return;

    const taskIds = Array.from(selectedTasks);

    for (const taskId of taskIds) {
        try {
            await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
        } catch (e) {
            console.error(`Failed to delete task ${taskId}:`, e);
        }
    }

    clearSelection();
    refreshTasks();
}

// Prompt Modal
function showPrompt(taskId) {
    const task = allTasks.find(t => t.taskId === taskId);
    if (!task) return;

    document.getElementById('prompt-content').textContent = task.prompt || '(无 Prompt)';
    document.getElementById('prompt-modal').classList.add('show');
}

function closePromptModal() {
    document.getElementById('prompt-modal').classList.remove('show');
}
