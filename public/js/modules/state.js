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
        stopped: 0
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

    // Per-model status filters: { modelName: 'completed' | 'stopped' | ... | '' }
    modelFilters: {},

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
            this.allModelNames = this.allModels.map(m => m.name).sort();
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
