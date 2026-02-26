/**
 * 子Agent状态面板模块
 * Sub-Agent status panel rendering with team members, task board, and message flow
 * 轨迹展示已迁移到执行轨迹 Tab (mainContent.js)
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.subAgent = {};

    let pollTimer = null;
    let lastDataHash = null;
    let currentModelId = null;   // 追踪当前模型，仅在切换模型时重置状态

    /**
     * 渲染子Agent面板（入口）
     * 仅在模型切换时重置状态
     */
    App.subAgent.render = function () {
        const folder = App.state.activeFolder;
        const modelId = folder && folder.includes('/') ? folder.split('/').pop() : folder;

        // 仅在模型切换时重置缓存状态
        if (modelId !== currentModelId) {
            currentModelId = modelId;
            lastDataHash = null;
        }

        fetchAgentData();
        startPolling();
    };

    /**
     * 停止轮询
     */
    App.subAgent.stop = function () {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    };

    /**
     * 获取子Agent数据
     */
    async function fetchAgentData() {
        const taskId = App.state.currentTaskId;
        const folder = App.state.activeFolder;
        if (!taskId || !folder) return;
        const modelId = folder.includes('/') ? folder.split('/').pop() : folder;

        try {
            const resp = await fetch(`/api/tasks/${taskId}/models/${modelId}/agents`, {
                headers: App.api.getAuthHeaders()
            });
            if (!resp.ok) {
                if (resp.status === 404) {
                    renderEmpty('暂无子Agent数据');
                }
                return;
            }
            const data = await resp.json();

            // 同步成员列表到共享状态（用于执行轨迹 Tab 的成员选择器）
            App.state.agentTeamMembers = data.members || [];

            const hash = JSON.stringify(data);
            if (hash !== lastDataHash) {
                lastDataHash = hash;
                // 仅在子Agent tab 激活时渲染面板
                if (App.state.activeTab === 'subagent') {
                    renderPanel(data);
                }
            }
        } catch (e) {
            console.error('[SubAgent] Fetch error:', e);
        }
    }

    function startPolling() {
        App.subAgent.stop();
        pollTimer = setInterval(() => {
            // 在 subagent tab 或 trajectory tab（有 agent teams）时轮询
            const shouldPoll = App.state.activeTab === 'subagent' ||
                (App.state.activeTab === 'trajectory' && App.state._hasAgentTeams);
            if (!shouldPoll) return;
            fetchAgentData();
        }, 5000);
    }

    function renderEmpty(msg) {
        const container = document.getElementById('subagent-container');
        if (!container) return;
        container.innerHTML = `<div class="empty-state"><p style="margin-top: 1rem; font-size: 0.9rem;">${escapeHtml(msg)}</p></div>`;
    }

    function renderPanel(data) {
        const container = document.getElementById('subagent-container');
        if (!container) return;

        let html = '';

        // 团队成员区块（点击跳转到执行轨迹 Tab 查看轨迹）
        html += renderMembers(data.members);

        // 任务看板区块
        if (data.tasks && data.tasks.length > 0) {
            html += renderTaskBoard(data.tasks);
        }

        // 消息流区块
        if (data.messages && data.messages.length > 0) {
            html += renderMessages(data.messages);
        }

        container.innerHTML = html;
    }

    function renderMembers(members) {
        if (!members || members.length === 0) return '';

        let html = '<div class="sa-section">';
        html += '<div class="sa-section-header">';
        html += '<span>团队成员</span>';
        html += '</div>';
        html += '<div class="sa-members-grid">';

        members.forEach(function (member) {
            const safeName = member.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

            html += `<div class="sa-member-card" `;
            html += `data-member="${escapeHtml(member.name)}" `;
            html += `onclick="App.subAgent.viewMemberTrajectory('${safeName}')" `;
            html += `title="点击查看执行轨迹" style="cursor:pointer;">`;
            html += `<span class="sa-member-name">${escapeHtml(member.name)}</span>`;
            html += '</div>';
        });

        html += '</div></div>';
        return html;
    }

    /**
     * 点击成员卡片 → 切换到执行轨迹 Tab 并选中该成员
     */
    App.subAgent.viewMemberTrajectory = function (memberName) {
        App.state.selectedTrajectoryMember = memberName;
        // 重置成员选择器hash以强制刷新
        if (App.main && App.main.renderMemberSelector) {
            // 清除log display状态
            if (App.elements && App.elements.logDisplayEl) {
                App.elements.logDisplayEl.dataset.lineCount = '0';
                App.elements.logDisplayEl.dataset.saMember = '';
                App.elements.logDisplayEl.dataset.saLineCount = '0';
                App.elements.logDisplayEl.innerHTML = '';
            }
        }
        App.main.switchTab('trajectory');
    };

    function renderTaskBoard(tasks) {
        const pending = tasks.filter(t => t.status === 'pending');
        const inProgress = tasks.filter(t => t.status === 'in_progress');
        const completed = tasks.filter(t => t.status === 'completed');

        let html = '<div class="sa-section">';
        html += '<div class="sa-section-header"><span>任务看板</span></div>';
        html += '<div class="sa-task-board">';

        // Pending column
        html += '<div class="sa-task-column">';
        html += `<div class="sa-task-column-title sa-col-pending">待处理 (${pending.length})</div>`;
        pending.forEach(t => { html += renderTaskCard(t); });
        html += '</div>';

        // In Progress column
        html += '<div class="sa-task-column">';
        html += `<div class="sa-task-column-title sa-col-progress">进行中 (${inProgress.length})</div>`;
        inProgress.forEach(t => { html += renderTaskCard(t); });
        html += '</div>';

        // Completed column
        html += '<div class="sa-task-column">';
        html += `<div class="sa-task-column-title sa-col-done">已完成 (${completed.length})</div>`;
        completed.forEach(t => { html += renderTaskCard(t); });
        html += '</div>';

        html += '</div></div>';
        return html;
    }

    function renderTaskCard(task) {
        const desc = task.description || '';
        const shortDesc = desc.length > 60 ? desc.slice(0, 60) + '...' : desc;
        return `<div class="sa-task-card" title="${escapeHtml(desc)}">
            <div style="font-weight:600;">#${escapeHtml(task.id)} ${escapeHtml(task.owner)}</div>
            <div style="color:#64748b; font-size:0.75rem; margin-top:2px;">${escapeHtml(shortDesc)}</div>
        </div>`;
    }

    function renderMessages(messages) {
        // 过滤系统消息
        const filtered = messages.filter(m => !m.isSystem);
        if (filtered.length === 0) return '';

        let html = '<div class="sa-section">';
        html += '<div class="sa-section-header"><span>消息流</span>';
        html += `<span style="font-size:0.75rem; color:#94a3b8; font-weight:400;">${filtered.length} 条消息</span>`;
        html += '</div>';
        html += '<div class="sa-messages">';

        filtered.forEach(msg => {
            const time = formatTime(msg.timestamp);
            const to = msg.to || '?';
            const summary = msg.summary || truncateText(msg.text, 80);

            html += '<div class="sa-msg-item">';
            html += `<span class="sa-msg-time">${escapeHtml(time)}</span>`;
            html += `<span class="sa-msg-route">${escapeHtml(msg.from)} &rarr; ${escapeHtml(to)}</span>`;
            html += `<span class="sa-msg-content">${escapeHtml(summary)}</span>`;
            html += '</div>';
        });

        html += '</div></div>';
        return html;
    }

    // ---- Utility functions ----

    function formatTime(timestamp) {
        if (!timestamp) return '';
        try {
            const d = new Date(timestamp);
            const h = String(d.getHours()).padStart(2, '0');
            const m = String(d.getMinutes()).padStart(2, '0');
            const s = String(d.getSeconds()).padStart(2, '0');
            return `${h}:${m}:${s}`;
        } catch (e) {
            return '';
        }
    }

    function truncateText(text, maxLen) {
        if (!text) return '';
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object') {
                text = parsed.content || parsed.text || JSON.stringify(parsed);
            }
        } catch (e) { /* not JSON */ }
        return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
    }

    function escapeHtml(str) {
        if (!str) return '';
        if (App.utils && App.utils.escapeHtml) return App.utils.escapeHtml(str);
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

})();
