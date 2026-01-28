/**
 * API 调用封装模块
 * API call wrappers
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.api = {};

    /**
     * 获取认证头
     */
    App.api.getAuthHeaders = function () {
        const username = App.state.currentUser?.username;
        if (username) {
            return { 'x-username': username };
        }
        return {};
    };

    /**
     * 获取任务列表
     */
    App.api.getTasks = async function (userId) {
        const url = userId ? `/api/tasks?userId=${userId}` : '/api/tasks';
        const res = await fetch(url);
        return res.json();
    };

    /**
     * 获取任务详情
     */
    App.api.getTaskDetails = async function (taskId) {
        const res = await fetch(`/api/task_details/${taskId}`);
        return res.json();
    };

    /**
     * 创建任务
     */
    App.api.createTask = async function (task) {
        const res = await fetch('/api/tasks', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...App.api.getAuthHeaders()
            },
            body: JSON.stringify({ task })
        });
        return res.json();
    };

    /**
     * 删除任务
     */
    App.api.deleteTask = async function (taskId) {
        const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
        return res.json();
    };

    /**
     * 控制任务 (启动/停止)
     */
    App.api.controlTask = async function (taskId, action, modelName) {
        const res = await fetch(`/api/tasks/${taskId}/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelName })
        });
        return res.json();
    };

    /**
     * 获取任务事件
     */
    App.api.getTaskEvents = async function (runId) {
        const res = await fetch(`/api/task_events/${runId}`);
        return res.json();
    };

    /**
     * 获取日志事件内容
     */
    App.api.getLogEventContent = async function (eventId) {
        const res = await fetch(`/api/log_event_content/${eventId}`);
        return res.json();
    };

    /**
     * 切换日志标记状态
     */
    App.api.toggleLogFlag = async function (eventId, isFlagged) {
        const res = await fetch(`/api/log_entries/${eventId}/flag`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isFlagged })
        });
        return res.json();
    };

    /**
     * 获取文件内容
     */
    App.api.getFileContent = async function (folder, file) {
        const res = await fetch(`/api/file_content?folder=${encodeURIComponent(folder)}&file=${encodeURIComponent(file)}`);
        return res.json();
    };

    /**
     * 获取反馈问题
     */
    App.api.getFeedbackQuestions = async function () {
        const res = await fetch('/api/feedback/questions', {
            headers: App.api.getAuthHeaders()
        });
        return res.json();
    };

    /**
     * 检查反馈
     */
    App.api.checkFeedback = async function (taskId, modelName) {
        const res = await fetch(`/api/feedback/check?taskId=${taskId}&modelName=${encodeURIComponent(modelName)}`, {
            headers: App.api.getAuthHeaders()
        });
        return res.json();
    };

    /**
     * 提交反馈
     */
    App.api.submitFeedback = async function (taskId, modelName, responses) {
        const res = await fetch('/api/feedback/submit', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...App.api.getAuthHeaders()
            },
            body: JSON.stringify({ taskId, modelName, responses })
        });
        return res.json();
    };

    /**
     * 启动预览
     */
    App.api.startPreview = async function (taskId, modelName) {
        const res = await fetch('/api/preview/start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...App.api.getAuthHeaders()
            },
            body: JSON.stringify({ taskId, modelName })
        });
        return res.json();
    };

    /**
     * 获取预览状态
     */
    App.api.getPreviewStatus = async function (taskId, modelName) {
        const res = await fetch(`/api/preview/status/${taskId}/${modelName}`, {
            headers: App.api.getAuthHeaders()
        });
        return res.json();
    };

    /**
     * 停止预览
     */
    App.api.stopPreview = async function (taskId, modelName) {
        const res = await fetch('/api/preview/stop', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...App.api.getAuthHeaders()
            },
            body: JSON.stringify({ taskId, modelName })
        });
        return res.json();
    };

    /**
     * 验证用户是否存在
     */
    App.api.verifyUser = async function (username) {
        const res = await fetch(`/api/users/verify?username=${encodeURIComponent(username)}`);
        const data = await res.json();
        return data.exists ? data.user : null;
    };

    /**
     * 验证任务是否存在且属于用户
     */
    App.api.verifyTask = async function (taskId, userId) {
        const res = await fetch(`/api/tasks/verify?taskId=${encodeURIComponent(taskId)}&userId=${userId}`);
        const data = await res.json();
        return data;
    };

    /**
     * 获取当前启用的模型
     */
    App.api.getEnabledModels = async function () {
        const res = await fetch('/api/admin/models/enabled', {
            headers: App.api.getAuthHeaders()
        });
        return res.json();
    };

    /**
     * Get comments
     */
    App.api.getComments = async function (taskId, modelName) {
        const res = await fetch(`/api/comments?taskId=${taskId}&modelName=${encodeURIComponent(modelName)}`);
        if (!res.ok) throw new Error('Failed to fetch comments');
        return await res.json();
    };

    /**
     * Add comment
     */
    App.api.addComment = async function (data) {
        const res = await fetch('/api/comments', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...App.api.getAuthHeaders()
            },
            body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error('Failed to add comment');
        return await res.json();
    };

    /**
     * Delete comment
     */
    App.api.deleteComment = async function (id) {
        const res = await fetch(`/api/comments/${id}`, {
            method: 'DELETE'
        });
        if (!res.ok) throw new Error('Failed to delete comment');
        return await res.json();
    };

    /**
     * Get user feedback (non-selection based feedback)
     */
    App.api.getUserFeedback = async function (taskId) {
        const res = await fetch(`/api/comments/user-feedback?taskId=${taskId}`);
        if (!res.ok) throw new Error('Failed to fetch user feedback');
        return await res.json();
    };

    /**
     * Add user feedback with optional images
     */
    App.api.addUserFeedback = async function (data) {
        const formData = new FormData();
        formData.append('taskId', data.taskId);
        formData.append('modelName', data.modelName || '');
        if (data.userId) formData.append('userId', data.userId);
        formData.append('content', data.content);
        
        // Append images if any
        if (data.images && data.images.length > 0) {
            for (const file of data.images) {
                formData.append('images', file);
            }
        }

        const res = await fetch('/api/comments/user-feedback', {
            method: 'POST',
            headers: App.api.getAuthHeaders(),
            body: formData
        });
        if (!res.ok) throw new Error('Failed to add user feedback');
        return await res.json();
    };

    /**
     * Delete user feedback
     */
    App.api.deleteUserFeedback = async function (id) {
        const res = await fetch(`/api/comments/user-feedback/${id}`, {
            method: 'DELETE'
        });
        if (!res.ok) throw new Error('Failed to delete user feedback');
        return await res.json();
    };

})();
