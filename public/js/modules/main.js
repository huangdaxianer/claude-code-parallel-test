/**
 * Main Entry Point for Task Manager
 */

import { AppState } from './state.js';
import { TaskAPI } from './api.js';
import { UI } from './ui.js';

// Constants
const REFRESH_INTERVAL = 3000;

document.addEventListener('DOMContentLoaded', () => {
    init();
});

function init() {
    // Initial Load
    fetchUsers();
    fetchQueueStatus();
    refreshTasks();
    fetchQuestions();

    // Auto Refresh
    setInterval(() => {
        refreshTasks();
        fetchQueueStatus();
    }, REFRESH_INTERVAL);

    // Event Listeners
    setupEventListeners();
    setupDragAndDrop();
}

function setupEventListeners() {
    // Global clicks (Delegation)
    document.body.addEventListener('click', handleGlobalClick);
    document.body.addEventListener('change', handleGlobalChange);

    // Filters
    document.getElementById('filter-user')?.addEventListener('change', applyFilters);
    document.getElementById('filter-status')?.addEventListener('change', applyFilters);
    document.getElementById('filter-search')?.addEventListener('input', applyFilters);

    // Modal Outside Clicks
    const modalIds = ['prompt-modal', 'config-modal', 'question-modal', 'model-modal'];
    modalIds.forEach(id => {
        document.getElementById(id)?.addEventListener('click', (e) => {
            if (e.target.id === id) UI.closeModal(id);
        });
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            modalIds.forEach(id => UI.closeModal(id));
        }
    });

    // Tab Switching
    document.querySelector('.tabs-nav')?.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-btn')) {
            const tabId = e.target.dataset.tab;
            if (tabId) switchTab(tabId);
        }
    });

    // Select All
    document.getElementById('select-all')?.addEventListener('change', (e) => {
        if (e.target.checked) {
            const allIds = AppState.filteredTasks.map(t => t.taskId);
            AppState.selectAll(allIds);
        } else {
            AppState.clearSelection();
        }
        UI.renderTasks();
    });

    // Forms
    document.getElementById('question-form')?.addEventListener('submit', handleQuestionSubmit);
    document.getElementById('model-form')?.addEventListener('submit', handleModelSubmit);

    // Specific change listeners
    document.getElementById('q-type')?.addEventListener('change', () => UI.toggleOptionsContainer());
}

async function handleGlobalClick(e) {
    const target = e.target;

    // Buttons with data-action
    const actionBtn = target.closest('[data-action]');
    if (actionBtn) {
        const action = actionBtn.dataset.action;
        const id = actionBtn.dataset.id; // Many uses require ID

        switch (action) {
            case 'stop': stopTask(id); break;
            case 'delete': deleteTask(id); break;
            case 'view': viewTask(id); break;

            case 'edit-question': {
                const q = AppState.allQuestions.find(i => String(i.id) === String(id));
                UI.openQuestionModal(q);
                break;
            }
            case 'open-create-question':
                UI.openQuestionModal(null);
                break;
            case 'save-question':
                handleQuestionSubmit(e);
                break;

            case 'edit-model': {
                const m = AppState.allModels.find(i => String(i.id) === String(id));
                UI.openModelModal(m);
                break;
            }
            case 'delete-model':
                deleteModel(id, actionBtn.dataset.name);
                break;
            case 'open-create-model':
                UI.openModelModal(null);
                break;
            case 'save-model':
                handleModelSubmit(e);
                break;

            case 'view-user-tasks':
                viewTask(null, actionBtn.dataset.username);
                break;

            case 'close-modal':
                UI.closeModal(actionBtn.dataset.modalId);
                break;

            case 'clear-selection':
                AppState.clearSelection();
                UI.renderTasks();
                break;

            case 'refresh-feedback-stats':
                fetchFeedbackStats();
                break;

            case 'refresh-users-management':
                fetchUserManagementUsers();
                break;
        }
    }

    // Checkbox for Task Selection
    if (target.matches('.task-checkbox')) {
        const id = target.dataset.taskId;
        if (id) {
            AppState.toggleTaskSelection(id);
            UI.updateBatchActions();
        }
    }

    // Batch Actions (IDs)
    if (target.id === 'batch-stop-btn') batchStop();
    if (target.id === 'batch-delete-btn') batchDelete();
    if (target.id === 'config-save-btn') updateMaxParallel();
    if (target.id === 'download-csv-btn') downloadFeedbackStatsCSV();
}

