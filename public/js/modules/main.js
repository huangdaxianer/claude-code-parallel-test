/**
 * Main Entry Point for Task Manager
 */

import { AppState } from './state.js';
import { TaskAPI, getAuthHeaders } from './api.js';
import { UI } from './ui.js';
import { escapeHtml, formatDateTime } from './utils.js';

// Constants
const REFRESH_INTERVAL = 3000;

document.addEventListener('DOMContentLoaded', () => {
    init();
});

async function init() {
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

    // Initial Load — fetchModels must complete before refreshTasks to ensure
    // model columns are derived from the filtered models API, not from task runs
    fetchUsers();
    fetchQueueStatus();
    await fetchModels();
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
    const validTabs = ['tasks', 'models', 'eval', 'feedback-stats', 'comment-stats', 'reports', 'users', 'qc-mgmt'];

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
    const validTabs = ['tasks', 'models', 'eval', 'feedback-stats', 'comment-stats', 'reports', 'users', 'qc-mgmt'];
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

    // User filter search input (事件委托，因为搜索框是动态生成的)
    document.body.addEventListener('input', (e) => {
        if (e.target.id === 'user-filter-search') {
            const keyword = e.target.value.trim().toLowerCase();
            const popup = e.target.closest('.col-filter-popup');
            if (!popup) return;
            popup.querySelectorAll('.filter-option').forEach(btn => {
                if (btn.dataset.value === '') {
                    // "全部" 选项始终显示
                    btn.style.display = '';
                    return;
                }
                const username = (btn.dataset.username || btn.textContent).toLowerCase();
                btn.style.display = username.includes(keyword) ? '' : 'none';
            });
        }
    });

    // Modal Outside Clicks
    const modalIds = ['prompt-modal', 'config-modal', 'question-modal', 'model-modal', 'group-modal', 'create-user-modal', 'report-modal', 'task-list-modal'];
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

    // Comment stats filters
    ['comment-stats-owner-filter', 'comment-stats-type-filter', 'comment-stats-role-filter'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', () => {
            AppState.commentStatsPagination.page = 1;
            fetchCommentStats();
        });
    });

    // QC stats filters
    ['qc-filter-user', 'qc-filter-inspector', 'qc-filter-task-quality', 'qc-filter-feedback-quality', 'qc-filter-requirement-type', 'qc-filter-trace-completeness'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', () => {
            AppState.qcStatsPagination.page = 1;
            fetchQCStats();
        });
    });
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
                if (popup) {
                    popup.classList.toggle('show');
                    // 自动聚焦搜索框
                    const searchInput = popup.querySelector('.filter-search-input');
                    if (searchInput && popup.classList.contains('show')) {
                        setTimeout(() => searchInput.focus(), 50);
                    }
                }
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

            // Source type filter option clicked
            case 'source-type-filter': {
                const value = actionBtn.dataset.value;
                AppState.sourceTypeFilter = value || '';
                AppState.pagination.page = 1;
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

            // Turns filter apply
            case 'apply-turns-filter': {
                const filterType = actionBtn.dataset.filterType; // 'min' or 'max'
                if (filterType === 'min') {
                    const gteVal = document.getElementById('min-turns-gte')?.value.trim();
                    const lteVal = document.getElementById('min-turns-lte')?.value.trim();
                    AppState.turnsFilters.minTurnsGte = gteVal !== '' ? gteVal : '';
                    AppState.turnsFilters.minTurnsLte = lteVal !== '' ? lteVal : '';
                } else {
                    const gteVal = document.getElementById('max-turns-gte')?.value.trim();
                    const lteVal = document.getElementById('max-turns-lte')?.value.trim();
                    AppState.turnsFilters.maxTurnsGte = gteVal !== '' ? gteVal : '';
                    AppState.turnsFilters.maxTurnsLte = lteVal !== '' ? lteVal : '';
                }
                AppState.pagination.page = 1;
                document.querySelectorAll('.col-filter-popup.show').forEach(p => p.classList.remove('show'));
                AppState.prevModelNamesKey = '';
                UI.updateTableHeader(true);
                refreshTasks();
                break;
            }

            // Turns filter clear
            case 'clear-turns-filter': {
                const filterType = actionBtn.dataset.filterType;
                if (filterType === 'min') {
                    delete AppState.turnsFilters.minTurnsGte;
                    delete AppState.turnsFilters.minTurnsLte;
                } else {
                    delete AppState.turnsFilters.maxTurnsGte;
                    delete AppState.turnsFilters.maxTurnsLte;
                }
                AppState.pagination.page = 1;
                document.querySelectorAll('.col-filter-popup.show').forEach(p => p.classList.remove('show'));
                AppState.prevModelNamesKey = '';
                UI.updateTableHeader(true);
                refreshTasks();
                break;
            }

            case 'stop': stopTask(id); break;
            case 'delete': deleteTask(id); break;
            case 'view': viewTask(id, actionBtn.dataset.username, actionBtn.dataset.modelId); break;

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

            case 'refresh-comment-stats':
                fetchCommentStats();
                break;

            case 'comment-stats-page':
                AppState.commentStatsPagination.page = parseInt(actionBtn.dataset.page) || 1;
                fetchCommentStats();
                break;

            case 'refresh-qc-stats':
                refreshCurrentQcGroup();
                break;

            case 'qc-stats-page':
                AppState.qcStatsPagination.page = parseInt(actionBtn.dataset.page) || 1;
                fetchQCStats();
                break;

            case 'qc-save-concurrency': {
                const val = parseInt(document.getElementById('qc-concurrency')?.value);
                if (val >= 1 && val <= 100) {
                    try {
                        await TaskAPI.updateQcConcurrency(val);
                        alert('并发数已保存');
                    } catch (e) { alert('保存失败'); }
                } else { alert('并发数需在 1-100 之间'); }
                break;
            }

            case 'cls-start-all': {
                if (!confirm('确认对所有待分类任务开始打标？')) break;
                try {
                    const result = await TaskAPI.startClsAll();
                    if (result.success) {
                        alert(`已提交 ${result.enqueued} 条题目分类任务`);
                        fetchQCStats();
                    } else { alert(result.error || '启动失败'); }
                } catch (e) { alert('启动全部题目分类失败'); }
                break;
            }

            case 'trace-start-all': {
                if (!confirm('确认对所有待质检记录开始打标？')) break;
                try {
                    const result = await TaskAPI.startTraceAll();
                    if (result.success) {
                        alert(`已提交 ${result.enqueued} 条反馈质检任务`);
                        fetchQCStats();
                    } else { alert(result.error || '启动失败'); }
                } catch (e) { alert('启动全部反馈质检失败'); }
                break;
            }

            case 'refresh-reports':
                fetchReportList();
                break;

            case 'open-create-report':
                openCreateReportModal();
                break;

            case 'report-next-step':
                handleReportNextStep(parseInt(actionBtn.dataset.current));
                break;

            case 'report-prev-step':
                handleReportPrevStep(parseInt(actionBtn.dataset.current));
                break;

            case 'report-create':
                handleReportCreate();
                break;

            case 'delete-report':
                handleDeleteReport(id);
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

    // Handle task submission toggle
    if (target.dataset.action === 'toggle-allow-task-submission') {
        const isAllowed = target.checked;
        try {
            await TaskAPI.updateConfig({ allowNewTaskSubmission: isAllowed });
            UI.showToast(isAllowed ? '已开启新任务提交' : '已关闭新任务提交');
        } catch (e) {
            UI.showToast('更新失败: ' + e.message, 'error');
            target.checked = !isAllowed; // revert
        }
    }

    // Handle external login toggle
    if (target.dataset.action === 'toggle-allow-external-login') {
        const isAllowed = target.checked;
        try {
            await TaskAPI.updateConfig({ allowExternalLogin: isAllowed });
            UI.showToast(isAllowed ? '已允许外部评测人员登录' : '已禁止外部评测人员登录');
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
            modelFilters: AppState.modelFilters,
            sourceType: AppState.sourceTypeFilter,
            turnsFilters: AppState.turnsFilters
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
        const taskToggle = document.getElementById('allow-task-submission-toggle');
        if (taskToggle) {
            taskToggle.checked = configData.allowNewTaskSubmission !== false;
        }
        const externalLoginToggle = document.getElementById('allow-external-login-toggle');
        if (externalLoginToggle) {
            externalLoginToggle.checked = configData.allowExternalLogin !== false;
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

async function fetchCommentStats() {
    try {
        const taskOwner = document.getElementById('comment-stats-owner-filter')?.value || '';
        const commentType = document.getElementById('comment-stats-type-filter')?.value || 'all';
        const commenterType = document.getElementById('comment-stats-role-filter')?.value || '';

        const result = await TaskAPI.fetchCommentStats({
            page: AppState.commentStatsPagination.page,
            pageSize: AppState.commentStatsPagination.pageSize,
            taskOwner,
            commentType,
            commenterType
        });

        if (result.success) {
            AppState.commentStatsData = result.data;
            AppState.commentStatsPagination = {
                page: result.page,
                pageSize: result.pageSize,
                total: result.total,
                totalPages: result.totalPages
            };
            AppState.commentStatsTaskOwners = result.taskOwners || [];

            // Populate task owner dropdown (preserve current selection)
            const ownerSelect = document.getElementById('comment-stats-owner-filter');
            if (ownerSelect) {
                const currentVal = ownerSelect.value;
                ownerSelect.innerHTML = '<option value="">全部</option>' +
                    AppState.commentStatsTaskOwners.map(u =>
                        `<option value="${u.id}" ${String(u.id) === currentVal ? 'selected' : ''}>${escapeHtml(u.username)}</option>`
                    ).join('');
            }

            UI.renderCommentStats(AppState.commentStatsData, AppState.commentStatsPagination);
        }
    } catch (e) { console.error('Error fetching comment stats:', e); }
}

async function fetchQCStats() {
    try {
        // 首次加载时设置并发数输入框
        const concurrencyInput = document.getElementById('qc-concurrency');
        if (concurrencyInput && !concurrencyInput.dataset.loaded) {
            try {
                const cfgRes = await fetch('/api/admin/config', { headers: getAuthHeaders() });
                const cfg = await cfgRes.json();
                if (cfg.aiQcConcurrency) concurrencyInput.value = cfg.aiQcConcurrency;
                concurrencyInput.dataset.loaded = '1';
            } catch (e) { /* ignore */ }
        }

        const userId = document.getElementById('qc-filter-user')?.value || '';
        const inspector = document.getElementById('qc-filter-inspector')?.value || '';
        const taskQuality = document.getElementById('qc-filter-task-quality')?.value || '';
        const feedbackQuality = document.getElementById('qc-filter-feedback-quality')?.value || '';
        const requirementType = document.getElementById('qc-filter-requirement-type')?.value || '';
        const traceCompleteness = document.getElementById('qc-filter-trace-completeness')?.value || '';

        const result = await TaskAPI.fetchQCStats({
            page: AppState.qcStatsPagination.page,
            pageSize: AppState.qcStatsPagination.pageSize,
            userId,
            inspector,
            taskQuality,
            feedbackQuality,
            requirementType,
            traceCompleteness
        });

        if (result.success) {
            AppState.qcStatsData = result.data;
            AppState.qcStatsPagination = {
                page: result.page,
                pageSize: result.pageSize,
                total: result.total,
                totalPages: result.totalPages
            };

            // Update counts
            const pendingEl = document.getElementById('qc-count-pending');
            const completedEl = document.getElementById('qc-count-completed');
            if (pendingEl) pendingEl.textContent = result.stats?.pending || 0;
            if (completedEl) completedEl.textContent = result.stats?.completed || 0;

            // Populate user dropdown (preserve selection)
            const userSelect = document.getElementById('qc-filter-user');
            if (userSelect && result.submitters) {
                const currentVal = userSelect.value;
                userSelect.innerHTML = '<option value="">全部</option>' +
                    result.submitters.map(u =>
                        `<option value="${u.id}" ${String(u.id) === currentVal ? 'selected' : ''}>${escapeHtml(u.username)}</option>`
                    ).join('');
            }

            // Populate inspector dropdown (preserve selection)
            const inspectorSelect = document.getElementById('qc-filter-inspector');
            if (inspectorSelect && result.inspectors) {
                const currentVal = inspectorSelect.value;
                inspectorSelect.innerHTML = '<option value="">全部</option>' +
                    result.inspectors.map(name =>
                        `<option value="${escapeHtml(name)}" ${name === currentVal ? 'selected' : ''}>${escapeHtml(name)}</option>`
                    ).join('');
            }

            // Populate requirement type dropdown (preserve selection, add dynamic values)
            const reqTypeSelect = document.getElementById('qc-filter-requirement-type');
            if (reqTypeSelect && result.requirementTypes) {
                const currentVal = reqTypeSelect.value;
                reqTypeSelect.innerHTML = '<option value="">全部</option>' +
                    '<option value="__pending__"' + (currentVal === '__pending__' ? ' selected' : '') + '>待打标</option>' +
                    '<option value="__running__"' + (currentVal === '__running__' ? ' selected' : '') + '>打标中</option>' +
                    result.requirementTypes.map(t =>
                        `<option value="${escapeHtml(t)}" ${t === currentVal ? 'selected' : ''}>${escapeHtml(t)}</option>`
                    ).join('');
            }

            // Populate trace completeness dropdown (preserve selection)
            const traceSelect = document.getElementById('qc-filter-trace-completeness');
            if (traceSelect && result.traceCompletenessValues) {
                const currentVal = traceSelect.value;
                traceSelect.innerHTML = '<option value="">全部</option>' +
                    '<option value="__pending__"' + (currentVal === '__pending__' ? ' selected' : '') + '>待打标</option>' +
                    '<option value="__running__"' + (currentVal === '__running__' ? ' selected' : '') + '>打标中</option>' +
                    result.traceCompletenessValues.map(t =>
                        `<option value="${escapeHtml(t)}" ${t === currentVal ? 'selected' : ''}>${escapeHtml(t)}</option>`
                    ).join('');
            }

            // 更新 AI 打标进度文本
            updateAiProgressText();

            UI.renderQCStats(AppState.qcStatsData, AppState.qcStatsPagination);
        }
    } catch (e) { console.error('Error fetching QC stats:', e); }
}

async function updateAiProgressText() {
    try {
        const progressEl = document.getElementById('qc-ai-progress-text');
        if (!progressEl) return;
        const [clsProgress, traceProgress] = await Promise.all([
            TaskAPI.fetchClsProgress(),
            TaskAPI.fetchTraceProgress()
        ]);
        const parts = [];
        if (clsProgress.success && (clsProgress.running > 0 || clsProgress.pending > 0)) {
            parts.push(`分类: ${clsProgress.running || 0}运行/${clsProgress.pending || 0}排队`);
        }
        if (traceProgress.success && (traceProgress.running > 0 || traceProgress.pending > 0)) {
            parts.push(`轨迹: ${traceProgress.running || 0}运行/${traceProgress.pending || 0}排队`);
        }
        progressEl.textContent = parts.length > 0 ? parts.join(' | ') : '';
    } catch (e) { /* ignore */ }
}


// ===== 刷新质检数据 =====
function refreshCurrentQcGroup() {
    fetchQCStats();
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
        always_thinking_enabled: document.getElementById('m-always-thinking').checked,
        auto_retry_limit: parseInt(document.getElementById('m-auto-retry-limit').value) || 0,
        activity_timeout_seconds: activityTimeoutVal !== '' ? parseInt(activityTimeoutVal) : null,
        task_timeout_seconds: taskTimeoutVal !== '' ? parseInt(taskTimeoutVal) : null,
        provider: document.getElementById('m-provider').value.trim() || null
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
    if (tabId === 'comment-stats') fetchCommentStats();
    if (tabId === 'qc-mgmt') { refreshCurrentQcGroup(); }
    if (tabId === 'users') fetchUserManagementData();
    if (tabId === 'models') fetchModels();
    if (tabId === 'reports') initReportTab();
}

window.openConfigModal = function () {
    UI.openConfigModal(AppState.queueStatus.maxParallelSubtasks);
};

window.openDistributionModal = async function (type) {
    const titleMap = { completed: '已完成任务 - 子任务分布', feedbacked: '已反馈任务 - 子任务分布' };
    const titleEl = document.getElementById('distribution-modal-title');
    const contentEl = document.getElementById('distribution-modal-content');
    if (!titleEl || !contentEl) return;

    titleEl.textContent = titleMap[type] || '子任务分布';
    contentEl.innerHTML = '<div style="text-align:center; padding:1rem; color:#94a3b8;">加载中...</div>';
    document.getElementById('distribution-modal').classList.add('show');

    try {
        const res = await fetch(`/api/admin/subtask-distribution?type=${type}`);
        const data = await res.json();
        const dist = data.distribution || [];

        if (dist.length === 0) {
            contentEl.innerHTML = '<div style="text-align:center; padding:1rem; color:#94a3b8;">暂无数据</div>';
            return;
        }

        const label = type === 'feedbacked' ? '反馈' : '完成';
        contentEl.innerHTML = dist.map(d =>
            `<div class="subtask-distribution-item">
                <span>${label}了 ${d.subtask_count} 条子任务</span>
                <span class="count">${d.task_count} 个任务</span>
            </div>`
        ).join('');
    } catch (e) {
        console.error('Error fetching subtask distribution:', e);
        contentEl.innerHTML = '<div style="text-align:center; padding:1rem; color:#ef4444;">加载失败</div>';
    }
};

window.openTaskListModal = async function (status) {
    const titleMap = { running: '进行中任务', stopped: '已中止任务' };
    const titleEl = document.getElementById('task-list-modal-title');
    const contentEl = document.getElementById('task-list-modal-content');
    if (!titleEl || !contentEl) return;

    titleEl.textContent = titleMap[status] || '任务列表';
    contentEl.innerHTML = '<p style="color: #94a3b8; text-align: center; padding: 2rem 0;">加载中...</p>';
    document.getElementById('task-list-modal')?.classList.add('show');

    try {
        const res = await fetch(`/api/admin/model-runs-by-status?status=${status}`);
        const data = await res.json();
        const runs = data.runs || [];

        if (runs.length === 0) {
            contentEl.innerHTML = `<p style="color: #94a3b8; text-align: center; padding: 2rem 0;">暂无${titleMap[status]}</p>`;
            return;
        }

        const escapeHtml = (s) => {
            const div = document.createElement('div');
            div.textContent = s || '';
            return div.innerHTML;
        };

        const stopReasonMap = {
            activity_timeout: '活动超时',
            wall_clock_timeout: '总时间超时',
            manual_stop: '手动中止',
            is_error: '执行出错',
            abnormal_completion: '异常完成',
            process_error: '进程错误',
            non_zero_exit: '非零退出',
            orphaned: '孤儿进程',
            server_restart: '服务器重启'
        };

        const showBatchRestart = status === 'stopped';

        // Collect unique values for filters
        const uniqueUsers = [...new Set(runs.map(r => r.username || '-'))].sort();
        const uniqueModels = [...new Set(runs.map(r => r.model_name || r.model_id || '-'))].sort();
        const uniqueReasons = [...new Set(runs.map(r => r.stop_reason || ''))].sort();

        const filters = { user: '', model: '', reason: '' };

        const buildFilterOption = (value, label) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;

        const filterSelectStyle = 'padding: 0.3rem 0.5rem; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 0.8rem; color: #334155; background: #fff; min-width: 80px; max-width: 160px;';

        const filterBarHtml = `<div style="display: flex; gap: 0.75rem; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap;">
            <span style="font-size: 0.8rem; color: #64748b;">筛选:</span>
            <select id="tlm-filter-user" style="${filterSelectStyle}">
                <option value="">全部用户</option>
                ${uniqueUsers.map(u => buildFilterOption(u, u)).join('')}
            </select>
            <select id="tlm-filter-model" style="${filterSelectStyle}">
                <option value="">全部模型</option>
                ${uniqueModels.map(m => buildFilterOption(m, m)).join('')}
            </select>
            <select id="tlm-filter-reason" style="${filterSelectStyle}">
                <option value="">全部原因</option>
                ${uniqueReasons.filter(r => r).map(r => buildFilterOption(r, stopReasonMap[r] || r)).join('')}
            </select>
            <span id="tlm-filter-count" style="font-size: 0.8rem; color: #94a3b8; margin-left: auto;"></span>
        </div>`;

        function renderRows(filteredRuns) {
            return filteredRuns.map(r => {
                const title = escapeHtml(r.title || r.prompt?.substring(0, 60) || '-');
                const time = r.created_at ? formatDateTime(r.created_at) : '-';
                const reason = r.stop_reason ? (stopReasonMap[r.stop_reason] || r.stop_reason) : '-';
                const retries = r.retry_count != null ? r.retry_count : 0;
                const taskUrl = `/task.html?view_user=${encodeURIComponent(r.username || '')}&task=${encodeURIComponent(r.task_id)}`;
                const checkboxHtml = showBatchRestart
                    ? `<td style="padding: 0.6rem 0.5rem; text-align: center;"><input type="checkbox" class="task-list-cb" data-task-id="${escapeHtml(r.task_id)}" /></td>`
                    : '';
                return `<tr style="border-bottom: 1px solid #f1f5f9;">
                    ${checkboxHtml}
                    <td style="padding: 0.6rem 0.75rem; font-family: Menlo, monospace; font-size: 0.8rem;"><a href="${taskUrl}" target="_blank" style="color: #3b82f6; text-decoration: none;">${escapeHtml(r.task_id)}</a></td>
                    <td style="padding: 0.6rem 0.75rem; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${title}</td>
                    <td style="padding: 0.6rem 0.75rem; color: #64748b; font-size: 0.85rem;">${escapeHtml(r.username || '-')}</td>
                    <td style="padding: 0.6rem 0.75rem; color: #64748b; font-size: 0.85rem;">${escapeHtml(r.model_name || r.model_id || '-')}</td>
                    <td style="padding: 0.6rem 0.75rem; color: ${r.stop_reason ? '#ef4444' : '#64748b'}; font-size: 0.85rem;">${reason}</td>
                    <td style="padding: 0.6rem 0.75rem; color: #64748b; font-size: 0.85rem; text-align: center;">${retries}</td>
                    <td style="padding: 0.6rem 0.75rem; color: #64748b; font-size: 0.85rem; white-space: nowrap;">${time}</td>
                </tr>`;
            }).join('');
        }

        function applyFilters() {
            const filtered = runs.filter(r => {
                if (filters.user && (r.username || '-') !== filters.user) return false;
                if (filters.model && (r.model_name || r.model_id || '-') !== filters.model) return false;
                if (filters.reason && (r.stop_reason || '') !== filters.reason) return false;
                return true;
            });
            const tbody = contentEl.querySelector('#tlm-tbody');
            if (tbody) tbody.innerHTML = renderRows(filtered);
            const countEl = document.getElementById('tlm-filter-count');
            if (countEl) {
                countEl.textContent = filtered.length < runs.length ? `${filtered.length} / ${runs.length} 条` : `共 ${runs.length} 条`;
            }
            // Reset select-all and update count
            const selectAllCb = document.getElementById('task-list-select-all');
            if (selectAllCb) selectAllCb.checked = false;
            updateSelectedCount();
        }

        function updateSelectedCount() {
            const countEl = document.getElementById('task-list-selected-count');
            const batchBtn = document.getElementById('task-list-batch-restart-btn');
            if (!countEl) return;
            const checked = contentEl.querySelectorAll('.task-list-cb:checked');
            countEl.textContent = checked.length;
            if (batchBtn) batchBtn.disabled = checked.length === 0;
        }

        const checkAllHtml = showBatchRestart
            ? `<th style="padding: 0.5rem 0.5rem; width: 36px; text-align: center;"><input type="checkbox" id="task-list-select-all" /></th>`
            : '';

        const batchBarHtml = showBatchRestart
            ? `<div id="task-list-batch-bar" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem;">
                <span style="font-size: 0.85rem; color: #64748b;">已选 <strong id="task-list-selected-count">0</strong> 个任务</span>
                <button id="task-list-batch-restart-btn" class="btn btn-primary" style="font-size: 0.85rem; padding: 0.4rem 1rem;" disabled>批量重启</button>
               </div>`
            : '';

        contentEl.innerHTML = `${filterBarHtml}${batchBarHtml}<table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
            <thead><tr style="border-bottom: 2px solid #e2e8f0; text-align: left;">
                ${checkAllHtml}
                <th style="padding: 0.5rem 0.75rem; font-weight: 600; color: #475569;">ID</th>
                <th style="padding: 0.5rem 0.75rem; font-weight: 600; color: #475569;">标题</th>
                <th style="padding: 0.5rem 0.75rem; font-weight: 600; color: #475569;">用户</th>
                <th style="padding: 0.5rem 0.75rem; font-weight: 600; color: #475569;">模型</th>
                <th style="padding: 0.5rem 0.75rem; font-weight: 600; color: #475569;">失败原因</th>
                <th style="padding: 0.5rem 0.75rem; font-weight: 600; color: #475569;">重试</th>
                <th style="padding: 0.5rem 0.75rem; font-weight: 600; color: #475569;">创建时间</th>
            </tr></thead>
            <tbody id="tlm-tbody">${renderRows(runs)}</tbody>
        </table>`;

        // Show initial count
        const filterCountEl = document.getElementById('tlm-filter-count');
        if (filterCountEl) filterCountEl.textContent = `共 ${runs.length} 条`;

        // Filter event listeners
        document.getElementById('tlm-filter-user')?.addEventListener('change', (e) => { filters.user = e.target.value; applyFilters(); });
        document.getElementById('tlm-filter-model')?.addEventListener('change', (e) => { filters.model = e.target.value; applyFilters(); });
        document.getElementById('tlm-filter-reason')?.addEventListener('change', (e) => { filters.reason = e.target.value; applyFilters(); });

        // Batch restart event bindings for stopped tasks
        if (showBatchRestart) {
            const selectAllCb = document.getElementById('task-list-select-all');
            const batchBtn = document.getElementById('task-list-batch-restart-btn');

            selectAllCb?.addEventListener('change', () => {
                contentEl.querySelectorAll('.task-list-cb').forEach(cb => { cb.checked = selectAllCb.checked; });
                updateSelectedCount();
            });

            contentEl.addEventListener('change', (e) => {
                if (e.target.classList.contains('task-list-cb')) updateSelectedCount();
            });

            batchBtn?.addEventListener('click', async () => {
                const checkedCbs = contentEl.querySelectorAll('.task-list-cb:checked');
                const taskIds = [...new Set([...checkedCbs].map(cb => cb.dataset.taskId))];
                if (taskIds.length === 0) return;
                if (!confirm(`确定要重启 ${taskIds.length} 个任务吗？`)) return;

                batchBtn.disabled = true;
                batchBtn.textContent = '重启中...';
                let successCount = 0;
                for (const taskId of taskIds) {
                    try {
                        await TaskAPI.restartTask(taskId);
                        successCount++;
                    } catch (err) {
                        console.error(`Failed to restart ${taskId}:`, err);
                    }
                }
                alert(`已成功重启 ${successCount} / ${taskIds.length} 个任务`);
                UI.closeModal('task-list-modal');
                refreshTasks();
            });
        }
    } catch (e) {
        contentEl.innerHTML = `<p style="color: #ef4444; text-align: center; padding: 2rem 0;">加载失败: ${e.message}</p>`;
    }
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

function viewTask(taskId, username, modelId) {
    let url;
    if (taskId && username) {
        // Use view_user for admin viewing mode to avoid auto-login issues
        url = `/task.html?view_user=${encodeURIComponent(username)}&task=${taskId}`;
    } else if (username) {
        url = `/task.html?view_user=${encodeURIComponent(username)}`;
    } else if (taskId) {
        url = `/task.html?id=${taskId}`;
    }
    if (url && modelId) {
        url += `&model=${encodeURIComponent(modelId)}`;
    }
    if (url) window.open(url, '_blank');
}

async function updateMaxParallel() {
    // ... implemented in previous step, kept same logic
    const input = document.getElementById('max-parallel-input');
    const value = parseInt(input.value, 10);
    if (isNaN(value) || value < 1 || value > 200) {
        alert('并行数必须在 1-200 之间');
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

// ============ Report Functions ============

let reportState = {
    currentStep: 1,
    reportType: 'trace_only',
    models: [],
    selectedModelIds: [],
    questions: [],
    selectedQuestionIds: [],
    questionWeights: {},
    availableTasks: [],
    filteredTasks: [],
    selectedTaskIds: [],
    availableUsers: [],
    selectedUsernames: [],
    reportsList: []
};

async function initReportTab() {
    fetchReportList();
}

async function openCreateReportModal() {
    reportState.currentStep = 1;
    reportState.selectedQuestionIds = [];
    reportState.questionWeights = {};
    reportState.availableTasks = [];
    reportState.filteredTasks = [];
    reportState.availableUsers = [];
    reportState.selectedUsernames = [];
    updateReportStepUI(1);
    document.getElementById('report-modal')?.classList.add('show');
    try {
        const [models, questions] = await Promise.all([
            TaskAPI.fetchReportModels(),
            TaskAPI.fetchReportQuestions()
        ]);
        reportState.models = models;
        reportState.questions = questions;
        renderReportModels();
    } catch (e) {
        console.error('[Report] Error loading models/questions:', e);
    }
}

function renderReportModels() {
    const container = document.getElementById('report-models-list');
    if (!reportState.models.length) {
        container.innerHTML = '<p style="color: #94a3b8;">暂无可用模型</p>';
        return;
    }
    container.innerHTML = reportState.models.map(m => `
        <label class="report-model-item">
            <input type="checkbox" value="${m.id}" class="report-model-checkbox">
            <span class="report-item-label">${escapeHtml(m.name)}</span>
            ${m.description ? `<span class="report-item-meta">${escapeHtml(m.description)}</span>` : ''}
        </label>
    `).join('');
}

function renderReportTasks() {
    const container = document.getElementById('report-tasks-list');
    const tasks = reportState.filteredTasks;
    if (!tasks.length) {
        container.innerHTML = '<p style="color: #94a3b8;">没有符合条件的任务</p>';
        return;
    }

    // 判断任务是否"合格"：题目分类不为"不符合要求"，且所有子任务轨迹完整度不为"轨迹不完整"
    const isQualified = (t) => t.requirement_type !== '不符合要求' && !t.has_incomplete_trace;

    container.innerHTML = tasks.map(t => {
        const qualified = isQualified(t);
        // 不合格任务显示标记
        let badge = '';
        if (t.requirement_type === '不符合要求') {
            badge = '<span style="font-size:0.7rem;color:#ef4444;margin-left:0.25rem;">不符合要求</span>';
        } else if (t.has_incomplete_trace) {
            badge = '<span style="font-size:0.7rem;color:#f59e0b;margin-left:0.25rem;">轨迹不完整</span>';
        }
        return `<label class="report-task-item" style="${qualified ? '' : 'opacity:0.6;'}">
            <input type="checkbox" value="${t.task_id}" class="report-task-checkbox" data-qualified="${qualified ? '1' : '0'}">
            <span class="report-item-label">${escapeHtml(t.title || 'Untitled')}${badge}</span>
            <span class="report-item-meta">${escapeHtml(t.username)} · ${t.task_id}</span>
        </label>`;
    }).join('');

    // "全选所有合格任务" — 默认选中
    const selectQualified = document.getElementById('report-select-qualified-tasks');
    if (selectQualified) {
        selectQualified.checked = true;
        // 默认勾选所有合格任务
        document.querySelectorAll('.report-task-checkbox').forEach(cb => {
            cb.checked = cb.dataset.qualified === '1';
        });
        selectQualified.onchange = () => {
            document.querySelectorAll('.report-task-checkbox').forEach(cb => {
                if (cb.dataset.qualified === '1') cb.checked = selectQualified.checked;
            });
        };
    }

    // "全选" — 选中所有任务（包括不合格的）
    const selectAll = document.getElementById('report-select-all-tasks');
    if (selectAll) {
        selectAll.checked = false;
        selectAll.onchange = () => {
            document.querySelectorAll('.report-task-checkbox').forEach(cb => {
                cb.checked = selectAll.checked;
            });
            // 同步更新"合格"复选框状态
            if (selectQualified) selectQualified.checked = selectAll.checked;
        };
    }
}

function renderReportQuestions() {
    const container = document.getElementById('report-questions-list');
    const questions = reportState.questions;
    if (!questions || !questions.length) {
        container.innerHTML = '<p style="color: #94a3b8;">暂无可用评分维度</p>';
        return;
    }
    container.innerHTML = questions.map(q => `
        <label class="report-model-item" style="display: flex; align-items: center;">
            <input type="checkbox" value="${q.id}" class="report-question-checkbox" checked>
            <span class="report-item-label" style="flex: 1;">${escapeHtml(q.short_name || q.stem)}</span>
            <span class="report-item-meta" style="margin-right: 0.5rem;">${q.scoring_type === 'stars_5' ? '5分制' : '3分制'}</span>
            <span style="display: inline-flex; align-items: center; gap: 0.25rem; flex-shrink: 0;">
                <input type="number" class="report-question-weight" data-question-id="${q.id}" value="" min="0" max="100" step="1"
                    style="width: 52px; padding: 0.2rem 0.3rem; border: 1px solid #d1d5db; border-radius: 4px; text-align: right; font-size: 0.85rem;"
                    placeholder="0">
                <span style="font-size: 0.85rem; color: #64748b;">%</span>
            </span>
        </label>
    `).join('');

    // Auto-distribute equal weights on initial render
    distributeEqualWeights();

    const selectAll = document.getElementById('report-select-all-questions');
    if (selectAll) {
        selectAll.checked = true;
        selectAll.onchange = () => {
            document.querySelectorAll('.report-question-checkbox').forEach(cb => {
                cb.checked = selectAll.checked;
            });
            distributeEqualWeights();
        };
    }

    // When a checkbox changes, redistribute weights
    container.addEventListener('change', (e) => {
        if (e.target.classList.contains('report-question-checkbox')) {
            distributeEqualWeights();
        }
    });

    // Update weight status on weight input change
    container.addEventListener('input', (e) => {
        if (e.target.classList.contains('report-question-weight')) {
            updateWeightStatus();
        }
    });

    // Equal weight button
    const equalBtn = document.getElementById('report-equal-weights-btn');
    if (equalBtn) {
        equalBtn.onclick = () => distributeEqualWeights();
    }
}

function distributeEqualWeights() {
    const checkedBoxes = document.querySelectorAll('.report-question-checkbox:checked');
    const count = checkedBoxes.length;
    if (count === 0) {
        document.querySelectorAll('.report-question-weight').forEach(w => { w.value = ''; });
        updateWeightStatus();
        return;
    }
    const base = Math.floor(100 / count);
    const remainder = 100 - base * count;
    const checkedIds = new Set(Array.from(checkedBoxes).map(cb => cb.value));

    let idx = 0;
    document.querySelectorAll('.report-question-weight').forEach(w => {
        if (checkedIds.has(w.dataset.questionId)) {
            w.value = idx < remainder ? base + 1 : base;
            idx++;
        } else {
            w.value = '';
        }
    });
    updateWeightStatus();
}

function updateWeightStatus() {
    const statusEl = document.getElementById('report-weight-status');
    if (!statusEl) return;
    const checkedIds = new Set(Array.from(document.querySelectorAll('.report-question-checkbox:checked')).map(cb => cb.value));
    let total = 0;
    document.querySelectorAll('.report-question-weight').forEach(w => {
        if (checkedIds.has(w.dataset.questionId)) {
            total += parseInt(w.value) || 0;
        }
    });
    if (checkedIds.size === 0) {
        statusEl.textContent = '';
        statusEl.style.color = '#64748b';
    } else if (total === 100) {
        statusEl.textContent = '✓ 权重合计 100%';
        statusEl.style.color = '#16a34a';
    } else {
        statusEl.textContent = `✗ 权重合计 ${total}%，需要等于 100%`;
        statusEl.style.color = '#dc2626';
    }
}

function updateReportStepUI(step) {
    reportState.currentStep = step;
    const isScore = reportState.reportType === 'trace_and_score';

    // Show/hide abilities step indicator
    document.querySelectorAll('.report-step-abilities, .report-step-line-abilities').forEach(el => {
        el.style.display = isScore ? '' : 'none';
    });
    // Update users step number display
    const usersStepNum = document.querySelector('#report-step-indicator .report-step[data-step="4"] .step-num-text');
    if (usersStepNum) usersStepNum.textContent = isScore ? '4' : '3';
    // Update tasks step number display
    const tasksStepNum = document.querySelector('#report-step-indicator .report-step[data-step="5"] .step-num-text-tasks');
    if (tasksStepNum) tasksStepNum.textContent = isScore ? '5' : '4';

    document.querySelectorAll('.report-step-content').forEach(el => el.classList.remove('active'));
    const stepEl = document.getElementById(`report-step-${step}`);
    if (stepEl) stepEl.classList.add('active');

    document.querySelectorAll('#report-step-indicator .report-step').forEach(el => {
        const s = parseInt(el.dataset.step);
        if (s === 3 && !isScore) return; // skip abilities step
        el.classList.remove('active', 'completed');
        if (s === step) el.classList.add('active');
        else if (s < step) el.classList.add('completed');
    });
}

async function handleReportNextStep(current) {
    if (current === 1) {
        const typeRadio = document.querySelector('input[name="report-type"]:checked');
        reportState.reportType = typeRadio ? typeRadio.value : 'trace_only';
        updateReportStepUI(2);
    } else if (current === 2) {
        const checkedModels = Array.from(document.querySelectorAll('.report-model-checkbox:checked')).map(cb => cb.value);
        if (checkedModels.length === 0) {
            alert('请至少选择一个模型');
            return;
        }
        reportState.selectedModelIds = checkedModels;

        if (reportState.reportType === 'trace_and_score') {
            renderReportQuestions();
            updateReportStepUI(3);
        } else {
            await loadUsersStep(checkedModels);
        }
    } else if (current === 3) {
        const checkedQuestions = Array.from(document.querySelectorAll('.report-question-checkbox:checked')).map(cb => parseInt(cb.value));
        if (checkedQuestions.length === 0) {
            alert('请至少选择一个评分维度');
            return;
        }
        // Collect and validate weights
        const checkedIds = new Set(checkedQuestions.map(String));
        const questionWeights = {};
        let totalWeight = 0;
        document.querySelectorAll('.report-question-weight').forEach(w => {
            if (checkedIds.has(w.dataset.questionId)) {
                const val = parseInt(w.value) || 0;
                questionWeights[w.dataset.questionId] = val;
                totalWeight += val;
            }
        });
        if (totalWeight !== 100) {
            alert(`权重合计为 ${totalWeight}%，需要等于 100%`);
            return;
        }
        reportState.selectedQuestionIds = checkedQuestions;
        reportState.questionWeights = questionWeights;
        await loadUsersStep(reportState.selectedModelIds);
    } else if (current === 4) {
        const checkedUsers = Array.from(document.querySelectorAll('.report-user-checkbox:checked')).map(cb => cb.value);
        if (checkedUsers.length === 0) {
            alert('请至少选择一个用户');
            return;
        }
        reportState.selectedUsernames = checkedUsers;
        reportState.filteredTasks = reportState.availableTasks.filter(
            t => checkedUsers.includes(t.username)
        );
        loadFilteredTasksStep();
    }
}

async function loadUsersStep(checkedModels) {
    const usersContainer = document.getElementById('report-users-list');
    usersContainer.innerHTML = '<p style="color: #94a3b8;">加载中...</p>';
    updateReportStepUI(4);

    try {
        reportState.availableTasks = await TaskAPI.fetchAvailableTasks(reportState.reportType, reportState.selectedModelIds);

        // Extract unique users with task counts
        const userMap = new Map();
        reportState.availableTasks.forEach(t => {
            userMap.set(t.username, (userMap.get(t.username) || 0) + 1);
        });
        reportState.availableUsers = Array.from(userMap.entries()).map(
            ([username, taskCount]) => ({ username, taskCount })
        );

        renderReportUsers();
    } catch (e) {
        usersContainer.innerHTML = '<p style="color: #ef4444;">加载失败，请重试</p>';
        console.error('[Report] Error loading users:', e);
    }
}

function renderReportUsers() {
    const container = document.getElementById('report-users-list');
    const users = reportState.availableUsers;
    if (!users.length) {
        container.innerHTML = '<p style="color: #94a3b8;">没有符合条件的用户</p>';
        return;
    }
    container.innerHTML = users.map(u => `
        <label class="report-user-item">
            <input type="checkbox" value="${escapeHtml(u.username)}" class="report-user-checkbox" checked>
            <span class="report-item-label">${escapeHtml(u.username)}</span>
            <span class="report-item-meta">${u.taskCount} 个任务</span>
        </label>
    `).join('');

    const selectAll = document.getElementById('report-select-all-users');
    if (selectAll) {
        selectAll.checked = true;
        selectAll.onchange = () => {
            document.querySelectorAll('.report-user-checkbox').forEach(cb => {
                cb.checked = selectAll.checked;
            });
        };
    }
}

function loadFilteredTasksStep() {
    const hint = document.getElementById('report-task-hint');
    const checkedModels = reportState.selectedModelIds;
    if (reportState.reportType === 'trace_only') {
        hint.textContent = `仅展示所选 ${checkedModels.length} 个模型的子任务全部为「已完成」或「已反馈」的任务`;
    } else {
        hint.textContent = `仅展示所选 ${checkedModels.length} 个模型的子任务全部为「已反馈」的任务`;
    }

    updateReportStepUI(5);
    renderReportTasks();
}

function handleReportPrevStep(current) {
    if (current === 5) {
        updateReportStepUI(4);
    } else if (current === 4) {
        if (reportState.reportType === 'trace_and_score') {
            updateReportStepUI(3);
        } else {
            updateReportStepUI(2);
        }
    } else if (current > 1) {
        updateReportStepUI(current - 1);
    }
}

async function handleReportCreate() {
    const checkedTasks = Array.from(document.querySelectorAll('.report-task-checkbox:checked')).map(cb => cb.value);
    if (checkedTasks.length === 0) {
        alert('请至少选择一个任务');
        return;
    }
    reportState.selectedTaskIds = checkedTasks;

    const titleInput = document.getElementById('report-title-input');
    const title = titleInput ? titleInput.value.trim() : '';

    const btn = document.getElementById('report-create-btn');
    btn.disabled = true;
    btn.textContent = '创建中...';

    try {
        const result = await TaskAPI.createReport(
            reportState.reportType,
            reportState.selectedModelIds,
            reportState.selectedTaskIds,
            title || undefined,
            reportState.reportType === 'trace_and_score' ? reportState.selectedQuestionIds : undefined,
            reportState.reportType === 'trace_and_score' ? reportState.questionWeights : undefined
        );
        if (result.success) {
            UI.showToast('报告创建成功');
            window.open(result.reportUrl, '_blank');
            UI.closeModal('report-modal');
            reportState.currentStep = 1;
            updateReportStepUI(1);
            if (titleInput) titleInput.value = '';
            fetchReportList();
        }
    } catch (e) {
        alert('创建报告失败: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '创建报告';
    }
}

async function fetchReportList() {
    try {
        const reports = await TaskAPI.fetchReportList();
        reportState.reportsList = reports;
        renderReportList(reports);
    } catch (e) {
        console.error('[Report] Error fetching report list:', e);
    }
}

function renderReportList(reports) {
    const container = document.getElementById('reports-list');
    if (!reports || reports.length === 0) {
        container.innerHTML = '<p style="color: #94a3b8;">暂无报告</p>';
        return;
    }
    container.innerHTML = reports.map(r => `
        <div class="report-card">
            <div class="report-card-info">
                <div class="report-card-title">${escapeHtml(r.title || '未命名报告')}</div>
                <div class="report-card-meta">
                    <span>${r.report_type === 'trace_only' ? '仅轨迹分析' : '轨迹与评分分析'}</span>
                    <span>创建者: ${escapeHtml(r.created_by || '未知')}</span>
                    <span>${formatDateTime(r.created_at)}</span>
                </div>
            </div>
            <div class="report-card-actions">
                <a class="btn btn-primary" href="/report.html?id=${r.id}" target="_blank" style="text-decoration: none;">查看</a>
                <button class="btn btn-danger" data-action="delete-report" data-id="${r.id}">删除</button>
            </div>
        </div>
    `).join('');
}

async function handleDeleteReport(id) {
    if (!confirm('确定要删除这份报告吗？')) return;
    try {
        await TaskAPI.deleteReport(id);
        UI.showToast('报告已删除');
        fetchReportList();
    } catch (e) {
        alert('删除失败: ' + e.message);
    }
}

