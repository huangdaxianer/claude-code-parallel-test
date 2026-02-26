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
    let trajectoryData = null;
    let selectedMember = null;
    let currentModelId = null;   // 追踪当前模型，仅在切换模型时重置状态
    let isFetching = false;      // 防止并发请求
    let lastTrajectoryHash = null; // 轨迹去重

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
     * 仅在模型切换时重置状态，避免重新进入 tab 时丢失选中状态
     */
    App.subAgent.render = function () {
        const folder = App.state.activeFolder;
        const modelId = folder && folder.includes('/') ? folder.split('/').pop() : folder;

        // 仅在模型切换时重置缓存状态
        if (modelId !== currentModelId) {
            currentModelId = modelId;
            lastDataHash = null;
            trajectoryData = null;
            selectedMember = null;
            lastTrajectoryHash = null;
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
     * 获取子Agent数据（含轨迹刷新）
     */
    async function fetchAgentData() {
        if (isFetching) return;
        isFetching = true;

        const taskId = App.state.currentTaskId;
        const folder = App.state.activeFolder;
        if (!taskId || !folder) { isFetching = false; return; }
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
            const hash = JSON.stringify(data);
            const panelChanged = hash !== lastDataHash;
            if (panelChanged) {
                lastDataHash = hash;
            }

            // 如果有选中成员，每次轮询都刷新轨迹数据（实时更新新事件）
            if (selectedMember) {
                await fetchTrajectories();
            }

            // 面板数据变化时重新渲染（轨迹直接嵌入，不会闪烁）
            if (panelChanged) {
                renderPanel(data);
            } else if (selectedMember && trajectoryData) {
                // 面板未变化，但轨迹可能更新了，只更新轨迹区域
                showTrajectoryForMember(selectedMember);
            }
        } catch (e) {
            console.error('[SubAgent] Fetch error:', e);
        } finally {
            isFetching = false;
        }
    }

    function startPolling() {
        App.subAgent.stop();
        pollTimer = setInterval(() => {
            if (App.state.activeTab !== 'subagent') return;
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

        // 团队成员区块（点击可查看轨迹）
        html += renderMembers(data.members, data.teamName);

        // 轨迹详情区块 — 直接嵌入已缓存的轨迹 HTML，避免 innerHTML 替换导致闪烁
        html += '<div id="sa-trajectory-detail">';
        if (selectedMember && trajectoryData) {
            const traj = trajectoryData.find(t =>
                t.memberName === selectedMember ||
                t.memberName.toLowerCase() === selectedMember.toLowerCase()
            );
            if (traj) {
                html += renderTrajectoryTimeline(traj, selectedMember);
            }
        }
        html += '</div>';

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
            const isSelected = selectedMember === member.name;
            // 安全转义 member name 用于 onclick 和 data 属性
            const safeName = member.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

            html += `<div class="sa-member-card${isSelected ? ' sa-member-selected' : ''}" `;
            html += `data-member="${escapeHtml(member.name)}" `;
            html += `onclick="App.subAgent.selectMember('${safeName}')" `;
            html += `title="点击查看执行轨迹 — ${escapeHtml(member.prompt || '')}" style="cursor:pointer;">`;
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

    // ---- Trajectory functions ----

    /**
     * 点击成员卡片，获取并展示该成员的执行轨迹
     */
    App.subAgent.selectMember = function (memberName) {
        if (selectedMember === memberName) {
            // 再次点击取消选中
            selectedMember = null;
            const detail = document.getElementById('sa-trajectory-detail');
            if (detail) detail.innerHTML = '';
            document.querySelectorAll('.sa-member-card').forEach(c => c.classList.remove('sa-member-selected'));
            return;
        }
        selectedMember = memberName;

        // 用 data-member 属性更新选中样式（不依赖 event.currentTarget）
        document.querySelectorAll('.sa-member-card').forEach(c => {
            c.classList.toggle('sa-member-selected', c.getAttribute('data-member') === memberName);
        });

        if (trajectoryData) {
            showTrajectoryForMember(memberName);
            // 同时后台刷新最新轨迹
            fetchTrajectories().then(() => showTrajectoryForMember(memberName));
        } else {
            // 首次点击：显示 loading，然后获取
            const detail = document.getElementById('sa-trajectory-detail');
            if (detail) detail.innerHTML = '<div style="padding:12px; color:#94a3b8; font-size:0.85rem;">加载执行轨迹中...</div>';
            fetchTrajectories().then(() => showTrajectoryForMember(memberName));
        }
    };

    async function fetchTrajectories() {
        const taskId = App.state.currentTaskId;
        const folder = App.state.activeFolder;
        if (!taskId || !folder) return;
        const modelId = folder.includes('/') ? folder.split('/').pop() : folder;

        try {
            const resp = await fetch(`/api/tasks/${taskId}/models/${modelId}/agents/trajectories`, {
                headers: App.api.getAuthHeaders()
            });
            if (resp.ok) {
                const data = await resp.json();
                trajectoryData = data.trajectories || [];
            }
        } catch (e) {
            console.error('[SubAgent] Trajectory fetch error:', e);
        }
    }

    function showTrajectoryForMember(memberName) {
        const detail = document.getElementById('sa-trajectory-detail');
        if (!detail) return;
        // 如果当前选中的成员已变化，不更新（防止异步回调更新错误的成员）
        if (selectedMember !== memberName) return;

        if (!trajectoryData || trajectoryData.length === 0) {
            detail.innerHTML = '<div style="padding:12px; color:#94a3b8; font-size:0.85rem;">暂无执行轨迹数据</div>';
            return;
        }

        // 匹配成员：按 memberName 匹配
        const traj = trajectoryData.find(t =>
            t.memberName === memberName ||
            t.memberName.toLowerCase() === memberName.toLowerCase()
        );

        if (!traj) {
            detail.innerHTML = `<div style="padding:12px; color:#94a3b8; font-size:0.85rem;">未找到 ${escapeHtml(memberName)} 的执行轨迹</div>`;
            return;
        }

        // 仅在轨迹内容变化时更新 DOM（减少不必要的重绘）
        const trajHash = traj.events.length + ':' + (traj.events.length > 0 ? traj.events[traj.events.length - 1].timestamp : '');
        const currentHash = memberName + ':' + trajHash;
        if (detail.getAttribute('data-traj-hash') === currentHash) return;
        detail.setAttribute('data-traj-hash', currentHash);

        detail.innerHTML = renderTrajectoryTimeline(traj, memberName);
    }

    function renderTrajectoryTimeline(traj, memberName) {
        let html = '<div class="sa-section">';
        html += '<div class="sa-section-header">';
        html += `<span>${escapeHtml(memberName)} 的执行轨迹</span>`;
        html += `<span style="font-size:0.75rem; color:#94a3b8; font-weight:400;">${traj.events.length} events</span>`;
        html += '</div>';
        html += '<div class="sa-trajectory-timeline">';

        for (const evt of traj.events) {
            const time = formatTime(evt.timestamp);
            const typeClass = getEventTypeClass(evt.type);
            const typeLabel = getEventTypeLabel(evt.type);
            const text = evt.text || '';

            html += '<div class="sa-traj-item">';
            html += `<span class="sa-traj-time">${escapeHtml(time)}</span>`;
            html += `<span class="sa-traj-type ${typeClass}">${typeLabel}</span>`;
            html += `<span class="sa-traj-text">${formatEventText(evt.type, text)}</span>`;
            html += '</div>';
        }

        html += '</div></div>';
        return html;
    }

    /**
     * 格式化事件文本，为工具调用添加结构化高亮
     */
    function formatEventText(type, text) {
        if (!text) return '';

        if (type === 'tool_use') {
            // 解析工具名称和详情: "ToolName: details" 或 "ToolName → target: details"
            const colonIdx = text.indexOf(':');
            const arrowIdx = text.indexOf('→');

            if (arrowIdx > 0 && (colonIdx < 0 || arrowIdx < colonIdx)) {
                // "SendMessage → target: content" 格式
                const toolName = escapeHtml(text.slice(0, arrowIdx).trim());
                const rest = text.slice(arrowIdx + 1).trim();
                const restColonIdx = rest.indexOf(':');
                if (restColonIdx > 0) {
                    const target = escapeHtml(rest.slice(0, restColonIdx).trim());
                    const detail = escapeHtml(rest.slice(restColonIdx + 1).trim());
                    return `<span class="sa-tool-name">${toolName}</span> → <span class="sa-tool-target">${target}</span>: <span class="sa-tool-detail">${detail}</span>`;
                }
                return `<span class="sa-tool-name">${toolName}</span> → <span class="sa-tool-target">${escapeHtml(rest)}</span>`;
            }

            if (colonIdx > 0 && colonIdx < 30) {
                // "ToolName: detail" 格式
                const toolName = escapeHtml(text.slice(0, colonIdx).trim());
                const detail = escapeHtml(text.slice(colonIdx + 1).trim());
                return `<span class="sa-tool-name">${toolName}</span>: ${detail}`;
            }

            // 纯工具名称
            return `<span class="sa-tool-name">${escapeHtml(text)}</span>`;
        }

        if (type === 'tool_result') {
            return `<span class="sa-tool-detail">${escapeHtml(text)}</span>`;
        }

        return escapeHtml(text);
    }

    function getEventTypeClass(type) {
        switch (type) {
            case 'user': return 'sa-evt-user';
            case 'assistant': return 'sa-evt-assistant';
            case 'tool_use': return 'sa-evt-tool';
            case 'tool_result': return 'sa-evt-result';
            default: return '';
        }
    }

    function getEventTypeLabel(type) {
        switch (type) {
            case 'user': return 'USR';
            case 'assistant': return 'AST';
            case 'tool_use': return 'TOOL';
            case 'tool_result': return 'RES';
            default: return type;
        }
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
