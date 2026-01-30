/**
 * GSB 评测页面 JavaScript
 * GSB (Good/Same/Bad) scoring functionality
 */
(function () {
    'use strict';

    // State
    const state = {
        currentUser: null,
        jobs: [],
        currentJob: null,
        currentTask: null,
        availableModels: [],
        availableTasks: [],
        selectedTasks: new Set(),
        createStep: 1
    };

    // GSB namespace
    window.GSB = {};

    /**
     * Initialize
     */
    GSB.init = async function () {
        // Check login
        const savedUserStr = localStorage.getItem('claude_user');
        if (!savedUserStr) {
            window.location.href = '/login.html';
            return;
        }

        try {
            state.currentUser = JSON.parse(savedUserStr);
            if (!state.currentUser || !state.currentUser.id) {
                throw new Error('Invalid user');
            }

            // Check role - only internal users can access GSB
            if (state.currentUser.role !== 'internal') {
                alert('只有内部评测人员才能使用 GSB 评测功能');
                window.location.href = '/task.html';
                return;
            }
        } catch (e) {
            window.location.href = '/login.html';
            return;
        }

        // Click outside to close dropdown
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('gsb-job-dropdown');
            const isMenuBtn = e.target.closest('.gsb-job-menu-btn');
            if (!isMenuBtn && menu) {
                menu.classList.remove('show');
            }
        });

        // Load jobs
        await GSB.loadJobs();
    };

    /**
     * Load job list
     */
    GSB.loadJobs = async function () {
        try {
            const res = await fetch(`/api/gsb/jobs?userId=${state.currentUser.id}`);
            state.jobs = await res.json();
            GSB.renderJobList();
        } catch (e) {
            console.error('[GSB] Error loading jobs:', e);
        }
    };

    /**
     * Render job list in sidebar
     */
    GSB.renderJobList = function () {
        const container = document.getElementById('gsb-job-list');

        if (state.jobs.length === 0) {
            container.innerHTML = `
                <div class="gsb-empty-state" style="padding: 2rem; text-align: center;">
                    <p style="color: #94a3b8;">暂无评测作业</p>
                    <p style="color: #94a3b8; font-size: 0.8rem; margin-top: 0.5rem;">点击上方按钮创建新作业</p>
                </div>
            `;
            return;
        }

        container.innerHTML = state.jobs.map(job => {
            const isActive = state.currentJob && state.currentJob.id === job.id;
            const statusClass = job.status === 'completed' ? 'completed' : 'scoring';

            return `
                <div class="gsb-job-card ${isActive ? 'active' : ''}" onclick="GSB.selectJob(${job.id})">
                    <span class="gsb-job-status-dot ${statusClass}"></span>
                    <span class="gsb-job-name">${escapeHtml(job.name)}</span>
                    <button class="gsb-job-menu-btn" onclick="event.stopPropagation(); GSB.toggleJobMenu(event, ${job.id});">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="5" r="2"/>
                            <circle cx="12" cy="12" r="2"/>
                            <circle cx="12" cy="19" r="2"/>
                        </svg>
                    </button>
                </div>
            `;
        }).join('');
    };

    /**
     * Toggle job menu dropdown
     */
    GSB.toggleJobMenu = function (event, jobId) {
        const menu = document.getElementById('gsb-job-dropdown');
        const btn = event.currentTarget;
        const rect = btn.getBoundingClientRect();

        // Position the menu
        menu.style.top = rect.bottom + 4 + 'px';
        menu.style.left = rect.left - 60 + 'px';

        // Store job id
        state.activeMenuJobId = jobId;

        // Toggle menu
        if (menu.classList.contains('show') && state.activeMenuJobId === jobId) {
            menu.classList.remove('show');
        } else {
            menu.classList.add('show');
        }
    };

    /**
     * Delete job from menu
     */
    GSB.deleteJobFromMenu = function () {
        if (state.activeMenuJobId) {
            GSB.deleteJob(state.activeMenuJobId);
        }
        document.getElementById('gsb-job-dropdown').classList.remove('show');
    };

    /**
     * Select a job
     */
    GSB.selectJob = async function (jobId) {
        if (!jobId) {
            state.currentJob = null;
            state.currentTask = null;
            document.getElementById('gsb-empty-state').style.display = 'flex';
            document.getElementById('gsb-scoring-view').style.display = 'none';
            document.getElementById('gsb-results-view').style.display = 'none';
            GSB.renderJobList();
            return;
        }

        try {
            const res = await fetch(`/api/gsb/jobs/${jobId}`);
            state.currentJob = await res.json();
            GSB.renderJobList();

            if (state.currentJob.status === 'completed') {
                GSB.showResults();
            } else {
                await GSB.loadNextTask();
            }
        } catch (e) {
            console.error('[GSB] Error selecting job:', e);
        }
    };

    /**
     * Load next unrated task
     */
    GSB.loadNextTask = async function () {
        if (!state.currentJob) return;

        try {
            const res = await fetch(`/api/gsb/jobs/${state.currentJob.id}/next`);
            const data = await res.json();

            if (data.completed) {
                GSB.showResults();
                return;
            }

            state.currentTask = data.task;
            GSB.showScoringView();
        } catch (e) {
            console.error('[GSB] Error loading next task:', e);
        }
    };

    /**
     * Show scoring view
     */
    GSB.showScoringView = function () {
        const task = state.currentTask;
        if (!task) return;

        document.getElementById('gsb-empty-state').style.display = 'none';
        document.getElementById('gsb-results-view').style.display = 'none';
        const view = document.getElementById('gsb-scoring-view');
        view.style.display = 'flex';

        // Update info
        document.getElementById('scoring-task-title').textContent = task.title || 'Untitled';
        document.getElementById('scoring-task-prompt').textContent = task.prompt || '';
        document.getElementById('scoring-progress').textContent =
            `${state.currentJob.completed_count + 1} / ${state.currentJob.total_count}`;

        // Update model labels (anonymous)
        document.getElementById('model-a-label').textContent = '方案 A';
        document.getElementById('model-b-label').textContent = '方案 B';

        // Load previews
        GSB.loadPreview('preview-iframe-a', task.task_id, task.modelA, task.modelAPreviewable);
        GSB.loadPreview('preview-iframe-b', task.task_id, task.modelB, task.modelBPreviewable);
    };

    /**
     * Load preview in iframe
     */
    GSB.loadPreview = function (iframeId, taskId, modelId, previewable) {
        const iframe = document.getElementById(iframeId);

        if (previewable === 'static') {
            // Static preview - direct file serving
            iframe.src = `/api/preview/view/${taskId}/${modelId}/index.html`;
        } else if (previewable === 'dynamic') {
            // Dynamic preview - need to start server
            GSB.startDynamicPreview(iframe, taskId, modelId);
        } else {
            iframe.srcdoc = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;">无法预览</div>`;
        }
    };

    /**
     * Start dynamic preview
     */
    GSB.startDynamicPreview = async function (iframe, taskId, modelId) {
        iframe.srcdoc = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#64748b;">启动预览中...</div>`;

        try {
            const res = await fetch('/api/preview/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId, modelId })
            });

            const data = await res.json();
            if (data.url) {
                // Poll until ready
                GSB.pollPreviewStatus(iframe, taskId, modelId, data.url);
            } else {
                iframe.srcdoc = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#dc2626;">预览启动失败</div>`;
            }
        } catch (e) {
            console.error('[GSB] Preview start error:', e);
            iframe.srcdoc = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#dc2626;">预览启动失败</div>`;
        }
    };

    /**
     * Poll preview status
     */
    GSB.pollPreviewStatus = async function (iframe, taskId, modelId, url) {
        let attempts = 0;
        const maxAttempts = 30;

        const poll = async () => {
            try {
                const res = await fetch(`/api/preview/status/${taskId}/${modelId}`);
                const data = await res.json();

                if (data.status === 'ready') {
                    iframe.src = url;
                    return;
                }

                attempts++;
                if (attempts < maxAttempts) {
                    setTimeout(poll, 1000);
                } else {
                    iframe.srcdoc = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#dc2626;">预览启动超时</div>`;
                }
            } catch (e) {
                iframe.srcdoc = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#dc2626;">预览状态检查失败</div>`;
            }
        };

        poll();
    };

    /**
     * Submit rating
     */
    GSB.submitRating = async function (rating) {
        if (!state.currentJob || !state.currentTask) return;

        try {
            const res = await fetch(`/api/gsb/jobs/${state.currentJob.id}/rate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    taskId: state.currentTask.task_id,
                    rating: rating
                })
            });

            const data = await res.json();
            if (data.success) {
                state.currentJob.completed_count = data.completedCount;

                if (data.isCompleted) {
                    state.currentJob.status = 'completed';
                    GSB.showResults();
                } else {
                    await GSB.loadNextTask();
                }

                GSB.renderJobList();
            }
        } catch (e) {
            console.error('[GSB] Error submitting rating:', e);
            alert('提交评分失败');
        }
    };

    /**
     * Show results view
     */
    GSB.showResults = async function () {
        if (!state.currentJob) return;

        // Refresh job data to get results
        try {
            const res = await fetch(`/api/gsb/jobs/${state.currentJob.id}`);
            state.currentJob = await res.json();
        } catch (e) {
            console.error('[GSB] Error refreshing job:', e);
        }

        document.getElementById('gsb-empty-state').style.display = 'none';
        document.getElementById('gsb-scoring-view').style.display = 'none';
        document.getElementById('gsb-results-view').style.display = 'block';

        const job = state.currentJob;
        const results = job.results || {};

        document.getElementById('results-job-name').textContent = job.name;
        document.getElementById('results-models').textContent = `${job.model_a} vs ${job.model_b}`;

        document.getElementById('result-model-a-wins').textContent = results.model_a_wins || 0;
        document.getElementById('result-model-b-wins').textContent = results.model_b_wins || 0;
        document.getElementById('result-same').textContent = results.same_count || 0;
        document.getElementById('result-failed').textContent = results.failed_count || 0;

        document.getElementById('result-model-a-label').textContent = `${job.model_a} 胜出`;
        document.getElementById('result-model-b-label').textContent = `${job.model_b} 胜出`;

        // Render task details table
        GSB.renderTaskDetails(job);
    };

    /**
     * Render task details table
     */
    GSB.renderTaskDetails = function (job) {
        const tbody = document.getElementById('results-task-tbody');
        const tasks = job.tasks || [];

        const ratingLabels = {
            'left_better': `${job.model_a} 胜`,
            'right_better': `${job.model_b} 胜`,
            'same': '平局',
            'failed': '加载失败'
        };

        tbody.innerHTML = tasks.map((task, index) => {
            const rating = task.rating || 'pending';
            const ratingLabel = ratingLabels[rating] || '未评分';
            const badgeClass = rating !== 'pending' ? rating : '';

            return `
                <tr>
                    <td>${index + 1}</td>
                    <td>${escapeHtml(task.title || 'Untitled')}</td>
                    <td><span class="rating-badge ${badgeClass}">${ratingLabel}</span></td>
                </tr>
            `;
        }).join('');
    };

    /**
     * Delete job
     */
    GSB.deleteJob = async function (jobId) {
        try {
            await fetch(`/api/gsb/jobs/${jobId}`, { method: 'DELETE' });

            if (state.currentJob && state.currentJob.id === jobId) {
                GSB.selectJob(null);
            }

            await GSB.loadJobs();
        } catch (e) {
            console.error('[GSB] Error deleting job:', e);
            alert('删除失败');
        }
    };

    /**
     * Open create modal
     */
    GSB.openCreateModal = async function () {
        state.createStep = 1;
        state.selectedTasks = new Set();

        document.getElementById('job-name-input').value = '';
        document.getElementById('model-a-select').value = '';
        document.getElementById('model-b-select').value = '';

        document.getElementById('create-step-1').style.display = 'block';
        document.getElementById('create-step-2').style.display = 'none';
        document.getElementById('modal-back-btn').style.display = 'none';
        document.getElementById('modal-next-btn').textContent = '下一步';

        document.getElementById('create-job-modal').classList.add('show');

        // Load available models
        await GSB.loadAvailableModels();
    };

    /**
     * Close create modal
     */
    GSB.closeCreateModal = function () {
        document.getElementById('create-job-modal').classList.remove('show');
    };

    /**
     * Load available models
     */
    GSB.loadAvailableModels = async function () {
        try {
            const res = await fetch(`/api/gsb/available-models?userId=${state.currentUser.id}`);
            state.availableModels = await res.json();

            // Models now come as objects with model_id and endpoint_name
            const options = state.availableModels.map(m => {
                const displayName = m.endpoint_name || m.model_id;
                const value = m.model_id;
                return `<option value="${escapeHtml(value)}" data-display="${escapeHtml(displayName)}">${escapeHtml(displayName)}</option>`;
            }).join('');

            const modelASelect = document.getElementById('model-a-select');
            const modelBSelect = document.getElementById('model-b-select');

            modelASelect.innerHTML = '<option value="">请选择模型...</option>' + options;
            modelBSelect.innerHTML = '<option value="">请选择模型...</option>' + options;

            // 添加事件监听器来实时更新作业名称
            modelASelect.onchange = GSB.updateJobNameFromModels;
            modelBSelect.onchange = GSB.updateJobNameFromModels;
        } catch (e) {
            console.error('[GSB] Error loading models:', e);
        }
    };

    /**
     * Update job name based on selected models
     */
    GSB.updateJobNameFromModels = function () {
        const modelASelect = document.getElementById('model-a-select');
        const modelBSelect = document.getElementById('model-b-select');
        const jobNameInput = document.getElementById('job-name-input');

        // Get display names from data attributes
        const modelADisplayName = modelASelect.selectedOptions[0]?.dataset.display || modelASelect.value;
        const modelBDisplayName = modelBSelect.selectedOptions[0]?.dataset.display || modelBSelect.value;

        if (modelASelect.value && modelBSelect.value && modelASelect.value !== modelBSelect.value) {
            jobNameInput.value = `${modelADisplayName} vs ${modelBDisplayName} 对比评测`;
        } else if (modelASelect.value && !modelBSelect.value) {
            jobNameInput.value = `${modelADisplayName} vs ? 对比评测`;
        } else if (!modelASelect.value && modelBSelect.value) {
            jobNameInput.value = `? vs ${modelBDisplayName} 对比评测`;
        }
    };

    /**
     * Next step in create modal
     */
    GSB.nextStep = async function () {
        if (state.createStep === 1) {
            const name = document.getElementById('job-name-input').value.trim();
            const modelA = document.getElementById('model-a-select').value;
            const modelB = document.getElementById('model-b-select').value;

            if (!name) {
                alert('请输入作业名称');
                return;
            }
            if (!modelA || !modelB) {
                alert('请选择两个模型');
                return;
            }
            if (modelA === modelB) {
                alert('请选择不同的模型');
                return;
            }

            // Load tasks
            await GSB.loadAvailableTasks(modelA, modelB);

            state.createStep = 2;
            document.getElementById('create-step-1').style.display = 'none';
            document.getElementById('create-step-2').style.display = 'block';
            document.getElementById('modal-back-btn').style.display = 'inline-block';
            document.getElementById('modal-next-btn').textContent = '创建作业';
        } else if (state.createStep === 2) {
            // Create job
            await GSB.createJob();
        }
    };

    /**
     * Previous step
     */
    GSB.prevStep = function () {
        if (state.createStep === 2) {
            state.createStep = 1;
            document.getElementById('create-step-1').style.display = 'block';
            document.getElementById('create-step-2').style.display = 'none';
            document.getElementById('modal-back-btn').style.display = 'none';
            document.getElementById('modal-next-btn').textContent = '下一步';
        }
    };

    /**
     * Load available tasks for selected models
     */
    GSB.loadAvailableTasks = async function (modelA, modelB) {
        const tbody = document.getElementById('task-selection-tbody');
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:2rem;">加载中...</td></tr>';

        // 更新表头模型名称
        const thModelA = document.getElementById('th-model-a');
        const thModelB = document.getElementById('th-model-b');
        if (thModelA) {
            thModelA.innerHTML = `<div class="model-header"><span class="model-name">${escapeHtml(modelA)}</span><span class="preview-label">预览状态</span></div>`;
        }
        if (thModelB) {
            thModelB.innerHTML = `<div class="model-header"><span class="model-name">${escapeHtml(modelB)}</span><span class="preview-label">预览状态</span></div>`;
        }

        try {
            const res = await fetch(
                `/api/gsb/available-tasks?userId=${state.currentUser.id}&modelA=${modelA}&modelB=${modelB}`
            );
            state.availableTasks = await res.json();
            state.selectedTasks = new Set();

            if (state.availableTasks.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:2rem;">没有可用的任务</td></tr>';
                return;
            }

            tbody.innerHTML = state.availableTasks.map(task => {
                const canSelect = task.canSelect;
                const aStatus = (task.model_a_previewable === 'static' || task.model_a_previewable === 'dynamic')
                    ? 'available' : 'unavailable';
                const bStatus = (task.model_b_previewable === 'static' || task.model_b_previewable === 'dynamic')
                    ? 'available' : 'unavailable';

                return `
                    <tr class="${canSelect ? '' : 'disabled'}">
                        <td>
                            <input type="checkbox" class="gsb-checkbox" 
                                   data-task-id="${task.task_id}"
                                   ${canSelect ? '' : 'disabled'}
                                   onchange="GSB.toggleTask('${task.task_id}', this.checked)">
                        </td>
                        <td class="title-cell" title="${escapeHtml(task.title || 'Untitled')}">${escapeHtml(task.title || 'Untitled')}</td>
                        <td class="prompt-cell" title="${escapeHtml(task.prompt || '')}">${escapeHtml(task.prompt || '')}</td>
                        <td class="preview-cell"><span class="preview-status ${aStatus}"></span>${aStatus === 'available' ? '可预览' : '不可预览'}</td>
                        <td class="preview-cell"><span class="preview-status ${bStatus}"></span>${bStatus === 'available' ? '可预览' : '不可预览'}</td>
                    </tr>
                `;
            }).join('');

            GSB.updateSelectedCount();
        } catch (e) {
            console.error('[GSB] Error loading tasks:', e);
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#dc2626;padding:2rem;">加载失败</td></tr>';
        }
    };

    /**
     * Toggle task selection
     */
    GSB.toggleTask = function (taskId, checked) {
        if (checked) {
            state.selectedTasks.add(taskId);
        } else {
            state.selectedTasks.delete(taskId);
        }
        GSB.updateSelectedCount();
    };

    /**
     * Toggle all tasks
     */
    GSB.toggleAllTasks = function (checked) {
        const checkboxes = document.querySelectorAll('#task-selection-tbody .gsb-checkbox:not(:disabled)');
        checkboxes.forEach(cb => {
            cb.checked = checked;
            const taskId = cb.dataset.taskId;
            if (checked) {
                state.selectedTasks.add(taskId);
            } else {
                state.selectedTasks.delete(taskId);
            }
        });
        GSB.updateSelectedCount();
    };

    /**
     * Update selected count display
     */
    GSB.updateSelectedCount = function () {
        document.getElementById('selected-task-count').textContent =
            `已选择 ${state.selectedTasks.size} 个任务`;
    };

    /**
     * Create job
     */
    GSB.createJob = async function () {
        if (state.selectedTasks.size === 0) {
            alert('请至少选择一个任务');
            return;
        }

        const name = document.getElementById('job-name-input').value.trim();
        const modelA = document.getElementById('model-a-select').value;
        const modelB = document.getElementById('model-b-select').value;

        try {
            const res = await fetch('/api/gsb/jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    modelA,
                    modelB,
                    userId: state.currentUser.id,
                    taskIds: Array.from(state.selectedTasks)
                })
            });

            const data = await res.json();
            if (data.success) {
                GSB.closeCreateModal();
                await GSB.loadJobs();
                GSB.selectJob(data.jobId);
            } else {
                alert('创建失败: ' + (data.error || '未知错误'));
            }
        } catch (e) {
            console.error('[GSB] Error creating job:', e);
            alert('创建失败');
        }
    };

    // Utility functions
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function truncate(str, len) {
        if (!str) return '';
        return str.length > len ? str.substring(0, len) + '...' : str;
    }

    // Initialize on load
    document.addEventListener('DOMContentLoaded', GSB.init);
})();
