/**
 * API interaction layer for Task Manager
 */

export function getAuthHeaders() {
    return {};
}

export const TaskAPI = {
    async fetchTasks({ page = 1, pageSize = 20, userId = '', search = '', modelFilters = {}, sourceType = '', turnsFilters = {} } = {}) {
        const params = new URLSearchParams();
        params.set('page', page);
        params.set('pageSize', pageSize);
        if (userId) params.set('userId', userId);
        if (search) params.set('search', search);
        if (sourceType) params.set('sourceType', sourceType);
        // Per-model status filters
        for (const [modelId, filterStatus] of Object.entries(modelFilters)) {
            if (filterStatus) params.set(`modelFilter_${modelId}`, filterStatus);
        }
        // Turns filters
        for (const [key, value] of Object.entries(turnsFilters)) {
            if (value !== '' && value != null) params.set(key, value);
        }
        const res = await fetch(`/api/admin/tasks?${params.toString()}`, { headers: getAuthHeaders() });
        return await res.json();
    },

    async fetchQueueStatus() {
        const res = await fetch('/api/admin/queue-status', { headers: getAuthHeaders() });
        return await res.json();
    },

    async fetchUsers() {
        const res = await fetch('/api/admin/users', { headers: getAuthHeaders() });
        return await res.json();
    },

    async updateConfig(config) {
        const res = await fetch('/api/admin/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify(config)
        });

        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '未知错误');
        }
        return await res.json();
    },

    async stopTask(taskId) {
        const res = await fetch(`/api/tasks/${taskId}/stop`, { method: 'POST', headers: getAuthHeaders() });
        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error || '未知错误');
        }
        return data;
    },

    async restartTask(taskId) {
        const res = await fetch(`/api/tasks/${taskId}/start`, { method: 'POST', headers: getAuthHeaders() });
        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error || '未知错误');
        }
        return data;
    },

    async deleteTask(taskId) {
        const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE', headers: getAuthHeaders() });
        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error || '未知错误');
        }
        return data;
    },

    async fetchQuestions() {
        const res = await fetch('/api/admin/questions', { headers: { 'Cache-Control': 'no-cache', ...getAuthHeaders() } });
        return await res.json();
    },

    async fetchModels() {
        const res = await fetch('/api/admin/models', { headers: getAuthHeaders() });
        return await res.json();
    },

    async updateModel(id, data) {
        const url = id ? `/api/admin/models/${id}` : '/api/admin/models';
        const method = id ? 'PUT' : 'POST';
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify(data)
        });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '未知错误');
        }
        return await res.json();
    },

    async deleteModel(id) {
        const res = await fetch(`/api/admin/models/${id}`, { method: 'DELETE', headers: getAuthHeaders() });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '未知错误');
        }
        return await res.json();
    },

    async updateModelGroupSetting(modelId, groupId, data) {
        const res = await fetch(`/api/admin/models/${modelId}/group-settings/${groupId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify(data)
        });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '未知错误');
        }
        return await res.json();
    },

    // Question APIs
    async saveQuestion(question) {
        const id = question.id;
        const payload = { ...question };
        delete payload.id; // API might not expect ID in body for create, or handle it

        const url = id ? `/api/admin/questions/${id}` : '/api/admin/questions';
        const method = id ? 'PUT' : 'POST';

        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify(payload)
        });
        return await res.json();
    },

    async updateQuestionStatus(id, isActive) {
        const res = await fetch(`/api/admin/questions/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ is_active: isActive })
        });
        if (!res.ok) throw new Error('Update failed');
        return await res.json();
    },

    async reorderQuestions(order) {
        const res = await fetch('/api/admin/questions/reorder', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ order })
        });
        return res.ok;
    },

    // Evaluation related APIs
    async fetchFeedbackStats() {
        const res = await fetch('/api/admin/feedback-stats', { headers: getAuthHeaders() });
        return await res.json();
    },

    async updateUserRole(userId, role) {
        const res = await fetch(`/api/admin/users/${userId}/role`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ role })
        });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '未知错误');
        }
        return await res.json();
    },

    // User Groups APIs
    async fetchUserGroups() {
        const res = await fetch('/api/admin/user-groups', { headers: getAuthHeaders() });
        return await res.json();
    },

    async createUserGroup(name) {
        const res = await fetch('/api/admin/user-groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ name })
        });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '未知错误');
        }
        return await res.json();
    },

    async updateUserGroup(id, name) {
        const res = await fetch(`/api/admin/user-groups/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ name })
        });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '未知错误');
        }
        return await res.json();
    },

    async deleteUserGroup(id) {
        const res = await fetch(`/api/admin/user-groups/${id}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '未知错误');
        }
        return await res.json();
    },

    async updateUserGroupAssignment(userId, groupId) {
        const res = await fetch(`/api/admin/users/${userId}/group`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ group_id: groupId })
        });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '未知错误');
        }
        return await res.json();
    },

    async createUsers(usernames) {
        const res = await fetch('/api/admin/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ usernames })
        });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '未知错误');
        }
        return await res.json();
    },

    async deleteUser(userId) {
        const res = await fetch(`/api/admin/users/${userId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '未知错误');
        }
        return await res.json();
    },

    async resetUserPassword(userId, password) {
        const res = await fetch(`/api/admin/users/${userId}/password`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ password })
        });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '未知错误');
        }
        return await res.json();
    },

    // Report APIs
    async fetchReportModels() {
        const res = await fetch('/api/admin/report/models', { headers: getAuthHeaders() });
        return await res.json();
    },

    async fetchReportQuestions() {
        const res = await fetch('/api/admin/report/questions', { headers: getAuthHeaders() });
        return await res.json();
    },

    async fetchAvailableTasks(reportType, modelIds) {
        const res = await fetch('/api/admin/report/available-tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ reportType, modelIds })
        });
        return await res.json();
    },

    async createReport(reportType, modelIds, taskIds, title, selectedQuestionIds, questionWeights) {
        const res = await fetch('/api/admin/report/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ reportType, modelIds, taskIds, title, selectedQuestionIds, questionWeights })
        });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '创建报告失败');
        }
        return await res.json();
    },

    async fetchReportList() {
        const res = await fetch('/api/admin/report/list', { headers: getAuthHeaders() });
        return await res.json();
    },

    async deleteReport(id) {
        const res = await fetch(`/api/admin/report/${id}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        return await res.json();
    },

    async fetchQCStats({ page = 1, pageSize = 50, userId = '', inspector = '', taskQuality = '', feedbackQuality = '', requirementType = '', traceCompleteness = '' } = {}) {
        const params = new URLSearchParams();
        params.set('page', page);
        params.set('pageSize', pageSize);
        if (userId) params.set('userId', userId);
        if (inspector) params.set('inspector', inspector);
        if (taskQuality) params.set('taskQuality', taskQuality);
        if (feedbackQuality) params.set('feedbackQuality', feedbackQuality);
        if (requirementType) params.set('requirementType', requirementType);
        if (traceCompleteness) params.set('traceCompleteness', traceCompleteness);
        const res = await fetch(`/api/admin/qc-stats?${params.toString()}`, { headers: getAuthHeaders() });
        return await res.json();
    },

    async startClsAll() {
        const res = await fetch('/api/admin/task-cls-start-all', {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }
        });
        return await res.json();
    },

    // ===== 题目分类 (per task) =====
    async fetchClsStats({ page = 1, pageSize = 50, status = 'pending' } = {}) {
        const params = new URLSearchParams();
        params.set('page', page);
        params.set('pageSize', pageSize);
        params.set('status', status);
        const res = await fetch(`/api/admin/task-cls-stats?${params.toString()}`, { headers: getAuthHeaders() });
        return await res.json();
    },

    async startCls(taskIds) {
        const res = await fetch('/api/admin/task-cls-start', {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskIds })
        });
        return await res.json();
    },

    async fetchClsProgress() {
        const res = await fetch('/api/admin/task-cls-progress', { headers: getAuthHeaders() });
        return await res.json();
    },

    async deleteCls(taskIds) {
        const res = await fetch('/api/admin/task-cls-delete', {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskIds })
        });
        return await res.json();
    },

    // ===== 反馈质检 (per model_run) =====
    async fetchTraceStats({ page = 1, pageSize = 50, status = 'pending' } = {}) {
        const params = new URLSearchParams();
        params.set('page', page);
        params.set('pageSize', pageSize);
        params.set('status', status);
        const res = await fetch(`/api/admin/trace-check-stats?${params.toString()}`, { headers: getAuthHeaders() });
        return await res.json();
    },

    async startTrace(items) {
        const res = await fetch('/api/admin/trace-check-start', {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ items })
        });
        return await res.json();
    },

    async startTraceAll() {
        const res = await fetch('/api/admin/trace-check-start-all', {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }
        });
        return await res.json();
    },

    async fetchTraceProgress() {
        const res = await fetch('/api/admin/trace-check-progress', { headers: getAuthHeaders() });
        return await res.json();
    },

    async deleteTrace(items) {
        const res = await fetch('/api/admin/trace-check-delete', {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ items })
        });
        return await res.json();
    },

    async updateQcConcurrency(concurrency) {
        const res = await fetch('/api/admin/config', {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ aiQcConcurrency: concurrency })
        });
        return await res.json();
    },

    async fetchCommentStats({ page = 1, pageSize = 50, taskOwner = '', commentType = 'all', commenterType = '' } = {}) {
        const params = new URLSearchParams();
        params.set('page', page);
        params.set('pageSize', pageSize);
        if (taskOwner) params.set('taskOwner', taskOwner);
        if (commentType && commentType !== 'all') params.set('commentType', commentType);
        if (commenterType) params.set('commenterType', commenterType);
        const res = await fetch(`/api/admin/comment-stats?${params.toString()}`, { headers: getAuthHeaders() });
        return await res.json();
    }
};
