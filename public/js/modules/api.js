/**
 * API interaction layer for Task Manager
 */

export const TaskAPI = {
    async fetchTasks() {
        const res = await fetch('/api/admin/tasks');
        return await res.json();
    },

    async fetchQueueStatus() {
        const res = await fetch('/api/admin/queue-status');
        return await res.json();
    },

    async fetchUsers() {
        const res = await fetch('/api/admin/users');
        return await res.json();
    },

    async updateConfig(config) {
        const res = await fetch('/api/admin/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });

        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '未知错误');
        }
        return await res.json();
    },

    async stopTask(taskId) {
        const res = await fetch(`/api/tasks/${taskId}/stop`, { method: 'POST' });
        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error || '未知错误');
        }
        return data;
    },

    async restartTask(taskId) {
        const res = await fetch(`/api/tasks/${taskId}/start`, { method: 'POST' });
        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error || '未知错误');
        }
        return data;
    },

    async deleteTask(taskId) {
        const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error || '未知错误');
        }
        return data;
    },

    async fetchQuestions() {
        const res = await fetch('/api/admin/questions', { headers: { 'Cache-Control': 'no-cache' } });
        return await res.json();
    },

    async fetchModels() {
        const res = await fetch('/api/admin/models');
        return await res.json();
    },

    async updateModel(id, data) {
        const url = id ? `/api/admin/models/${id}` : '/api/admin/models';
        const method = id ? 'PUT' : 'POST';
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '未知错误');
        }
        return await res.json();
    },

    async deleteModel(id) {
        const res = await fetch(`/api/admin/models/${id}`, { method: 'DELETE' });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '未知错误');
        }
        return await res.json();
    },

    async updateModelGroupSetting(modelId, groupId, data) {
        const res = await fetch(`/api/admin/models/${modelId}/group-settings/${groupId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return await res.json();
    },

    async updateQuestionStatus(id, isActive) {
        const res = await fetch(`/api/admin/questions/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: isActive })
        });
        if (!res.ok) throw new Error('Update failed');
        return await res.json();
    },

    async reorderQuestions(order) {
        const res = await fetch('/api/admin/questions/reorder', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order })
        });
        return res.ok;
    },

    // Evaluation related APIs
    async fetchFeedbackStats() {
        const res = await fetch('/api/admin/feedback-stats');
        return await res.json();
    },

    async updateUserRole(userId, role) {
        const res = await fetch(`/api/admin/users/${userId}/role`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
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
        const res = await fetch('/api/admin/user-groups');
        return await res.json();
    },

    async createUserGroup(name) {
        const res = await fetch('/api/admin/user-groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
            headers: { 'Content-Type': 'application/json' },
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
            method: 'DELETE'
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
            headers: { 'Content-Type': 'application/json' },
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
            headers: { 'Content-Type': 'application/json' },
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
            method: 'DELETE'
        });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || '未知错误');
        }
        return await res.json();
    }
};
