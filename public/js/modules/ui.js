/**
 * UI Rendering logic for Task Manager
 */

import { AppState } from './state.js';
import { escapeHtml, formatDateTime, getModelStatusClass, truncate } from './utils.js';

// DOM Elements cache
const Elements = {
    tbody: () => document.getElementById('tasks-tbody'),
    thead: () => document.getElementById('tasks-thead'),
    filterUser: () => document.getElementById('filter-user'),
    maxParallelInput: () => document.getElementById('max-parallel-input'),
    batchActions: () => document.getElementById('batch-actions'),
    selectedCount: () => document.getElementById('selected-count'),

    // Modals
    promptModal: () => document.getElementById('prompt-modal'),
    promptContent: () => document.getElementById('prompt-content'),
    configModal: () => document.getElementById('config-modal'),
    questionModal: () => document.getElementById('question-modal'),
    modelModal: () => document.getElementById('model-modal'),

    // Lists & Tables
    questionList: () => document.getElementById('question-list'),
    usersTbody: () => document.getElementById('users-tbody'),
    modelsTbody: () => document.getElementById('models-tbody'),
    feedbackTbody: () => document.getElementById('feedback-stats-tbody'),
    feedbackThead: () => document.getElementById('feedback-stats-thead'),

    stats: {
        total: () => document.getElementById('stat-total'),
        running: () => document.getElementById('stat-running'),
        pending: () => document.getElementById('stat-pending'),
        completed: () => document.getElementById('stat-completed'),
        stopped: () => document.getElementById('stat-stopped'),
    },

    lastRefresh: () => document.getElementById('last-refresh')
};

