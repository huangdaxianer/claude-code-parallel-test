/**
 * 应用主命名空间和共享状态
 * Main namespace and shared state management
 */
(function () {
    'use strict';

    window.App = window.App || {};

    // 共享状态
    App.state = {
        currentUser: null,
        currentTaskId: null,
        currentRuns: [],
        activeFolder: null,
        isStatsMode: false,
        isCompareMode: false,
        compareLeftRun: null,
        compareRightRun: null,
        activeMenuTaskId: null,
        batchPrompts: [],
        selectedFolderPath: '',
        incrementalSrcTaskId: null,
        incrementalSrcModelName: null,
        refreshIntervalId: null,
        activeTab: 'trajectory',
        feedbackQuestions: [],
        feedbackDebounceTimer: null,
        feedbackDebounceTimer: null,
        expandedPaths: new Set(),
        targetUser: null, // The user whose tasks we are viewing (if different from currentUser)
        modelDisplayNames: {}, // Cached model display names (name -> displayName mapping)
        selectedTrajectoryMember: null, // null = team-lead/主轨迹, string = 子agent名
        agentTeamMembers: [] // 缓存的团队成员列表
    };

    // DOM 元素引用
    App.elements = {};

    /**
     * 初始化 DOM 元素引用
     */
    App.initElements = function () {
        App.elements.modelListEl = document.getElementById('model-list');
        App.elements.logDisplayEl = document.getElementById('log-display');
        App.elements.fileListEl = document.getElementById('file-list');
        App.elements.previewModal = document.getElementById('preview-modal');
        App.elements.previewFilename = document.getElementById('preview-filename');
        App.elements.previewBody = document.getElementById('preview-body');
    };

    /**
     * 更新 URL 参数
     */
    App.updateUrl = function (taskId, modelParam, pageParam) {
        if (!App.state.currentUser) return;

        const url = new URL(window.location.href);

        // 始终保留 view_user 参数 (如果当前处于 viewing 模式)
        if (App.state.targetUser && App.state.targetUser.username !== App.state.currentUser.username) {
            url.searchParams.set('view_user', App.state.targetUser.username);
        } else {
            url.searchParams.delete('view_user');
        }

        // user 参数用于登录，通常不需要在应用内导航时重复添加，除非为了分享链接
        // 但如果仅仅是 viewing，不要添加 user 参数以免混淆
        // 如果需要保持“当前登录用户”的链接，可以添加 user=currentUser (可选)
        // 这里的逻辑原先是: targetUser ? targetUser.username : currentUser.username
        // 修改为: 移除 user 参数以避免重载时自动切换登录 (依靠 localStorage)
        url.searchParams.delete('user');

        if (taskId) {
            url.searchParams.set('task', taskId);
        } else {
            url.searchParams.delete('task');
        }

        if (modelParam) {
            let cleanModel = modelParam;
            if (modelParam.includes('/')) {
                const parts = modelParam.split('/');
                cleanModel = parts[parts.length - 1];
            }
            url.searchParams.set('model', cleanModel);
        } else {
            url.searchParams.delete('model');
        }

        if (pageParam) {
            url.searchParams.set('page', pageParam);
        } else {
            url.searchParams.delete('page');
        }

        window.history.pushState({ path: url.toString() }, '', url.toString());
    };


    /**
     * 加载任务
     */
    App.loadTask = function (id, pushState, initialModel, initialPage, skipFetchHistory) {
        if (pushState === undefined) pushState = true;
        initialModel = initialModel || null;

        if (pushState) {
            App.updateUrl(id, initialModel, initialPage);
        }

        App.state.currentTaskId = id;
        App.state.currentRuns = [];

        // 根据 initialModel 设置初始模式
        if (initialModel === 'stats' || !initialModel) {
            App.state.isStatsMode = true;
            App.state.isCompareMode = false;
            App.state.activeFolder = null;
        } else if (initialModel === 'compare') {
            App.state.isStatsMode = false;
            App.state.isCompareMode = true;
            App.state.activeFolder = null;
        } else {
            App.state.isStatsMode = false;
            App.state.isCompareMode = false;
            if (initialModel.includes('/')) {
                App.state.activeFolder = initialModel;
            } else {
                App.state.activeFolder = `${id}/${initialModel}`;
            }
        }

        // Set initial page/tab
        if (initialPage && ['trajectory', 'files', 'preview', 'subagent'].includes(initialPage)) {
            App.state.activeTab = initialPage;
        } else {
            App.state.activeTab = 'trajectory'; // Default
        }

        // 清除定时器
        if (App.state.refreshIntervalId) clearInterval(App.state.refreshIntervalId);

        // UI 重置 - 添加 null check 防止元素未准备好时报错
        const topBar = document.querySelector('.top-bar');
        const promptDisplay = document.getElementById('task-prompt-display');
        const statsTableBody = document.getElementById('stats-table-body');

        if (topBar) topBar.style.display = 'flex';
        if (App.elements.modelListEl) App.elements.modelListEl.innerHTML = '<div style="padding: 1rem;">正在加载...</div>';
        if (promptDisplay) promptDisplay.textContent = '正在加载...';
        if (App.elements.logDisplayEl) App.elements.logDisplayEl.innerHTML = '';
        if (statsTableBody) statsTableBody.innerHTML = '';

        // 重新获取数据
        App.fetchTaskDetails();
        if (!skipFetchHistory) {
            App.fetchTaskHistory();
        }
        App.comments.loadComments();

        // 重启定时器
        App.state.refreshIntervalId = setInterval(App.fetchTaskDetails, 3000);
    };

    /**
     * 加载并缓存模型显示名称
     */
    App.loadModelDisplayNames = async function () {
        try {
            console.log('[App] Loading model display names for user:', App.state.currentUser?.username);
            const models = await App.api.getEnabledModels();

            // Check if API returned an error
            if (models.error) {
                console.error('[App] Error from API:', models.error);
                return;
            }

            App.state.modelDisplayNames = {};
            models.forEach(model => {
                App.state.modelDisplayNames[model.name] = model.displayName || model.name;
            });
            console.log('[App] Model display names loaded:', App.state.modelDisplayNames);
        } catch (e) {
            console.error('[App] Failed to load model display names:', e);
        }
    };

    /**
     * 应用初始化入口
     */
    App.init = async function () {
        // 先执行登录检查（auth.js 中已检查，但这里确保已完成）
        // Wait up to 2 seconds for auth to complete
        let retries = 0;
        while (!App.state.currentUser && retries < 20) {
            await new Promise(resolve => setTimeout(resolve, 100));
            retries++;
        }

        if (!App.state.currentUser) {
            console.error('[App] No user logged in after auth check');
            return;
        }

        App.initElements();

        // 获取 URL 参数
        const urlParams = new URLSearchParams(window.location.search);
        const taskId = urlParams.get('task');
        const model = urlParams.get('model');
        const page = urlParams.get('page');
        const viewUserParam = urlParams.get('view_user');
        const userParam = urlParams.get('user');

        const targetUserParam = viewUserParam || userParam;
        const shouldCheckView = viewUserParam || (userParam && userParam !== App.state.currentUser.username);

        // 如果 URL 中有任务 ID，先设置到状态中，防止 fetchTaskHistory 自动加载第一个任务
        if (taskId) {
            App.state.currentTaskId = taskId;
        }

        // ====== Phase 1: 并行加载模型名 + 验证目标用户 (互不依赖) ======
        const resolveTargetUser = async () => {
            if (!shouldCheckView) return;
            try {
                const targetUser = await App.api.verifyUser(targetUserParam);
                if (targetUser) {
                    if (App.state.currentUser.role === 'admin') {
                        App.state.targetUser = targetUser;
                        console.log(`[App] Admin viewing as user: ${targetUser.username} (${targetUser.id})`);

                        const dropdownMenu = document.getElementById('user-dropdown-menu');
                        if (dropdownMenu) {
                            const infoId = 'viewing-user-info';
                            if (!document.getElementById(infoId)) {
                                const infoDiv = document.createElement('div');
                                infoDiv.id = infoId;
                                infoDiv.className = 'user-dropdown-item';
                                infoDiv.style.cssText = 'padding: 0.5rem 1rem; color: #64748b; font-size: 0.85rem; border-bottom: 1px solid #e2e8f0; background: #f8fafc; cursor: default;';
                                infoDiv.innerHTML = `当前展示：<span style="font-weight:600; color:#334155;">${targetUser.username}</span>`;

                                const firstChild = dropdownMenu.firstElementChild;
                                if (firstChild) {
                                    firstChild.after(infoDiv);
                                } else {
                                    dropdownMenu.prepend(infoDiv);
                                }
                            }
                        }
                    } else if (targetUser.username !== App.state.currentUser.username) {
                        alert('您无法访问该任务');
                        window.location.href = '/task.html';
                        return;
                    }
                } else {
                    App.toast.show(`用户 ${targetUserParam} 不存在`);
                }
            } catch (e) {
                console.error('[App] Failed to verify target user:', e);
            }
        };

        await Promise.all([
            App.loadModelDisplayNames(),
            resolveTargetUser()
        ]);

        // 显示用户名
        const usernameDisplay = document.getElementById('username-display');
        if (usernameDisplay && App.state.currentUser) {
            usernameDisplay.textContent = App.state.currentUser.username;
        }

        // Admin Panel Link
        if (App.state.currentUser && App.state.currentUser.role === 'admin') {
            const dropdownMenu = document.getElementById('user-dropdown-menu');
            if (dropdownMenu && !document.getElementById('admin-panel-link')) {
                const adminLink = document.createElement('a');
                adminLink.id = 'admin-panel-link';
                adminLink.href = '/task_manager.html';
                adminLink.target = '_blank';
                adminLink.className = 'user-dropdown-item';
                adminLink.style.display = 'block';
                adminLink.style.padding = '0.5rem 1rem';
                adminLink.style.textDecoration = 'none';
                adminLink.style.color = '#334155';
                adminLink.style.fontSize = '0.9rem';
                adminLink.style.borderBottom = '1px solid #e2e8f0';
                adminLink.onmouseover = () => { adminLink.style.backgroundColor = '#f1f5f9'; };
                adminLink.onmouseout = () => { adminLink.style.backgroundColor = 'transparent'; };

                adminLink.innerHTML = '<span>⚙️</span> 管理后台';

                const logoutBtn = dropdownMenu.querySelector('.user-dropdown-logout');
                if (logoutBtn) {
                    dropdownMenu.insertBefore(adminLink, logoutBtn);
                } else {
                    dropdownMenu.appendChild(adminLink);
                }
            }
        }

        // ====== Phase 2: 并行加载任务历史 + 验证任务 (targetUser 已就绪) ======
        const userId = App.state.targetUser ? App.state.targetUser.id : App.state.currentUser.id;
        const [_, taskValidation] = await Promise.all([
            App.fetchTaskHistory(),
            taskId ? App.api.verifyTask(taskId, userId) : Promise.resolve(null)
        ]);

        // ====== Phase 3: 加载任务详情 (不重复请求历史) ======
        if (taskId && taskValidation) {
            if (!taskValidation.exists) {
                App.toast.show('任务不存在或无权访问');
                App.state.currentTaskId = null;
                App.updateUrl(null, null, null);
            } else {
                App.loadTask(taskId, false, model, page, true);
            }
        }

        // 侧边栏折叠
        document.getElementById('sidebar-toggle').addEventListener('click', () => {
            document.getElementById('app-layout').classList.toggle('collapsed');
        });

        // 新建任务模态框
        document.getElementById('new-task-btn').addEventListener('click', App.modal.openNewTaskModal);
        document.getElementById('add-task-btn').addEventListener('click', App.modal.startNewTask);
        document.getElementById('folder-input').addEventListener('change', App.modal.handleFolderUpload);
        document.getElementById('zip-input').addEventListener('change', App.modal.handleZipUpload);

        // Cancel upload on click during uploading state
        document.querySelector('.cancel-upload-text').addEventListener('click', (e) => {
            e.stopPropagation();
            App.modal.cancelUpload();
        });

        // Delete uploaded file on click
        document.querySelector('.delete-text').addEventListener('click', (e) => {
            e.stopPropagation();
            App.modal.clearUploadedFile();
        });

        // Dropdown options
        document.getElementById('trigger-zip-upload').addEventListener('click', (e) => {
            e.stopPropagation();
            App.modal.triggerZipBrowse();
        });
        document.getElementById('trigger-folder-upload').addEventListener('click', (e) => {
            e.stopPropagation();
            App.modal.triggerFolderBrowse();
        });

        document.getElementById('csv-file-input').addEventListener('change', App.modal.handleCsvUpload);
        document.getElementById('browse-csv-btn').addEventListener('click', App.modal.triggerCsvBrowse);
        document.getElementById('clear-batch-btn').addEventListener('click', App.modal.clearBatchTasks);

        // prompt 输入监听
        document.getElementById('task-prompt').addEventListener('input', App.modal.updateStartButtonStyle);

        // 关闭预览模态框
        App.elements.previewModal.addEventListener('click', (e) => {
            if (e.target === App.elements.previewModal) App.preview.closePreview();
        });

        // ESC 关闭模态框
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                App.preview.closePreview();
                App.modal.closeNewTaskModal();
            }
        });

        // 点击外部关闭下拉菜单
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('item-dropdown-menu');
            const isMenuBtn = e.target.closest('.item-menu-btn');
            if (!isMenuBtn) {
                menu.classList.remove('show');
                App.state.activeMenuTaskId = null;
            }
        });

        // 删除菜单项
        document.getElementById('delete-task-menu-item').addEventListener('click', () => {
            if (App.state.activeMenuTaskId) {
                App.deleteTask(App.state.activeMenuTaskId);
            }
        });

        // 下载菜单项
        document.getElementById('download-task-menu-item').addEventListener('click', () => {
            if (App.state.activeMenuTaskId) {
                window.location.href = `/api/tasks/${App.state.activeMenuTaskId}/download`;
            }
        });

        // 浏览器前进后退
        window.addEventListener('popstate', (event) => {
            const params = new URLSearchParams(window.location.search);
            const id = params.get('task');
            const model = params.get('model');
            const page = params.get('page');
            if (id) {
                App.loadTask(id, false, model, page);
            } else {
                App.state.currentTaskId = null;
            }
        });

        // 初始化评论模块
        if (App.comments && App.comments.init) {
            App.comments.init();
        }

        // 显示 GSB 入口按钮（仅 internal 角色）
        const gsbBtn = document.getElementById('gsb-entry-btn');
        if (gsbBtn && App.state.currentUser?.role === 'internal') {
            gsbBtn.style.display = 'flex';
        }

    };

})();
