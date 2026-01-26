// Task Manager JavaScript

let allTasks = [];
let filteredTasks = [];
let selectedTasks = new Set();
let refreshInterval = null;
let queueStatus = { maxParallelSubtasks: 5, runningSubtasks: 0, pendingSubtasks: 0 };
let allModelNames = []; // Store all unique model names across all tasks
let prevModelNamesKey = ''; // Track previous model names to avoid unnecessary header rebuilds

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    init();
});

let allQuestions = []; // Store questions

function init() {
    // Load initial data
    fetchUsers();
    fetchQueueStatus();
    refreshTasks();
    fetchQuestions(); // Load questions

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
    // Note: Removed spinner show/hide to prevent layout shifts that cause page "jumping"
    try {
        const res = await fetch('/api/admin/tasks');
        allTasks = await res.json();

        // Extract all unique model names from all tasks
        extractAllModelNames();
        updateTableHeader();
        updateStats();
        applyFilters();
        updateLastRefresh();
    } catch (e) {
        console.error('Failed to fetch tasks:', e);
    }
}

// Extract all unique model names from tasks
function extractAllModelNames() {
    const modelSet = new Set();
    allTasks.forEach(task => {
        (task.runs || []).forEach(run => {
            if (run.modelName) {
                modelSet.add(run.modelName);
            }
        });
    });
    // Sort model names for consistent column order
    allModelNames = Array.from(modelSet).sort();
}

