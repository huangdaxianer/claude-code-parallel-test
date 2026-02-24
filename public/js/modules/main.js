/**
 * Main Entry Point for Task Manager
 */

import { AppState } from './state.js';
import { TaskAPI, getAuthHeaders } from './api.js';
import { UI } from './ui.js';

// Constants
const REFRESH_INTERVAL = 3000;

document.addEventListener('DOMContentLoaded', () => {
    init();
});

function init() {
    // Auth Check
    const savedUserStr = localStorage.getItem('claude_user');
    const loginRedirect = '/login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
    if (!savedUserStr) {
        window.location.href = loginRedirect;
        return;
    }

    try {
        const user = JSON.parse(savedUserStr);
        // Enforce Admin Role
        if (user.role !== 'admin') {
            alert('您没有权限访问管理后台');
            window.location.href = '/task.html';
            return;
        }

        // Expose to AppState for filters etc if needed, though main.js uses AppState from state.js
        // Ideally we should set AppState.currentUser = user; here if state.js doesn't auto-init
        // But state.js is imported. Let's assume we need to set it simply.
        if (AppState) AppState.currentUser = user;

    } catch (e) {
        console.error('Auth error:', e);
        window.location.href = loginRedirect;
        return;
    }

    // Handle initial tab from URL
    initTabFromURL();

    // Initial Load
    fetchUsers();
    fetchQueueStatus();
    fetchModels();
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

    // Handle browser back/forward navigation
    window.addEventListener('popstate', handlePopState);
}

/**
 * Initialize tab state from URL parameter
 */
function initTabFromURL() {
    const urlParams = new URLSearchParams(window.location.search);
    const tabParam = urlParams.get('tab');

    // Valid tab names
    const validTabs = ['tasks', 'models', 'eval', 'feedback-stats', 'users'];

    // Default to 'tasks' if no valid tab parameter
    const tabId = validTabs.includes(tabParam) ? tabParam : 'tasks';

    // Activate the tab without updating URL (since we're reading from it)
    activateTab(tabId, false);
}

/**
 * Handle browser back/forward button
 */
function handlePopState(e) {
    const urlParams = new URLSearchParams(window.location.search);
    const tabParam = urlParams.get('tab');
    const validTabs = ['tasks', 'models', 'eval', 'feedback-stats', 'users'];
    const tabId = validTabs.includes(tabParam) ? tabParam : 'tasks';

    activateTab(tabId, false);
}

function setupEventListeners() {
    // Global clicks (Delegation)
    document.body.addEventListener('click', handleGlobalClick);
    document.body.addEventListener('change', handleGlobalChange);

    // Debounce search input to avoid excessive API calls
    let searchTimer = null;
    document.getElementById('filter-search')?.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(applyFilters, 300);
    });

    // Modal Outside Clicks
    const modalIds = ['prompt-modal', 'config-modal', 'question-modal', 'model-modal', 'group-modal', 'create-user-modal'];
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

    // Select All — handled via event delegation in handleGlobalChange
    // (the #select-all checkbox is inside dynamically re-rendered thead)

    // Forms
    document.getElementById('question-form')?.addEventListener('submit', handleQuestionSubmit);
    document.getElementById('model-form')?.addEventListener('submit', handleModelSubmit);
    document.getElementById('group-form')?.addEventListener('submit', handleGroupSubmit);
    document.getElementById('create-user-form')?.addEventListener('submit', handleCreateUserSubmit);

    // Specific change listeners
    document.getElementById('q-type')?.addEventListener('change', () => UI.toggleOptionsContainer());
}

