/**
 * 子Agent状态面板模块
 * Sub-Agent status panel rendering with team members, task board, and message flow
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.subAgent = {};

    let pollTimer = null;
    let lastDataHash = null;

    // 颜色映射
    const COLOR_MAP = {
        'blue': '#3b82f6',
        'red': '#ef4444',
        'green': '#22c55e',
        'yellow': '#eab308',
        'purple': '#a855f7',
        'orange': '#f97316',
        'pink': '#ec4899',
        'cyan': '#06b6d4',
        'indigo': '#6366f1',
        'teal': '#14b8a6'
    };

    const DEFAULT_COLORS = ['#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316', '#ec4899', '#06b6d4', '#6366f1', '#14b8a6', '#ef4444'];

    /**
     * 渲染子Agent面板（入口）
     */
    App.subAgent.render = function () {
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
        const modelId = App.state.activeFolder;
        if (!taskId || !modelId) return;

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
            const hash = JSON.stringify(data);
            if (hash !== lastDataHash) {
                lastDataHash = hash;
                renderPanel(data);
            }
        } catch (e) {
            console.error('[SubAgent] Fetch error:', e);
        }
    }

    function startPolling() {
        App.subAgent.stop();
        pollTimer = setInterval(() => {
            if (App.state.activeTab !== 'subagent') return;
            // 检查任务是否还在运行
            const runs = App.state.currentRuns || [];
            const activeRun = runs.find(r => r.folderName === App.state.activeFolder);
            if (activeRun && activeRun.status === 'running') {
                fetchAgentData();
            }
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

        // 团队成员区块
        html += renderMembers(data.members, data.teamName);

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

    function renderMembers(members, teamName) {
        if (!members || members.length === 0) return '';

        let html = '<div class="sa-section">';
        html += '<div class="sa-section-header">';
        html += '<span>团队成员</span>';
        html += `<span style="font-size:0.8rem; color:#94a3b8; font-weight:400;">${escapeHtml(teamName || '')}</span>`;
        html += '</div>';
        html += '<div class="sa-members-grid">';

        members.forEach((member, idx) => {
            const color = COLOR_MAP[member.color] || DEFAULT_COLORS[idx % DEFAULT_COLORS.length];
            const displayType = member.agentType || 'agent';
            const model = member.model || '';
            const modelShort = model.replace(/^claude-/, '').replace(/^anthropic\/claude-/, '');

            html += `<div class="sa-member-card" title="${escapeHtml(member.prompt || '')}">`;
            html += `<div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">`;
            html += `<span class="sa-member-color" style="background:${color};"></span>`;
            html += `<span class="sa-member-name">${escapeHtml(member.name)}</span>`;
            html += `</div>`;
            html += `<div class="sa-member-type">${escapeHtml(displayType)}</div>`;
            if (modelShort) {
                html += `<div class="sa-member-model">${escapeHtml(modelShort)}</div>`;
            }
            html += '</div>';
        });

        html += '</div></div>';
        return html;
    }

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
        pending.forEach(t => {
            html += renderTaskCard(t);
        });
        html += '</div>';

        // In Progress column
        html += '<div class="sa-task-column">';
        html += `<div class="sa-task-column-title sa-col-progress">进行中 (${inProgress.length})</div>`;
        inProgress.forEach(t => {
            html += renderTaskCard(t);
        });
        html += '</div>';

        // Completed column
        html += '<div class="sa-task-column">';
        html += `<div class="sa-task-column-title sa-col-done">已完成 (${completed.length})</div>`;
        completed.forEach(t => {
            html += renderTaskCard(t);
        });
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
        // Try to parse JSON text for display
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
