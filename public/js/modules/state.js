/**
 * State management for Task Manager
 */

export const AppState = {
    // Data
    allTasks: [],
    filteredTasks: [],
    selectedTasks: new Set(),
    allModelNames: [],

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

    // Feedback Stats
    feedbackStatsData: [],
    activeQuestions: [], // For feedback table headers

    // Track previous model names to avoid unnecessary header rebuilds
    prevModelNamesKey: '',

    // Methods to mutate state

    setTasks(tasks) {
        this.allTasks = tasks;
        this.extractAllModelNames();
    },

    extractAllModelNames() {
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