async function handleGlobalClick(e) {
    const target = e.target;

    // Close all filter popups when clicking outside
    const filterBtn = target.closest('.col-filter-btn');
    const filterPopup = target.closest('.col-filter-popup');
    if (!filterBtn && !filterPopup) {
        document.querySelectorAll('.col-filter-popup.show').forEach(p => p.classList.remove('show'));
    }

    // Buttons with data-action
    const actionBtn = target.closest('[data-action]');
    if (actionBtn) {
        const action = actionBtn.dataset.action;
        const id = actionBtn.dataset.id; // Many uses require ID

        switch (action) {
            // Filter icon toggle
            case 'toggle-filter-popup': {
                e.stopPropagation();
                const popupId = actionBtn.dataset.target;
                const popup = document.getElementById(popupId);
                // Close all other popups first
                document.querySelectorAll('.col-filter-popup.show').forEach(p => {
                    if (p.id !== popupId) p.classList.remove('show');
                });
                if (popup) popup.classList.toggle('show');
                break;
            }

            // User filter option clicked
            case 'user-filter': {
                const value = actionBtn.dataset.value;
                AppState.userFilter = value || '';
                AppState.pagination.page = 1;
                // Close popup and refresh
                document.querySelectorAll('.col-filter-popup.show').forEach(p => p.classList.remove('show'));
                AppState.prevModelNamesKey = '';
                UI.updateTableHeader(true);
                refreshTasks();
                break;
            }

            // Model filter option clicked
            case 'model-filter': {
                const modelId = actionBtn.dataset.modelId;
                const value = actionBtn.dataset.value;
                if (value) {
                    AppState.modelFilters[modelId] = value;
                } else {
                    delete AppState.modelFilters[modelId];
                }
                AppState.pagination.page = 1;
                // Close popup and refresh
                document.querySelectorAll('.col-filter-popup.show').forEach(p => p.classList.remove('show'));
                AppState.prevModelNamesKey = '';
                UI.updateTableHeader(true);
                refreshTasks();
                break;
            }

            case 'stop': stopTask(id); break;
            case 'delete': deleteTask(id); break;
            case 'view': viewTask(id, actionBtn.dataset.username); break;

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
                fetchUserManagementData();
                break;

            case 'open-create-user':
                document.getElementById('create-user-modal')?.classList.add('show');
                document.getElementById('cu-usernames').value = '';
                break;

            case 'open-create-group':
                UI.openGroupModal(null);
                break;

            case 'edit-group': {
                const g = AppState.userGroups.find(i => String(i.id) === String(id));
                UI.openGroupModal(g);
                break;
            }

            case 'delete-group':
                deleteUserGroup(id, actionBtn.dataset.name);
                break;

            case 'delete-user':
                deleteUser(id, actionBtn.dataset.name);
                break;

            case 'reset-password':
                resetUserPassword(id, actionBtn.dataset.name);
                break;

            case 'toggle-model-expand':
                UI.toggleModelExpand(actionBtn.dataset.modelId);
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
    if (target.id === 'batch-restart-btn') batchRestart();
    if (target.id === 'batch-delete-btn') batchDelete();
    if (target.id === 'config-save-btn') updateMaxParallel();
    if (target.id === 'download-csv-btn') downloadFeedbackStatsCSV();
}

async function handleGlobalChange(e) {
    const target = e.target;

    // Select All checkbox (inside dynamically rendered thead)
    if (target.id === 'select-all') {
        if (target.checked) {
            const allIds = AppState.filteredTasks.map(t => t.taskId);
            AppState.selectAll(allIds);
        } else {
            AppState.clearSelection();
        }
        UI.renderTasks();
        return;
    }

    // Per-model & user filters are now handled via handleGlobalClick (icon popups)

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
            fetchUserManagementData(); // revert
        }
    }

    if (target.dataset.action === 'update-user-group') {
        const id = target.dataset.id;
        const groupId = target.value;
        try {
            await TaskAPI.updateUserGroupAssignment(id, groupId);
            UI.showToast('分组更新成功');
            fetchUserManagementData(); // refresh list after successful group change
        } catch (e) {
            UI.showToast('更新失败: ' + e.message, 'error');
            fetchUserManagementData(); // revert
        }
    }

    // Handle registration toggle
    if (target.dataset.action === 'toggle-allow-registration') {
        const isAllowed = target.checked;
        try {
            await TaskAPI.updateConfig({ allowNewRegistration: isAllowed });
            UI.showToast(isAllowed ? '已开启新用户注册' : '已关闭新用户注册');
        } catch (e) {
            UI.showToast('更新失败: ' + e.message, 'error');
            target.checked = !isAllowed; // revert
        }
    }

    // Handle model group setting toggle (is_enabled or is_default_checked)
    if (target.dataset.action === 'update-model-group-setting') {
        const modelId = target.dataset.modelId;
        const groupId = target.dataset.groupId;
        const field = target.dataset.field;
        const val = target.checked;
        try {
            await TaskAPI.updateModelGroupSetting(modelId, groupId, { [field]: val });
            UI.showToast('设置更新成功');
        } catch (e) {
            UI.showToast('更新失败: ' + e.message, 'error');
            target.checked = !val;
        }
    }
}