// Update table header with model columns
function updateTableHeader() {
    const thead = document.getElementById('tasks-thead');
    if (!thead) return;

    // Check if model columns have changed
    const newModelNamesKey = allModelNames.join('|');
    if (newModelNamesKey === prevModelNamesKey) {
        return; // No change, skip update
    }
    prevModelNamesKey = newModelNamesKey;

    // Build header row
    let headerHTML = `
        <tr>
            <th class="checkbox-cell">
                <input type="checkbox" class="task-checkbox" id="select-all" onchange="toggleSelectAll()">
            </th>
            <th class="task-cell">任务</th>
            <th>用户</th>
    `;

    // Add model columns
    allModelNames.forEach(modelName => {
        headerHTML += `<th class="model-col-header">${escapeHtml(modelName)}</th>`;
    });

    headerHTML += `
            <th>创建时间</th>
            <th>操作</th>
        </tr>
    `;

    thead.innerHTML = headerHTML;
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

// Render tasks table with smart DOM updates to avoid flicker
function renderTasks() {
    const tbody = document.getElementById('tasks-tbody');
    const totalCols = 5 + allModelNames.length; // checkbox + task + user + models + time + actions

    if (filteredTasks.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="${totalCols}" class="empty-state">
                    <p>没有找到任务</p>
                </td>
            </tr>
        `;
        return;
    }

    // Build a map of existing rows by taskId
    const existingRows = {};
    tbody.querySelectorAll('tr[data-task-id]').forEach(row => {
        existingRows[row.dataset.taskId] = row;
    });

    // Track which task IDs should exist
    const currentTaskIds = new Set(filteredTasks.map(t => t.taskId));

    // Remove rows that no longer exist
    Object.keys(existingRows).forEach(taskId => {
        if (!currentTaskIds.has(taskId)) {
            existingRows[taskId].remove();
            delete existingRows[taskId];
        }
    });

    // Clear any placeholder rows (like loading or empty state)
    tbody.querySelectorAll('tr:not([data-task-id])').forEach(row => row.remove());

    // Process each task
    filteredTasks.forEach((task, index) => {
        const isChecked = selectedTasks.has(task.taskId);
        const createdAt = formatDateTime(task.createdAt);

        // Create a map of modelName -> status for quick lookup
        const modelStatusMap = {};
        (task.runs || []).forEach(run => {
            modelStatusMap[run.modelName] = run.status;
        });

        // Check if row exists
        let row = existingRows[task.taskId];
        if (!row) {
            // Create new row
            row = document.createElement('tr');
            row.dataset.taskId = task.taskId;
            row.innerHTML = buildRowContent(task, isChecked, createdAt, modelStatusMap);

            // Insert at correct position
            const nextSibling = tbody.children[index];
            if (nextSibling) {
                tbody.insertBefore(row, nextSibling);
            } else {
                tbody.appendChild(row);
            }
            existingRows[task.taskId] = row;
        } else {
            // Update existing row - only update changed parts
            updateRowContent(row, task, isChecked, createdAt, modelStatusMap);

            // Ensure correct position
            const currentIndex = Array.from(tbody.children).indexOf(row);
            if (currentIndex !== index) {
                const nextSibling = tbody.children[index];
                if (nextSibling && nextSibling !== row) {
                    tbody.insertBefore(row, nextSibling);
                } else if (!nextSibling) {
                    tbody.appendChild(row);
                }
            }
        }
    });

    updateBatchActions();
}

// Build the full HTML content for a row
function buildRowContent(task, isChecked, createdAt, modelStatusMap) {
    // Generate model status cells (dot only, no text)
    const modelCells = allModelNames.map(modelName => {
        const status = modelStatusMap[modelName];
        const statusClass = getModelStatusClass(status);
        return `<td class="model-col-cell" data-model="${escapeHtml(modelName)}"><span class="model-status ${statusClass}"></span></td>`;
    }).join('');

    // Action buttons based on status (check if any model is running or pending)
    const hasRunningOrPending = (task.runs || []).some(r => r.status === 'running' || r.status === 'pending');
    const actionButtons = buildActionButtons(task.taskId, hasRunningOrPending);

    return `
        <td class="checkbox-cell">
            <input type="checkbox" class="task-checkbox" 
                   data-task-id="${task.taskId}" 
                   ${isChecked ? 'checked' : ''} 
                   onchange="toggleTaskSelection('${task.taskId}')">
        </td>
        <td class="task-cell">
            <div class="task-title" title="${escapeHtml(task.title || 'Untitled')}">${escapeHtml(task.title || 'Untitled')}</div>
            <div class="task-id">${task.taskId}</div>
        </td>
        <td>
            <span class="user-badge">${escapeHtml(task.username)}</span>
        </td>
        ${modelCells}
        <td>
            <span class="timestamp">${createdAt}</span>
        </td>
        <td class="actions-cell">
            <div class="action-buttons">
                ${actionButtons}
            </div>
        </td>
    `;
}

// Update only the changed parts of an existing row
function updateRowContent(row, task, isChecked, createdAt, modelStatusMap) {
    // Update checkbox state without replacing it
    const checkbox = row.querySelector('input.task-checkbox');
    if (checkbox && checkbox.checked !== isChecked) {
        checkbox.checked = isChecked;
    }

    // Update model status dots
    allModelNames.forEach(modelName => {
        const status = modelStatusMap[modelName];
        const newStatusClass = getModelStatusClass(status);
        // Find cell by iterating through model cells
        const cells = row.querySelectorAll('td.model-col-cell');
        for (const cell of cells) {
            if (cell.dataset.model === modelName) {
                const dot = cell.querySelector('.model-status');
                if (dot) {
                    // Only update if class changed
                    const currentClasses = dot.className;
                    const expectedClasses = `model-status ${newStatusClass}`;
                    if (currentClasses !== expectedClasses) {
                        dot.className = expectedClasses;
                    }
                }
                break;
            }
        }
    });

    // Update action buttons if needed
    const hasRunningOrPending = (task.runs || []).some(r => r.status === 'running' || r.status === 'pending');
    const actionsCell = row.querySelector('.actions-cell');
    if (actionsCell) {
        const hasStopButton = actionsCell.querySelector('.action-btn-stop') !== null;
        if (hasRunningOrPending !== hasStopButton) {
            // Need to update action buttons
            const actionButtons = buildActionButtons(task.taskId, hasRunningOrPending);
            actionsCell.innerHTML = `<div class="action-buttons">${actionButtons}</div>`;
        }
    }
}

// Build action buttons HTML
function buildActionButtons(taskId, hasRunningOrPending) {
    let actionButtons = '';
    if (hasRunningOrPending) {
        actionButtons = `<button class="action-btn action-btn-stop" onclick="stopTask('${taskId}')">中止</button>`;
    }
    actionButtons += `
        <button class="action-btn action-btn-view" onclick="viewTask('${taskId}')">查看</button>
        <button class="action-btn action-btn-delete" onclick="deleteTask('${taskId}')">删除</button>
    `;
    return actionButtons;
}

// Get model status CSS class
function getModelStatusClass(status) {
    switch (status) {
        case 'running':
            return 'running';
        case 'pending':
            return 'pending';
        case 'completed':
            return 'completed';
        case 'stopped':
            return 'stopped';
        default:
            return 'not-started';
    }
}

// Status text mapping
function getStatusText(status) {
    const map = {
        'pending': '排队中',
        'running': '运行中',
        'completed': '已完成',
        'evaluated': '已反馈',
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

// ========== Evaluation Config Logic ==========

function switchTab(tabId) {
    // Update nav
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelector(`.tab-btn[onclick="switchTab('${tabId}')"]`).classList.add('active');

    // Update panes
    document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');

    // Load data for feedback stats tab when activated
    if (tabId === 'feedback-stats') {
        fetchFeedbackStats();
    }
}

async function fetchQuestions() {
    try {
        const res = await fetch('/api/admin/questions');
        allQuestions = await res.json();
        renderQuestions();
    } catch (e) {
        console.error('Failed to fetch questions:', e);
    }
}

function renderQuestions() {
    const list = document.getElementById('question-list');
    if (allQuestions.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>暂无题目，请点击右上角新建</p></div>';
        return;
    }

    list.innerHTML = allQuestions.map(q => `
        <div class="question-item" onclick='openQuestionModal(${JSON.stringify(q)})'>
            <div class="q-content">
                ${q.short_name ? `
                    <div style="font-size:1.1rem; font-weight:700; color:#1e293b; margin-bottom:0.25rem;">${escapeHtml(q.short_name)}</div>
                    <div style="font-size:0.9rem; color:#64748b; margin-bottom:0.5rem; line-height:1.5;">${escapeHtml(q.stem)}</div>
                ` : `
                    <div style="font-size:1.1rem; font-weight:700; color:#1e293b; margin-bottom:0.5rem;">${escapeHtml(q.stem)}</div>
                `}
                
                <div class="q-meta">
                    <span class="q-tag">${q.scoring_type === 'stars_5' ? '五星评分' : '三星评分'}</span>
                    ${q.is_required ? '<span class="q-tag" style="background:#fef3c7; color:#d97706">必填</span>' : '<span class="q-tag">选填</span>'}
                    ${q.has_comment ? '<span class="q-tag">允许评论</span>' : ''}
                </div>
                ${q.description ? `<div style="margin-top:0.5rem; color:#94a3b8; font-size:0.85rem;">${escapeHtml(q.description)}</div>` : ''}
            </div>
            <div style="display:flex; gap:0.5rem; flex-direction:column; align-items: flex-end;">
                <label class="toggle-switch" title="${q.is_active ? '点击停用' : '点击启用'}" onclick="event.stopPropagation()">
                    <input type="checkbox" ${q.is_active ? 'checked' : ''} onchange="toggleQuestionActive(${q.id}, this.checked, this)">
                    <span class="slider"></span>
                </label>
            </div>
        </div>
    `).join('');
}

function openQuestionModal(question = null) {
    const modal = document.getElementById('question-modal');
    const title = document.getElementById('question-modal-title');

    // Reset form
    document.getElementById('question-form').reset();
    document.getElementById('q-id').value = '';

    if (question) {
        title.textContent = '编辑题目';
        document.getElementById('q-id').value = question.id;
        document.getElementById('q-stem').value = question.stem;
        document.getElementById('q-short-name').value = question.short_name || '';
        document.getElementById('q-type').value = question.scoring_type;
        document.getElementById('q-desc').value = question.description || '';
        document.getElementById('q-comment').checked = !!question.has_comment;
        document.getElementById('q-required').checked = !!question.is_required;

        // Cannot change type of existing question to prevent data inconsistency? 
        // For simplicity, we allow it, but in production might want to disable.
    } else {
        title.textContent = '新建题目';
    }

    toggleOptionsContainer(question ? JSON.parse(question.options_json || '[]') : []);
    modal.classList.add('show');
}

function toggleOptionsContainer(existingOptions = []) {
    const type = document.getElementById('q-type').value;
    const container = document.getElementById('q-options-container');
    const inputsDiv = document.getElementById('q-options-inputs');

    inputsDiv.innerHTML = '';
    const count = type === 'stars_5' ? 5 : 3;
    container.style.display = 'block';

    for (let i = 1; i <= count; i++) {
        const div = document.createElement('div');
        div.style.display = 'flex';
        div.style.gap = '0.5rem';
        div.style.alignItems = 'center';

        const label = document.createElement('span');
        label.textContent = `${i}分:`;
        label.style.width = '40px';
        label.style.fontSize = '0.9rem';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'filter-input';
        input.style.flex = '1';
        input.placeholder = `选项 ${i} 的说明...`;
        input.value = existingOptions[i - 1] || '';
        input.dataset.index = i - 1;

        div.appendChild(label);
        div.appendChild(input);
        inputsDiv.appendChild(div);
    }
}

function closeQuestionModal() {
    document.getElementById('question-modal').classList.remove('show');
}

async function handleQuestionSubmit(e) {
    e.preventDefault();

    const id = document.getElementById('q-id').value;
    const optionInputs = document.querySelectorAll('#q-options-inputs input');
    const options = Array.from(optionInputs).map(input => input.value.trim());

    const payload = {
        stem: document.getElementById('q-stem').value,
        short_name: document.getElementById('q-short-name').value,
        scoring_type: document.getElementById('q-type').value,
        description: document.getElementById('q-desc').value,
        has_comment: document.getElementById('q-comment').checked,
        is_required: document.getElementById('q-required').checked,
        options_json: JSON.stringify(options)
    };

    try {
        let res;
        if (id) {
            // Update
            res = await fetch(`/api/admin/questions/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } else {
            // Create
            res = await fetch('/api/admin/questions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }

        const data = await res.json();
        if (data.success) {
            closeQuestionModal();
            fetchQuestions();
        } else {
            alert('保存失败: ' + (data.error || '未知错误'));
        }
    } catch (err) {
        alert('请求失败');
        console.error(err);
    }
}

async function toggleQuestionActive(id, isActive, checkbox) {
    try {
        const res = await fetch(`/api/admin/questions/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: isActive })
        });

        if (res.ok) {
            // Update local state without full refresh if possible, or just refresh
            // fetchQuestions(); // Refreshing ensures consistency but might be overkill

            // Update the local data array to reflect the change so subsequent renders are correct
            const q = allQuestions.find(i => i.id === id);
            if (q) q.is_active = isActive;

        } else {
            alert('操作失败');
            if (checkbox) checkbox.checked = !isActive; // Revert
        }
    } catch (e) {
        console.error(e);
        alert('请求失败');
        if (checkbox) checkbox.checked = !isActive; // Revert
    }
}

// ========== Feedback Statistics Logic ==========

let feedbackStatsData = [];
let allActiveQuestions = [];

async function fetchFeedbackStats() {
    try {
        // Fetch stats data
        const statsRes = await fetch('/api/admin/feedback-stats');
        const statsResult = await statsRes.json();

        if (!statsResult.success) {
            throw new Error(statsResult.error || 'Failed to fetch stats');
        }

        feedbackStatsData = statsResult.data;

        // Fetch active questions to build column headers
        const questionsRes = await fetch('/api/admin/questions');
        allActiveQuestions = (await questionsRes.json()).filter(q => q.is_active);

        renderFeedbackStats();
    } catch (e) {
        console.error('Error fetching feedback stats:', e);
        const tbody = document.getElementById('feedback-stats-tbody');
        tbody.innerHTML = `
            <tr>
                <td colspan="5" class="empty-state">
                    <p>加载失败: ${e.message}</p>
                </td>
            </tr>
        `;
    }
}

function refreshFeedbackStats() {
    fetchFeedbackStats();
}

function renderFeedbackStats() {
    const thead = document.getElementById('feedback-stats-thead');
    const tbody = document.getElementById('feedback-stats-tbody');

    if (feedbackStatsData.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="${5 + allActiveQuestions.length}" class="empty-state">
                    <p>暂无反馈数据</p>
                </td>
            </tr>
        `;
        return;
    }

    // Build table header with dynamic question columns
    let headerHTML = `
        <tr>
            <th>任务ID</th>
            <th>任务标题</th>
            <th>用户</th>
            <th>模型</th>
    `;

    allActiveQuestions.forEach(q => {
        const displayName = q.short_name || q.stem;
        headerHTML += `<th style="text-align: center;">${escapeHtml(displayName)}</th>`;
    });

    headerHTML += `
            <th>提交时间</th>
        </tr>
    `;
    thead.innerHTML = headerHTML;

    // Build table body
    tbody.innerHTML = feedbackStatsData.map(row => {
        // Create a map of questionId -> response for quick lookup
        const responseMap = {};
        row.responses.forEach(r => {
            responseMap[r.questionId] = r;
        });

        // Generate question score cells
        const questionCells = allActiveQuestions.map(q => {
            const response = responseMap[q.id];
            if (!response || response.score === null || response.score === undefined) {
                return `<td style="text-align: center; color: #94a3b8;">-</td>`;
            }

            // Color code based on score (assuming 1-5 scale, adjust if needed)
            const maxScore = q.scoring_type === 'stars_5' ? 5 : 3;
            const scorePercent = response.score / maxScore;
            let color = '#94a3b8'; // gray for neutral
            if (scorePercent >= 0.8) color = '#22c55e'; // green for high
            else if (scorePercent >= 0.6) color = '#3b82f6'; // blue for medium-high
            else if (scorePercent >= 0.4) color = '#f59e0b'; // orange for medium
            else color = '#ef4444'; // red for low

            const title = response.comment ? `评论: ${response.comment}` : '';
            return `<td style="text-align: center; color: ${color}; font-weight: 600;" title="${escapeHtml(title)}">${response.score}</td>`;
        }).join('');

        const submittedAt = formatDateTime(row.submittedAt);

        return `
            <tr>
                <td>
                    <div class="task-id">${escapeHtml(row.taskId)}</div>
                </td>
                <td>
                    <div class="task-title" title="${escapeHtml(row.title || 'Untitled')}">${escapeHtml(row.title || 'Untitled')}</div>
                </td>
                <td>
                    <span class="user-badge">${escapeHtml(row.username)}</span>
                </td>
                <td>
                    <span style="font-size: 0.85rem; color: #475569;">${escapeHtml(row.modelName)}</span>
                </td>
                ${questionCells}
                <td>
                    <span class="timestamp">${submittedAt}</span>
                </td>
            </tr>
        `;
    }).join('');
}

function downloadFeedbackStatsCSV() {
    if (feedbackStatsData.length === 0) {
        alert('暂无数据可下载');
        return;
    }

    // Build CSV header
    const headers = ['任务ID', '任务标题', '用户', '模型'];
    allActiveQuestions.forEach(q => {
        const displayName = q.short_name || q.stem;
        headers.push(displayName);
        if (q.has_comment) {
            headers.push(`${displayName} - 评论`);
        }
    });
    headers.push('提交时间');

    // Build CSV rows
    const rows = feedbackStatsData.map(row => {
        const responseMap = {};
        row.responses.forEach(r => {
            responseMap[r.questionId] = r;
        });

        const csvRow = [
            row.taskId,
            row.title || 'Untitled',
            row.username,
            row.modelName
        ];

        allActiveQuestions.forEach(q => {
            const response = responseMap[q.id];
            csvRow.push(response?.score ?? '');
            if (q.has_comment) {
                csvRow.push(response?.comment ?? '');
            }
        });

        csvRow.push(formatDateTime(row.submittedAt));

        return csvRow;
    });

    // Escape CSV values
    const escapeCSV = (value) => {
        if (value === null || value === undefined) return '';
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };

    // Generate CSV content
    const csvContent = [
        headers.map(escapeCSV).join(','),
        ...rows.map(row => row.map(escapeCSV).join(','))
    ].join('\n');

    // Add BOM for Excel UTF-8 support
    const BOM = '\uFEFF';
    const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });

    // Create download link
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    link.setAttribute('download', `feedback_stats_${timestamp}.csv`);

    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}