export const UI = {
    // --- Toast Notification ---
    showToast(message, type = 'success') {
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.style.position = 'fixed';
            container.style.top = '20px';
            container.style.right = '20px';
            container.style.zIndex = '9999';
            container.style.display = 'flex';
            container.style.flexDirection = 'column';
            container.style.gap = '10px';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        Object.assign(toast.style, {
            padding: '12px 20px',
            borderRadius: '8px',
            color: 'white',
            fontSize: '0.9rem',
            fontWeight: '500',
            boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            animation: 'slideIn 0.3s ease-out forwards',
            minWidth: '200px',
            background: type === 'success' ? '#10b981' : '#ef4444'
        });

        toast.innerHTML = `<span>${type === 'success' ? '✅' : '❌'}</span><span>${message}</span>`;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'fadeOut 0.3s ease-in forwards';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    },

    // --- Users ---
    renderUsers(users) {
        const select = Elements.filterUser();
        if (!select) return;

        // keep the first option (All users)
        const firstOption = select.options[0];
        select.innerHTML = '';
        select.appendChild(firstOption);

        users.forEach(user => {
            const option = document.createElement('option');
            option.value = user.id;
            option.textContent = user.username;
            select.appendChild(option);
        });
    },

    // --- Config & Stats ---
    updateConfigInput(value) {
        const input = Elements.maxParallelInput();
        if (input && document.activeElement !== input) {
            input.value = value;
        }
    },

    updateLastRefresh() {
        const span = Elements.lastRefresh();
        if (span) {
            const now = new Date();
            span.textContent = `更新于 ${now.toLocaleTimeString()}`;
        }
    },

    updateStats() {
        let totalSubtasks = 0;
        let completedSubtasks = 0;
        let runningSubtasks = 0;
        let queuedSubtasks = 0;
        let stoppedSubtasks = 0;

        AppState.allTasks.forEach(task => {
            (task.runs || []).forEach(run => {
                if (run.status && run.status !== 'not-started') {
                    totalSubtasks++;
                    if (run.status === 'completed' || run.status === 'evaluated') {
                        completedSubtasks++;
                    } else if (run.status === 'running') {
                        runningSubtasks++;
                    } else if (run.status === 'pending') {
                        queuedSubtasks++;
                    } else if (run.status === 'stopped') {
                        stoppedSubtasks++;
                    }
                }
            });
        });

        if (Elements.stats.total()) Elements.stats.total().textContent = totalSubtasks;
        if (Elements.stats.running()) Elements.stats.running().textContent = runningSubtasks;
        if (Elements.stats.pending()) Elements.stats.pending().textContent = queuedSubtasks;
        if (Elements.stats.completed()) Elements.stats.completed().textContent = completedSubtasks;
        if (Elements.stats.stopped()) Elements.stats.stopped().textContent = stoppedSubtasks;
    },

    // --- Tasks Table ---
    updateTableHeader() {
        const thead = Elements.thead();
        if (!thead) return;

        const newModelNamesKey = AppState.allModelNames.join('|');
        if (newModelNamesKey === AppState.prevModelNamesKey) {
            return;
        }
        AppState.prevModelNamesKey = newModelNamesKey;

        let headerHTML = `
            <tr>
                <th class="checkbox-cell">
                    <input type="checkbox" class="task-checkbox" id="select-all">
                </th>
                <th class="task-cell">任务</th>
                <th>用户</th>
        `;

        AppState.allModelNames.forEach(modelName => {
            headerHTML += `<th class="model-col-header">${escapeHtml(modelName)}</th>`;
        });

        headerHTML += `
                <th>创建时间</th>
                <th>操作</th>
            </tr>
        `;

        thead.innerHTML = headerHTML;
    },

    renderTasks() {
        const tbody = Elements.tbody();
        const filteredTasks = AppState.filteredTasks;
        const totalCols = 5 + AppState.allModelNames.length;

        if (filteredTasks.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="${totalCols}" class="empty-state">
                        <p>没有找到任务</p>
                    </td>
                </tr>
            `;
            return;
        }

        const existingRows = {};
        tbody.querySelectorAll('tr[data-task-id]').forEach(row => {
            existingRows[row.dataset.taskId] = row;
        });

        const currentTaskIds = new Set(filteredTasks.map(t => t.taskId));

        Object.keys(existingRows).forEach(taskId => {
            if (!currentTaskIds.has(taskId)) {
                existingRows[taskId].remove();
                delete existingRows[taskId];
            }
        });

        tbody.querySelectorAll('tr:not([data-task-id])').forEach(row => row.remove());

        filteredTasks.forEach((task, index) => {
            const isChecked = AppState.selectedTasks.has(task.taskId);
            const createdAt = formatDateTime(task.createdAt);

            const modelStatusMap = {};
            (task.runs || []).forEach(run => {
                modelStatusMap[run.modelName] = run.status;
            });

            let row = existingRows[task.taskId];
            if (!row) {
                row = document.createElement('tr');
                row.dataset.taskId = task.taskId;
                row.innerHTML = this.buildRowContent(task, isChecked, createdAt, modelStatusMap);

                const nextSibling = tbody.children[index];
                if (nextSibling) {
                    tbody.insertBefore(row, nextSibling);
                } else {
                    tbody.appendChild(row);
                }
                existingRows[task.taskId] = row;
            } else {
                this.updateRowContent(row, task, isChecked, createdAt, modelStatusMap);
                const currentIndex = Array.from(tbody.children).indexOf(row);
                if (currentIndex !== index) {
                    const nextSibling = tbody.children[index];
                    if (nextSibling && nextSibling !== row) {
                        tbody.insertBefore(row, nextSibling);
                    } else if (!nextSibling) {
                        tbody.appendChild(row);
                    }
                }
            }
        });

        this.updateBatchActions();
    },

    buildRowContent(task, isChecked, createdAt, modelStatusMap) {
        const modelCells = AppState.allModelNames.map(modelName => {
            const status = modelStatusMap[modelName];
            const statusClass = getModelStatusClass(status);
            return `<td class="model-col-cell" data-model="${escapeHtml(modelName)}"><span class="model-status ${statusClass}"></span></td>`;
        }).join('');

        const hasRunningOrPending = (task.runs || []).some(r => r.status === 'running' || r.status === 'pending');
        const actionButtons = this.buildActionButtons(task.taskId, hasRunningOrPending);

        return `
            <td class="checkbox-cell">
                <input type="checkbox" class="task-checkbox" 
                       data-task-id="${task.taskId}" 
                       ${isChecked ? 'checked' : ''}>
            </td>
            <td class="task-cell">
                <div class="task-title" title="${escapeHtml(task.title || 'Untitled')}">${escapeHtml(task.title || 'Untitled')}</div>
                <div class="task-id">${task.taskId}</div>
            </td>
            <td>
                <span class="user-badge">${escapeHtml(task.username)}</span>
            </td>
            ${modelCells}
            <td>
                <span class="timestamp">${createdAt}</span>
            </td>
            <td class="actions-cell">
                <div class="action-buttons">
                    ${actionButtons}
                </div>
            </td>
        `;
    },

    updateRowContent(row, task, isChecked, createdAt, modelStatusMap) {
        const checkbox = row.querySelector('input.task-checkbox');
        if (checkbox && checkbox.checked !== isChecked) {
            checkbox.checked = isChecked;
        }

        AppState.allModelNames.forEach(modelName => {
            const status = modelStatusMap[modelName];
            const newStatusClass = getModelStatusClass(status);
            const cells = row.querySelectorAll('td.model-col-cell');
            for (const cell of cells) {
                if (cell.dataset.model === modelName) {
                    const dot = cell.querySelector('.model-status');
                    if (dot) {
                        const currentClasses = dot.className;
                        const expectedClasses = `model-status ${newStatusClass}`;
                        if (currentClasses !== expectedClasses) {
                            dot.className = expectedClasses;
                        }
                    }
                    break;
                }
            }
        });

        const hasRunningOrPending = (task.runs || []).some(r => r.status === 'running' || r.status === 'pending');
        const actionsCell = row.querySelector('.actions-cell');
        if (actionsCell) {
            const hasStopButton = actionsCell.querySelector('.action-btn-stop') !== null;
            if (hasRunningOrPending !== hasStopButton) {
                const actionButtons = this.buildActionButtons(task.taskId, hasRunningOrPending);
                actionsCell.innerHTML = `<div class="action-buttons">${actionButtons}</div>`;
            }
        }
    },

    buildActionButtons(taskId, hasRunningOrPending) {
        let actionButtons = '';
        if (hasRunningOrPending) {
            actionButtons = `<button class="action-btn action-btn-stop" data-action="stop" data-id="${taskId}">中止</button>`;
        }
        actionButtons += `
            <button class="action-btn action-btn-view" data-action="view" data-id="${taskId}">查看</button>
            <button class="action-btn action-btn-delete" data-action="delete" data-id="${taskId}">删除</button>
        `;
        return actionButtons;
    },

    updateBatchActions() {
        const batchActions = Elements.batchActions();
        const selectedCount = Elements.selectedCount();
        if (!batchActions || !selectedCount) return;

        if (AppState.selectedTasks.size > 0) {
            batchActions.classList.add('show');
            selectedCount.textContent = `已选择 ${AppState.selectedTasks.size} 个任务`;
        } else {
            batchActions.classList.remove('show');
        }
    },

    // --- Modals ---
    showPromptModal(content) {
        const modal = Elements.promptModal();
        const text = Elements.promptContent();
        if (modal && text) {
            text.textContent = content || '(无 Prompt)';
            modal.classList.add('show');
        }
    },

    closePromptModal() {
        this.closeModal('prompt-modal');
    },

    closeModal(modalId) {
        if (!modalId) return;
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('show');
    },

    openConfigModal(currentValue) {
        const input = Elements.maxParallelInput();
        if (input) {
            input.value = currentValue;
        }
        const modal = Elements.configModal();
        if (modal) modal.classList.add('show');
    },

    closeConfigModal() {
        this.closeModal('config-modal');
    },

    openQuestionModal(question = null) {
        const modal = Elements.questionModal();
        if (!modal) return;

        const title = document.getElementById('question-modal-title');
        document.getElementById('question-form').reset();
        document.getElementById('q-id').value = '';

        if (question) {
            title.textContent = '编辑题目';
            document.getElementById('q-id').value = question.id;
            document.getElementById('q-stem').value = question.stem;
            document.getElementById('q-short-name').value = question.short_name || '';
            document.getElementById('q-type').value = question.scoring_type;
            document.getElementById('q-desc').value = question.description || '';
            document.getElementById('q-comment').checked = !!question.has_comment;
            document.getElementById('q-required').checked = !!question.is_required;
        } else {
            title.textContent = '新建题目';
        }

        this.toggleOptionsContainer(question ? JSON.parse(question.options_json || '[]') : []);
        modal.classList.add('show');
    },

    toggleOptionsContainer(existingOptions = []) {
        const type = document.getElementById('q-type').value;
        const container = document.getElementById('q-options-container');
        const inputsDiv = document.getElementById('q-options-inputs');

        inputsDiv.innerHTML = '';
        const count = type === 'stars_5' ? 5 : 3;
        container.style.display = 'block';

        for (let i = 1; i <= count; i++) {
            const div = document.createElement('div');
            div.style.display = 'flex';
            div.style.gap = '0.5rem';
            div.style.alignItems = 'center';

            const label = document.createElement('span');
            label.textContent = `${i}分:`;
            label.style.width = '40px';
            label.style.fontSize = '0.9rem';

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'filter-input';
            input.style.flex = '1';
            input.placeholder = `选项 ${i} 的说明...`;
            input.value = existingOptions[i - 1] || '';
            input.dataset.index = i - 1;

            div.appendChild(label);
            div.appendChild(input);
            inputsDiv.appendChild(div);
        }
    },

    closeQuestionModal() {
        this.closeModal('question-modal');
    },

    openModelModal(model = null) {
        const modal = Elements.modelModal();
        if (!modal) return;

        const title = document.getElementById('model-modal-title');
        const form = document.getElementById('model-form');
        form.reset();
        document.getElementById('m-id').value = '';

        if (model) {
            title.textContent = '编辑模型';
            document.getElementById('m-id').value = model.id;
            document.getElementById('m-name').value = model.name;
            document.getElementById('m-desc').value = model.description || '';
            document.getElementById('m-enabled-internal').checked = !!model.is_enabled_internal;
            document.getElementById('m-enabled-external').checked = !!model.is_enabled_external;
            document.getElementById('m-enabled-admin').checked = !!model.is_enabled_admin;
            document.getElementById('m-default-checked').checked = !!model.is_default_checked;
        } else {
            title.textContent = '新增模型';
            document.getElementById('m-enabled-internal').checked = true;
            document.getElementById('m-enabled-external').checked = true;
            document.getElementById('m-enabled-admin').checked = true;
            document.getElementById('m-default-checked').checked = true;
        }

        modal.classList.add('show');
    },

    closeModelModal() {
        this.closeModal('model-modal');
    },

    // --- Question List ---
    renderQuestions(questions) {
        const list = Elements.questionList();
        if (!list) return;

        if (questions.length === 0) {
            list.innerHTML = '<div class="empty-state"><p>暂无题目，请点击右上角新建</p></div>';
            return;
        }

        list.innerHTML = questions.map((q, index) => `
            <div class="question-item" draggable="true" 
                 data-id="${q.id}" data-index="${index}"
                 data-action="edit-question"
                 style="align-items: center;">
                <div class="drag-handle" style="cursor: grab; margin-right: 1rem; padding: 0.5rem; display: grid; grid-template-columns: repeat(3, 4px); gap: 3px; color: #cbd5e1;">
                    <div style="width:4px; height:4px; background:currentColor; border-radius:50%"></div>
                    <div style="width:4px; height:4px; background:currentColor; border-radius:50%"></div>
                    <div style="width:4px; height:4px; background:currentColor; border-radius:50%"></div>
                    <div style="width:4px; height:4px; background:currentColor; border-radius:50%"></div>
                    <div style="width:4px; height:4px; background:currentColor; border-radius:50%"></div>
                    <div style="width:4px; height:4px; background:currentColor; border-radius:50%"></div>
                    <div style="width:4px; height:4px; background:currentColor; border-radius:50%"></div>
                    <div style="width:4px; height:4px; background:currentColor; border-radius:50%"></div>
                    <div style="width:4px; height:4px; background:currentColor; border-radius:50%"></div>
                </div>
                <div class="q-content" data-action="edit-question" data-id="${q.id}">
                    ${q.short_name ? `
                        <div style="font-size:1.1rem; font-weight:700; color:#1e293b; margin-bottom:0.25rem;">${escapeHtml(q.short_name)}</div>
                        <div style="font-size:0.9rem; color:#64748b; margin-bottom:0.5rem; line-height:1.5;">${escapeHtml(q.stem)}</div>
                    ` : `
                        <div style="font-size:1.1rem; font-weight:700; color:#1e293b; margin-bottom:0.5rem;">${escapeHtml(q.stem)}</div>
                    `}
                    
                    <div class="q-meta">
                        <span class="q-tag">${q.scoring_type === 'stars_5' ? '五星评分' : '三星评分'}</span>
                        ${q.is_required ? '<span class="q-tag" style="background:#fef3c7; color:#d97706">必填</span>' : '<span class="q-tag">选填</span>'}
                        ${q.has_comment ? '<span class="q-tag">允许评论</span>' : ''}
                    </div>
                </div>
                <div style="display:flex; align-items:center;">
                    <label class="toggle-switch" title="${q.is_active ? '点击停用' : '点击启用'}" onclick="event.stopPropagation()">
                        <input type="checkbox" ${q.is_active ? 'checked' : ''} data-action="toggle-question" data-id="${q.id}">
                        <span class="slider"></span>
                    </label>
                </div>
            </div>
        `).join('');
    },

    // --- Model List ---
    renderModels(models) {
        const tbody = Elements.modelsTbody();
        if (!tbody) return;

        if (models.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="empty-state"><p>暂无模型，请点击右上角新增</p></td></tr>';
            return;
        }

        tbody.innerHTML = models.map(model => `
            <tr>
                <td><strong>${escapeHtml(model.name)}</strong></td>
                <td>${escapeHtml(model.description || '-')}</td>
                <td>
                    <label class="toggle-switch">
                        <input type="checkbox" ${model.is_enabled_internal ? 'checked' : ''} 
                               data-action="update-model-status" data-id="${model.id}" data-field="is_enabled_internal">
                        <span class="slider"></span>
                    </label>
                </td>
                <td>
                    <label class="toggle-switch">
                        <input type="checkbox" ${model.is_enabled_external ? 'checked' : ''} 
                               data-action="update-model-status" data-id="${model.id}" data-field="is_enabled_external">
                        <span class="slider"></span>
                    </label>
                </td>
                <td>
                    <label class="toggle-switch">
                        <input type="checkbox" ${model.is_enabled_admin ? 'checked' : ''} 
                               data-action="update-model-status" data-id="${model.id}" data-field="is_enabled_admin">
                        <span class="slider"></span>
                    </label>
                </td>
                <td>
                    <label class="toggle-switch">
                        <input type="checkbox" ${model.is_default_checked ? 'checked' : ''} 
                               data-action="update-model-status" data-id="${model.id}" data-field="is_default_checked">
                        <span class="slider"></span>
                    </label>
                </td>
                <td><span class="timestamp">${formatDateTime(model.created_at)}</span></td>
                <td>
                    <div class="action-buttons">
                        <button class="action-btn action-btn-view" data-action="edit-model" data-id="${model.id}">编辑</button>
                        <button class="action-btn action-btn-delete" data-action="delete-model" data-id="${model.id}" data-name="${escapeHtml(model.name)}">删除</button>
                    </div>
                </td>
            </tr>
        `).join('');
    },

    // --- User List ---
    renderUserManagement(users) {
        const tbody = Elements.usersTbody();
        if (!tbody) return;

        if (users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty-state"><p>暂无用户</p></td></tr>';
            return;
        }

        tbody.innerHTML = users.map(user => `
            <tr>
                <td>${user.id}</td>
                <td><strong>${escapeHtml(user.username)}</strong></td>
                <td>
                    <select class="filter-select" data-action="update-user-role" data-id="${user.id}" style="min-width: 120px;">
                        <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>管理员</option>
                        <option value="internal" ${user.role === 'internal' ? 'selected' : ''}>内部评测人员</option>
                        <option value="external" ${user.role === 'external' ? 'selected' : ''}>外部评测人员</option>
                    </select>
                </td>
                <td><span class="timestamp">${formatDateTime(user.created_at)}</span></td>
                <td>
                    <div class="action-buttons">
                        <button class="action-btn action-btn-view" data-action="view-user-tasks" data-username="${escapeHtml(user.username)}">查看</button>
                        <button class="btn btn-warning btn-sm" onclick="alert('暂不支持删除用户')">删除</button>
                    </div>
                </td>
            </tr>
        `).join('');
    },

    // --- Feedback Stats ---
    renderFeedbackStats(statsData, activeQuestions) {
        const thead = Elements.feedbackThead();
        const tbody = Elements.feedbackTbody();

        if (!thead || !tbody) return;

        if (statsData.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="${5 + activeQuestions.length}" class="empty-state">
                        <p>暂无反馈数据</p>
                    </td>
                </tr>
            `;
            return;
        }

        // Build header
        let headerHTML = `
            <tr>
                <th>任务ID</th>
                <th>任务标题</th>
                <th>用户</th>
                <th>模型</th>
        `;
        activeQuestions.forEach(q => {
            const displayName = q.short_name || q.stem;
            headerHTML += `<th style="text-align: center;">${escapeHtml(displayName)}</th>`;
        });
        headerHTML += `<th>提交时间</th></tr>`;
        thead.innerHTML = headerHTML;

        // Build body
        tbody.innerHTML = statsData.map(row => {
            const responseMap = {};
            row.responses.forEach(r => responseMap[r.questionId] = r);

            const questionCells = activeQuestions.map(q => {
                const response = responseMap[q.id];
                if (!response || response.score === null || response.score === undefined) {
                    return `<td style="text-align: center; color: #94a3b8;">-</td>`;
                }
                const maxScore = q.scoring_type === 'stars_5' ? 5 : 3;
                const scorePercent = response.score / maxScore;
                let color = '#94a3b8';
                if (scorePercent >= 0.8) color = '#22c55e';
                else if (scorePercent >= 0.6) color = '#3b82f6';
                else if (scorePercent >= 0.4) color = '#f59e0b';
                else color = '#ef4444';

                const title = response.comment ? `评论: ${response.comment}` : '';
                return `<td style="text-align: center; color: ${color}; font-weight: 600;" title="${escapeHtml(title)}">${response.score}</td>`;
            }).join('');

            return `
                <tr>
                    <td><div class="task-id">${escapeHtml(row.taskId)}</div></td>
                    <td><div class="task-title" title="${escapeHtml(row.title || 'Untitled')}">${escapeHtml(row.title || 'Untitled')}</div></td>
                    <td><span class="user-badge">${escapeHtml(row.username)}</span></td>
                    <td><span style="font-size: 0.85rem; color: #475569;">${escapeHtml(row.modelName)}</span></td>
                    ${questionCells}
                    <td><span class="timestamp">${formatDateTime(row.submittedAt)}</span></td>
                </tr>
            `;
        }).join('');
    }
};