// Handle display name input blur
document.body.addEventListener('blur', async (e) => {
    const target = e.target;
    if (target.dataset.action === 'update-model-group-display-name') {
        const modelId = target.dataset.modelId;
        const groupId = target.dataset.groupId;
        const displayName = target.value.trim();
        try {
            await TaskAPI.updateModelGroupSetting(modelId, groupId, { display_name: displayName });
            UI.showToast('备注名称更新成功');
        } catch (e) {
            UI.showToast('更新失败: ' + e.message, 'error');
        }
    }
}, true);

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
        const searchFilter = document.getElementById('filter-search')?.value.trim() || '';

        const result = await TaskAPI.fetchTasks({
            page: AppState.pagination.page,
            pageSize: AppState.pagination.pageSize,
            userId: AppState.userFilter,
            search: searchFilter,
            modelFilters: AppState.modelFilters
        });

        AppState.setTasks(result.tasks);
        AppState.setPagination({
            total: result.total,
            page: result.page,
            pageSize: result.pageSize,
            totalPages: result.totalPages
        });
        AppState.setServerStats(result.stats);

        UI.updateTableHeader();
        UI.updateStats();
        UI.renderTasks();
        UI.renderPagination();
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
        UI.updateTableHeader(true);
    } catch (e) { console.error(e); }
}

async function fetchUserManagementUsers() {
    try {
        const users = await TaskAPI.fetchUsers(); // API endpoint is same currently '/api/admin/users'
        AppState.managementUsers = users;
        UI.renderUserManagement(users, AppState.userGroups);
    } catch (e) { console.error(e); }
}

async function fetchUserGroups() {
    try {
        const groups = await TaskAPI.fetchUserGroups();
        AppState.userGroups = groups;
        return groups;
    } catch (e) {
        console.error(e);
        return [];
    }
}

async function fetchUserManagementData() {
    try {
        await fetchUserGroups();
        const users = await TaskAPI.fetchUsers();
        AppState.managementUsers = users;
        UI.renderUserManagement(users, AppState.userGroups);

        // Load registration toggle state
        const configRes = await fetch('/api/admin/config', { headers: getAuthHeaders() });
        const configData = await configRes.json();
        const toggle = document.getElementById('allow-registration-toggle');
        if (toggle) {
            toggle.checked = configData.allowNewRegistration !== false;
        }
    } catch (e) { console.error(e); }
}

async function handleCreateUserSubmit(e) {
    if (e) e.preventDefault();

    const usernamesInput = document.getElementById('cu-usernames').value.trim();
    if (!usernamesInput) {
        alert('请输入用户名');
        return;
    }

    try {
        const result = await TaskAPI.createUsers(usernamesInput);
        if (result.success) {
            UI.closeModal('create-user-modal');

            // Build result message
            let message = '';
            if (result.created.length > 0) {
                message += `成功创建 ${result.created.length} 个用户`;
            }
            if (result.skipped.length > 0) {
                message += (message ? '，' : '') + `${result.skipped.length} 个用户已存在`;
            }
            if (result.invalid.length > 0) {
                message += (message ? '，' : '') + `${result.invalid.length} 个用户名无效`;
            }

            UI.showToast(message || '操作完成', result.created.length > 0 ? 'success' : 'error');
            fetchUserManagementData();
        }
    } catch (e) {
        alert('创建失败: ' + e.message);
    }
}

async function deleteUserGroup(id, name) {
    if (!confirm(`确定要删除用户组 "${name}" 吗？该组内的用户将被移至默认组。`)) return;
    try {
        await TaskAPI.deleteUserGroup(id);
        await fetchUserManagementData();
        UI.showToast('删除成功');
    } catch (e) {
        alert(e.message);
    }
}

async function deleteUser(id, name) {
    if (!confirm(`确定要删除用户 "${name}" 吗？`)) return;
    try {
        await TaskAPI.deleteUser(id);
        await fetchUserManagementData();
        UI.showToast('删除成功');
    } catch (e) {
        alert(e.message);
    }
}

async function resetUserPassword(id, name) {
    const newPassword = prompt(`请输入用户 "${name}" 的新密码（至少 6 位）：`);
    if (newPassword === null) return; // 用户取消
    if (!newPassword || newPassword.length < 6) {
        alert('密码长度不能少于 6 位');
        return;
    }
    try {
        await TaskAPI.resetUserPassword(id, newPassword);
        UI.showToast(`用户 "${name}" 的密码已重置`);
    } catch (e) {
        alert('重置密码失败: ' + e.message);
    }
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
    // Reset to page 1 when filters change
    AppState.pagination.page = 1;
    refreshTasks();
}

