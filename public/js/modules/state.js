/**
 * State management for Task Manager
 */

export const AppState = {
    // Data
    allTasks: [],
    filteredTasks: [],
    selectedTasks: new Set(),
    allModelNames: [],

    // Pagination
    pagination: {
        page: 1,
        pageSize: 20,
        total: 0,
        totalPages: 0
    },

    // Server-side stats
    serverStats: {
        total: 0,
        completed: 0,
        running: 0,
        pending: 0,
        stopped: 0,
        feedbacked: 0
    },

    // Status
    queueStatus: {
        maxParallelSubtasks: 5,
        runningSubtasks: 0,
        pendingSubtasks: 0
    },

    // Auxiliary Data
    users: [], // For filter

    // Question Management
    allQuestions: [],

    // Model Management
    allModels: [],

    // User Management
    managementUsers: [],
    userGroups: [],

    // Feedback Stats
    feedbackStatsData: [],
    activeQuestions: [], // For feedback table headers

    // Comment Stats (评价统计)
    commentStatsData: [],
    commentStatsPagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 },
    commentStatsTaskOwners: [],

    // QC Stats (质检管理 - 人工质检)
    qcStatsData: [],
    qcStatsPagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 },
    qcStatsStatus: 'pending',

    // 质检管理 - 分组和子标签
    qcGroup: 'human',                // 当前激活的分组：human | cls | trace
    qcSubTab: 'human-pending',       // 当前激活的子标签

    // 题目分类（per task）
    clsData: [],
    clsPagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 },

    // 反馈质检（per model_run）
    traceData: [],
    tracePagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 },

    // Per-model status filters: { modelId: 'completed' | 'stopped' | ... | '' }
    modelFilters: {},

    // User filter: userId string or ''
    userFilter: '',

    // Source type filter: 'prompt' | 'upload' | ''
    sourceTypeFilter: '',

    // Turns filters: { minTurnsGte, minTurnsLte, maxTurnsGte, maxTurnsLte }
    turnsFilters: {},

    // Track previous model names to avoid unnecessary header rebuilds
    prevModelNamesKey: '',

    // Methods to mutate state

    setTasks(tasks) {
        this.allTasks = tasks;
        this.filteredTasks = tasks;
        this.extractAllModelNames();
    },

    setPagination({ total, page, pageSize, totalPages }) {
        this.pagination = { total, page, pageSize, totalPages };
    },

    setServerStats(stats) {
        if (stats) {
            this.serverStats = stats;
        }
    },

    extractAllModelNames() {
        // Prefer model names from allModels config (complete list) over task runs (current page only)
        if (this.allModels && this.allModels.length > 0) {
            // Only show models enabled for the current admin's user group
            const userGroupId = this.currentUser?.group_id;
            let models = this.allModels;
            if (userGroupId) {
                models = this.allModels.filter(m => {
                    const gs = (m.group_settings || []).find(g => g.group_id === userGroupId);
                    return gs ? gs.is_enabled === 1 : true;
                });
            }
            this.allModelNames = models.map(m => m.name).sort();
            return;
        }
        const modelSet = new Set();
        this.allTasks.forEach(task => {
            (task.runs || []).forEach(run => {
                if (run.modelName) {
                    modelSet.add(run.modelName);
                }
            });
        });
        this.allModelNames = Array.from(modelSet).sort();
    },

    toggleTaskSelection(taskId) {
        if (this.selectedTasks.has(taskId)) {
            this.selectedTasks.delete(taskId);
        } else {
            this.selectedTasks.add(taskId);
        }
    },

    selectAll(taskIds) {
        taskIds.forEach(id => this.selectedTasks.add(id));
    },

    clearSelection() {
        this.selectedTasks.clear();
    },

    updateQueueStatus(status) {
        this.queueStatus = status;
    }
};