async function handleGlobalChange(e) {
    const target = e.target;

    if (target.dataset.action === 'toggle-question') {
        const id = target.dataset.id;
        const isActive = target.checked;
        try {
            await TaskAPI.updateQuestionStatus(id, isActive);
            // Update local state
            const q = AppState.allQuestions.find(i => String(i.id) === String(id));
            if (q) q.is_active = isActive;
        } catch (e) {
            UI.showToast('更新失败', 'error');
            target.checked = !isActive;
        }
    }

    if (target.dataset.action === 'update-model-status') {
        const id = target.dataset.id;
        const field = target.dataset.field;
        const val = target.checked;
        try {
            await TaskAPI.updateModel(id, { [field]: val });
            // Refresh models to be sure or update local
            await fetchModels();
        } catch (e) {
            UI.showToast('更新失败', 'error');
            target.checked = !val;
        }
    }

    if (target.dataset.action === 'update-user-role') {
        const id = target.dataset.id;
        const role = target.value;
        try {
            await TaskAPI.updateUserRole(id, role);
            UI.showToast('角色更新成功');
        } catch (e) {
            UI.showToast('更新失败: ' + e.message, 'error');
            fetchUserManagementUsers(); // revert
        }
    }
}

// --- Data Fetching ---

async function fetchUsers() {
    try {
        const users = await TaskAPI.fetchUsers();
        AppState.users = users; // This is for filter
        UI.renderUsers(users);
    } catch (e) {
        console.error(e);
    }
}

async function fetchQueueStatus() {
    try {
        const status = await TaskAPI.fetchQueueStatus();
        AppState.updateQueueStatus(status);
        UI.updateConfigInput(status.maxParallelSubtasks);
    } catch (e) {
        console.error(e);
    }
}

async function refreshTasks() {
    try {
        const tasks = await TaskAPI.fetchTasks();
        AppState.setTasks(tasks);
        UI.updateTableHeader();
        UI.updateStats();
        applyFilters();
        UI.updateLastRefresh();
    } catch (e) {
        console.error(e);
    }
}

async function fetchQuestions() {
    try {
        const questions = await TaskAPI.fetchQuestions();
        AppState.allQuestions = questions;
        UI.renderQuestions(questions);
    } catch (e) { console.error(e); }
}

async function fetchModels() {
    try {
        const models = await TaskAPI.fetchModels();
        AppState.allModels = models;
        UI.renderModels(models);
    } catch (e) { console.error(e); }
}

async function fetchUserManagementUsers() {
    try {
        const users = await TaskAPI.fetchUsers(); // API endpoint is same currently '/api/admin/users'
        AppState.managementUsers = users;
        UI.renderUserManagement(users);
    } catch (e) { console.error(e); }
}

async function fetchFeedbackStats() {
    try {
        const result = await TaskAPI.fetchFeedbackStats();
        if (result.success) {
            AppState.feedbackStatsData = result.data;
            // Also need active questions for header
            const questions = await TaskAPI.fetchQuestions();
            AppState.activeQuestions = questions.filter(q => q.is_active);

            UI.renderFeedbackStats(AppState.feedbackStatsData, AppState.activeQuestions);
        }
    } catch (e) { console.error(e); }
}

// --- Logic ---

function applyFilters() {
    const userFilter = document.getElementById('filter-user')?.value;
    const statusFilter = document.getElementById('filter-status')?.value;
    const searchFilter = document.getElementById('filter-search')?.value.toLowerCase().trim();

    AppState.filteredTasks = AppState.allTasks.filter(task => {
        if (userFilter && task.userId != userFilter) return false;
        if (statusFilter && task.queueStatus !== statusFilter) return false;
        if (searchFilter) {
            const matchTitle = task.title && task.title.toLowerCase().includes(searchFilter);
            const matchPrompt = task.prompt && task.prompt.toLowerCase().includes(searchFilter);
            const matchId = task.taskId.toLowerCase().includes(searchFilter);
            if (!matchTitle && !matchPrompt && !matchId) return false;
        }
        return true;
    });
    UI.renderTasks();
}