// --- Pagination ---
window.goToPage = function (page) {
    const p = parseInt(page);
    if (isNaN(p) || p < 1 || p > AppState.pagination.totalPages) return;
    AppState.pagination.page = p;
    refreshTasks();
};

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
    const apiKeyVal = document.getElementById('m-api-key').value;
    const activityTimeoutVal = document.getElementById('m-activity-timeout').value;
    const taskTimeoutVal = document.getElementById('m-task-timeout').value;
    const payload = {
        endpoint_name: document.getElementById('m-name').value,
        model_name: document.getElementById('m-model-name').value,
        api_base_url: document.getElementById('m-api-base-url').value,
        description: document.getElementById('m-desc').value,
        is_default_checked: document.getElementById('m-default-checked').checked,
        is_preview_model: document.getElementById('m-preview-model').checked,
        auto_retry_limit: parseInt(document.getElementById('m-auto-retry-limit').value) || 0,
        activity_timeout_seconds: activityTimeoutVal !== '' ? parseInt(activityTimeoutVal) : null,
        task_timeout_seconds: taskTimeoutVal !== '' ? parseInt(taskTimeoutVal) : null
    };
    // Only send api_key if the user typed a new value
    if (apiKeyVal) {
        payload.api_key = apiKeyVal;
    }

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
    // if (!confirm(`确定要删除模型 "${name}" 吗？`)) return;
    try {
        await TaskAPI.deleteModel(id);
        fetchModels();
        UI.showToast('删除成功');
    } catch (e) {
        alert(e.message);
    }
}

async function handleGroupSubmit(e) {
    if (e) e.preventDefault();

    const id = document.getElementById('g-id')?.value;
    const name = document.getElementById('g-name')?.value?.trim();

    if (!name) {
        alert('用户组名称不能为空');
        return;
    }

    try {
        if (id) {
            await TaskAPI.updateUserGroup(id, name);
        } else {
            await TaskAPI.createUserGroup(name);
        }
        UI.closeModal('group-modal');
        await fetchUserManagementData();
        UI.showToast('保存成功');
    } catch (e) {
        alert('保存失败: ' + e.message);
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


// --- Tab Navigation with URL Support ---

/**
 * Switch to a tab and update the URL
 * This is called when user clicks on a tab button
 */
function switchTab(tabId) {
    activateTab(tabId, true);
}

/**
 * Activate a tab with optional URL update
 * @param {string} tabId - The tab identifier
 * @param {boolean} updateURL - Whether to update the browser URL
 */
function activateTab(tabId, updateURL = true) {
    // Update tab button active state
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });

    // Update tab pane visibility
    document.querySelectorAll('.tab-pane').forEach(pane => {
        pane.classList.remove('active');
    });
    const pane = document.getElementById(`tab-${tabId}`);
    if (pane) pane.classList.add('active');

    // Update URL if required
    if (updateURL) {
        const url = new URL(window.location);
        if (tabId === 'tasks') {
            // Remove tab parameter for default tab
            url.searchParams.delete('tab');
        } else {
            url.searchParams.set('tab', tabId);
        }
        window.history.pushState({ tab: tabId }, '', url);
    }

    // Load tab-specific data
    if (tabId === 'feedback-stats') fetchFeedbackStats();
    if (tabId === 'users') fetchUserManagementData();
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
    if (taskId && username) {
        // Use view_user for admin viewing mode to avoid auto-login issues
        window.open(`/task.html?view_user=${encodeURIComponent(username)}&task=${taskId}`, '_blank');
    } else if (username) {
        window.open(`/task.html?view_user=${encodeURIComponent(username)}`, '_blank');
    } else if (taskId) {
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

async function batchRestart() {
    if (AppState.selectedTasks.size === 0) return;
    const stoppedTasks = AppState.filteredTasks
        .filter(t => AppState.selectedTasks.has(t.taskId) && t.queueStatus === 'stopped')
        .map(t => t.taskId);

    if (stoppedTasks.length === 0) { alert('所选任务中没有已中止的任务'); return; }
    if (!confirm(`确定要重启 ${stoppedTasks.length} 个已中止的任务吗？`)) return;

    for (const taskId of stoppedTasks) await TaskAPI.restartTask(taskId).catch(console.error);
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