// --- Form Handling ---

async function handleQuestionSubmit(e) {
    if (e) e.preventDefault();

    // Gather data
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

    if (id) payload.id = id;

    try {
        const res = await TaskAPI.saveQuestion(payload);
        if (res.success) {
            UI.closeQuestionModal();
            fetchQuestions();
            UI.showToast('保存成功');
        } else {
            alert('保存失败: ' + res.error);
        }
    } catch (e) {
        alert('请求失败: ' + e.message);
    }
}

async function handleModelSubmit(e) {
    if (e) e.preventDefault();

    const id = document.getElementById('m-id').value;
    const payload = {
        name: document.getElementById('m-name').value,
        description: document.getElementById('m-desc').value,
        is_enabled_internal: document.getElementById('m-enabled-internal').checked,
        is_enabled_external: document.getElementById('m-enabled-external').checked,
        is_enabled_admin: document.getElementById('m-enabled-admin').checked,
        is_default_checked: document.getElementById('m-default-checked').checked
    };

    try {
        const res = await TaskAPI.updateModel(id, payload); // Handles both create and update logic internally in API wrapper if we want, or here
        // Wait, TaskAPI.updateModel logic I wrote accepts (id, data). If ID null, implies create? 
        // Let's check api.js... yes, it handles URL based on ID.

        // Actually api.js 'updateModel' name suggests update, but implementation handles create if id is null/empty?
        // Let's verify api.js content I wrote. 
        // "const url = id ? ... : ..." -> Yes.

        UI.closeModelModal();
        fetchModels();
        UI.showToast('保存成功');
    } catch (e) {
        alert('保存失败: ' + e.message);
    }
}

async function deleteModel(id, name) {
    if (!confirm(`确定要删除模型 "${name}" 吗？`)) return;
    try {
        await TaskAPI.deleteModel(id);
        fetchModels();
        UI.showToast('删除成功');
    } catch (e) {
        alert(e.message);
    }
}

// --- Drag & Drop ---
let dragSrcEl = null;

function setupDragAndDrop() {
    // We can't bind to elements that don't exist yet. Delegation for drag events is tricky.
    // However, the elements are created in renderQuestions with ondrag attributes?
    // Wait, I removed ondrag attributes in ui.js? 
    // Let's check ui.js renderQuestions...
    // I left them: ondragstart="handleDragStart(event)" etc.
    // So we MUST expose global functions.
}

window.handleDragStart = function (e) {
    dragSrcEl = e.currentTarget;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', e.currentTarget.innerHTML);
    e.currentTarget.style.opacity = '0.4';
    e.currentTarget.classList.add('dragging');
};

window.handleDragOver = function (e) {
    if (e.preventDefault) e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    return false;
};

window.handleDragEnter = function (e) {
    e.currentTarget.classList.add('over');
};

window.handleDragLeave = function (e) {
    e.currentTarget.classList.remove('over');
};

window.handleDrop = async function (e) {
    if (e.stopPropagation) e.stopPropagation();
    const dropTarget = e.currentTarget;

    if (dragSrcEl !== dropTarget) {
        const srcIndex = parseInt(dragSrcEl.dataset.index);
        const targetIndex = parseInt(dropTarget.dataset.index);

        // Reorder
        const questions = [...AppState.allQuestions];
        const [movedItem] = questions.splice(srcIndex, 1);
        questions.splice(targetIndex, 0, movedItem);

        AppState.allQuestions = questions;
        UI.renderQuestions(questions);

        try {
            const order = questions.map(q => q.id);
            const success = await TaskAPI.reorderQuestions(order);
            if (success) UI.showToast('顺序更新成功');
            else UI.showToast('顺序更新失败', 'error');
        } catch (e) {
            UI.showToast('请求失败', 'error');
        }
    }
    return false;
};

document.addEventListener('dragend', (e) => {
    document.querySelectorAll('.question-item').forEach(item => {
        item.classList.remove('over', 'dragging');
        item.style.opacity = '1';
    });
});


// --- Globals/Legacy Support ---
function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });

    document.querySelectorAll('.tab-pane').forEach(pane => {
        pane.classList.remove('active');
    });
    const pane = document.getElementById(`tab-${tabId}`);
    if (pane) pane.classList.add('active');

    if (tabId === 'feedback-stats') fetchFeedbackStats();
    if (tabId === 'users') fetchUserManagementUsers();
    if (tabId === 'models') fetchModels();
}

window.openConfigModal = function () {
    UI.openConfigModal(AppState.queueStatus.maxParallelSubtasks);
};

// Actions helpers (reused from before)
async function stopTask(taskId) {
    if (!confirm(`确定要中止任务 ${taskId} 吗？`)) return;
    try {
        await TaskAPI.stopTask(taskId);
        refreshTasks();
    } catch (e) { alert(e.message); }
}

async function deleteTask(taskId) {
    if (!confirm(`确定要删除任务 ${taskId} 吗？`)) return;
    try {
        await TaskAPI.deleteTask(taskId);
        AppState.selectedTasks.delete(taskId);
        refreshTasks();
    } catch (e) { alert(e.message); }
}

function viewTask(taskId, username) {
    if (username) {
        window.open(`/task.html?user=${encodeURIComponent(username)}`, '_blank');
    } else {
        window.open(`/task.html?id=${taskId}`, '_blank');
    }
}

async function updateMaxParallel() {
    // ... implemented in previous step, kept same logic
    const input = document.getElementById('max-parallel-input');
    const value = parseInt(input.value, 10);
    if (isNaN(value) || value < 1 || value > 50) {
        alert('并行数必须在 1-50 之间');
        return;
    }
    try {
        const config = await TaskAPI.updateConfig({ maxParallelSubtasks: value });
        AppState.updateQueueStatus(config);
        UI.closeConfigModal();
    } catch (e) { alert(e.message); }
}

async function batchStop() {
    if (AppState.selectedTasks.size === 0) return;
    // ... same logic
    const runningTasks = AppState.filteredTasks
        .filter(t => AppState.selectedTasks.has(t.taskId) && t.queueStatus === 'running')
        .map(t => t.taskId);

    if (runningTasks.length === 0) { alert('所选任务中没有正在运行的任务'); return; }
    if (!confirm(`确定要中止 ${runningTasks.length} 个运行中的任务吗？`)) return;

    for (const taskId of runningTasks) await TaskAPI.stopTask(taskId).catch(console.error);
    AppState.clearSelection();
    refreshTasks();
}

async function batchDelete() {
    if (AppState.selectedTasks.size === 0) return;
    if (!confirm(`确定要删除 ${AppState.selectedTasks.size} 个任务吗？`)) return;

    for (const taskId of AppState.selectedTasks) await TaskAPI.deleteTask(taskId).catch(console.error);
    AppState.clearSelection();
    refreshTasks();
}

function downloadFeedbackStatsCSV() {
    // CSV logic
    const data = AppState.feedbackStatsData;
    const questions = AppState.activeQuestions;

    if (data.length === 0) { alert('暂无数据'); return; }

    const headers = ['任务ID', '任务标题', '用户', '模型'];
    questions.forEach(q => {
        const name = q.short_name || q.stem;
        headers.push(name);
        if (q.has_comment) headers.push(`${name} - 评论`);
    });
    headers.push('提交时间');

    const rows = data.map(row => {
        const map = {};
        row.responses.forEach(r => map[r.questionId] = r);

        const csvRow = [row.taskId, row.title || 'Untitled', row.username, row.modelName];
        questions.forEach(q => {
            const r = map[q.id];
            csvRow.push(r?.score ?? '');
            if (q.has_comment) csvRow.push(r?.comment ?? '');
        });
        csvRow.push(formatDateTime(row.submittedAt));
        return csvRow;
    });

    const escapeCSV = (v) => {
        if (v == null) return '';
        const s = String(v);
        if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
        return s;
    };

    const content = [
        headers.map(escapeCSV).join(','),
        ...rows.map(r => r.map(escapeCSV).join(','))
    ].join('\n');

    const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `feedback_stats_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
}
