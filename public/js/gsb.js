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
        createStep: 1,
        heartbeatInterval: null
    };

    // GSB namespace
    window.GSB = {};

    /**
     * 获取认证头
     */
    GSB.getAuthHeaders = function () {
        return {};
    };

    /**
     * Initialize
     */
    GSB.init = async function () {
        // Check login
        const savedUserStr = localStorage.getItem('claude_user');
        const loginRedirect = '/login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
        if (!savedUserStr) {
            window.location.href = loginRedirect;
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
            window.location.href = loginRedirect;
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

        // Init resize handle
        GSB.initResizeHandle();

        // Load jobs
        await GSB.loadJobs();
    };

    /**
     * Load job list
     */
    GSB.loadJobs = async function () {
        try {
            const res = await fetch(`/api/gsb/jobs?userId=${state.currentUser.id}`, { headers: GSB.getAuthHeaders() });
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
        GSB.stopHeartbeats();
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
            const res = await fetch(`/api/gsb/jobs/${jobId}`, { headers: GSB.getAuthHeaders() });
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
            const res = await fetch(`/api/gsb/jobs/${state.currentJob.id}/next`, { headers: GSB.getAuthHeaders() });
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
     * Stop preview heartbeats
     */
    GSB.stopHeartbeats = function () {
        if (state.heartbeatInterval) {
            clearInterval(state.heartbeatInterval);
            state.heartbeatInterval = null;
        }
    };

    /**
     * Show full prompt modal
     */
    GSB.showFullPrompt = function () {
        const text = state.currentTask ? state.currentTask.prompt : '';
        document.getElementById('prompt-modal-text').textContent = text;
        document.getElementById('prompt-modal').classList.add('show');
    };

    GSB.closeFullPrompt = function () {
        document.getElementById('prompt-modal').classList.remove('show');
    };

    /**
     * Initialize resize handle for preview panels
     */
    GSB.initResizeHandle = function () {
        const handle = document.getElementById('gsb-resize-handle');
        const area = document.querySelector('.gsb-preview-area');
        const panelA = document.getElementById('preview-panel-a');
        const panelB = document.getElementById('preview-panel-b');
        if (!handle || !area || !panelA || !panelB) return;

        let dragging = false;

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            dragging = true;
            handle.classList.add('dragging');
            area.classList.add('resizing');
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const rect = area.getBoundingClientRect();
            const offset = e.clientX - rect.left;
            const total = rect.width;
            const ratio = Math.max(0.1, Math.min(0.9, offset / total));
            panelA.style.flex = ratio;
            panelB.style.flex = 1 - ratio;
        });

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            area.classList.remove('resizing');
        });
    };

    /**
     * Start preview heartbeats for current task's models
     */
    GSB.startHeartbeats = function (taskId, leftModelId, rightModelId) {
        GSB.stopHeartbeats();

        const sendHeartbeat = () => {
            fetch('/api/preview/heartbeat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...GSB.getAuthHeaders() },
                body: JSON.stringify({ taskId, modelId: leftModelId })
            }).catch(() => {});
            fetch('/api/preview/heartbeat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...GSB.getAuthHeaders() },
                body: JSON.stringify({ taskId, modelId: rightModelId })
            }).catch(() => {});
        };

        sendHeartbeat();
        state.heartbeatInterval = setInterval(sendHeartbeat, 2000);
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
        const promptEl = document.getElementById('scoring-task-prompt');
        promptEl.textContent = task.prompt || '';
        document.getElementById('scoring-progress').textContent =
            `${state.currentJob.completed_count + 1} / ${state.currentJob.total_count}`;

        // Show expand button if prompt is truncated
        const expandBtn = document.getElementById('prompt-expand-btn');
        requestAnimationFrame(() => {
            expandBtn.style.display = promptEl.scrollWidth > promptEl.clientWidth ? '' : 'none';
        });

        // Update model labels (anonymous)
        document.getElementById('model-a-label').textContent = '方案 A';
        document.getElementById('model-b-label').textContent = '方案 B';

        // Start heartbeats to keep previews alive
        GSB.startHeartbeats(task.task_id, task.leftModel, task.rightModel);

        // Load previews using randomized left/right positions from server
        GSB.loadPreview('preview-iframe-a', task.task_id, task.leftModel, task.leftModelPreviewable);
        GSB.loadPreview('preview-iframe-b', task.task_id, task.rightModel, task.rightModelPreviewable);
    };

    // Store active poll timers per side so we can clear them
    const previewPolls = { a: null, b: null };
    // Store taskId/modelId per side for restart/fullscreen
    const previewMeta = { a: {}, b: {} };

    /**
     * Get DOM elements for a preview side ('a' or 'b')
     */
    function getPreviewEls(side) {
        return {
            iframe: document.getElementById(`preview-iframe-${side}`),
            statusBar: document.getElementById(`preview-status-bar-${side}`),
            statusDot: document.getElementById(`preview-status-dot-${side}`),
            statusText: document.getElementById(`preview-status-text-${side}`),
            fullscreenBtn: document.getElementById(`preview-fullscreen-${side}`),
            logsDiv: document.getElementById(`preview-logs-${side}`)
        };
    }

    /**
     * Show preview failure state for a side
     */
    function showGsbPreviewFailure(side, logs) {
        const els = getPreviewEls(side);
        els.statusBar.style.display = 'flex';
        els.statusDot.className = 'gsb-status-dot failed';
        els.statusText.innerHTML = '预览启动失败 <span class="preview-info-tip" data-tip="预览失败可能是因为产物代码有问题，也有可能是在线环境问题，建议下载产物后在本地运行">i</span>';
        els.fullscreenBtn.style.display = 'none';
        els.iframe.style.display = 'none';
        els.iframe.removeAttribute('src');
        els.iframe.removeAttribute('srcdoc');
        if (logs && logs.length > 0) {
            els.logsDiv.style.display = 'block';
            els.logsDiv.innerHTML = logs.map(l =>
                `<div style="margin-bottom:2px;"><span style="color:#6b7280;margin-right:4px;">[${new Date(l.ts).toLocaleTimeString()}]</span>${escapeHtml(l.msg)}</div>`
            ).join('');
        } else {
            els.logsDiv.style.display = 'block';
            els.logsDiv.innerHTML = '<div style="color:#9ca3af;padding:0.5rem;">无日志</div>';
        }
    }

    /**
     * Load preview in iframe
     */
    GSB.loadPreview = function (iframeId, taskId, modelId, previewable) {
        const side = iframeId.endsWith('-a') ? 'a' : 'b';
        const els = getPreviewEls(side);

        // Store meta for restart
        previewMeta[side] = { taskId, modelId, previewable };

        // Clear any existing poll
        if (previewPolls[side]) {
            clearInterval(previewPolls[side]);
            previewPolls[side] = null;
        }

        if (previewable === 'static' || previewable === 'dynamic') {
            GSB.startPreview(side, taskId, modelId);
        } else {
            // Not previewable
            els.statusBar.style.display = 'none';
            els.logsDiv.style.display = 'none';
            els.iframe.style.display = '';
            els.iframe.srcdoc = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;">无法预览</div>`;
        }
    };

    /**
     * Start preview via /api/preview/start
     * Checks status first to reuse existing preview services (avoids killing running ones)
     */
    GSB.startPreview = async function (side, taskId, modelId, forceRestart) {
        const els = getPreviewEls(side);

        try {
            // Fast path: check if already running (reuse existing preview service)
            if (!forceRestart) {
                const statusRes = await fetch(`/api/preview/status/${taskId}/${modelId}`, { headers: GSB.getAuthHeaders() });
                const statusData = await statusRes.json();

                if (statusData.status === 'ready' && statusData.url) {
                    console.log(`[GSB] Fast path: reusing existing preview for ${side} (${modelId})`);
                    GSB.showPreviewReady(side, statusData.url);
                    return;
                }

                if (statusData.status === 'starting' && statusData.url) {
                    console.log(`[GSB] Preview already starting for ${side} (${modelId}), polling...`);
                    els.statusBar.style.display = 'flex';
                    els.statusDot.className = 'gsb-status-dot starting';
                    els.statusText.textContent = '预览服务启动中';
                    els.fullscreenBtn.style.display = 'none';
                    els.iframe.style.display = 'none';
                    els.logsDiv.style.display = 'block';
                    els.logsDiv.innerHTML = '<div style="color:#9ca3af;padding:0.5rem;">等待服务响应...</div>';
                    GSB.pollPreviewStatus(side, taskId, modelId, statusData.url);
                    return;
                }
            }

            // Show starting state
            els.statusBar.style.display = 'flex';
            els.statusDot.className = 'gsb-status-dot starting';
            els.statusText.textContent = '预览服务启动中';
            els.fullscreenBtn.style.display = 'none';
            els.iframe.style.display = 'none';
            els.iframe.removeAttribute('src');
            els.iframe.removeAttribute('srcdoc');
            els.logsDiv.style.display = 'block';
            els.logsDiv.innerHTML = '<div style="color:#9ca3af;padding:0.5rem;">等待服务响应...</div>';

            // Not running, start a new preview
            console.log(`[GSB] Starting new preview for ${side} (${modelId})`);
            const res = await fetch('/api/preview/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...GSB.getAuthHeaders() },
                body: JSON.stringify({ taskId, modelId })
            });

            const data = await res.json();
            if (data.status === 'ready' && data.url) {
                // Static preview - already ready
                GSB.showPreviewReady(side, data.url);
            } else if (data.url) {
                // Dynamic preview - poll until ready
                GSB.pollPreviewStatus(side, taskId, modelId, data.url);
            } else {
                showGsbPreviewFailure(side, [{ msg: '服务未返回预览地址', ts: Date.now() }]);
            }
        } catch (e) {
            console.error('[GSB] Preview start error:', e);
            showGsbPreviewFailure(side, [{ msg: `API Error: ${e.message}`, ts: Date.now() }]);
        }
    };

    /**
     * Show preview ready state
     */
    GSB.showPreviewReady = function (side, url) {
        const els = getPreviewEls(side);
        els.statusBar.style.display = 'flex';
        els.statusDot.className = 'gsb-status-dot success';
        els.statusText.textContent = '预览运行中';
        els.fullscreenBtn.style.display = 'flex';
        els.fullscreenBtn.setAttribute('data-url', url);
        els.logsDiv.style.display = 'none';
        els.iframe.removeAttribute('srcdoc');
        els.iframe.src = url;
        els.iframe.style.display = '';
    };

    /**
     * Poll preview status
     */
    GSB.pollPreviewStatus = function (side, taskId, modelId, url) {
        const els = getPreviewEls(side);

        // Clear any existing poll for this side
        if (previewPolls[side]) {
            clearInterval(previewPolls[side]);
        }

        previewPolls[side] = setInterval(async () => {
            try {
                const res = await fetch(`/api/preview/status/${taskId}/${modelId}`, { headers: GSB.getAuthHeaders() });
                const data = await res.json();

                // Update logs
                if (data.logs && data.logs.length > 0) {
                    els.logsDiv.innerHTML = data.logs.map(l =>
                        `<div style="margin-bottom:2px;"><span style="color:#6b7280;margin-right:4px;">[${new Date(l.ts).toLocaleTimeString()}]</span>${escapeHtml(l.msg)}</div>`
                    ).join('');
                    els.logsDiv.scrollTop = els.logsDiv.scrollHeight;
                }

                if (data.status === 'ready') {
                    clearInterval(previewPolls[side]);
                    previewPolls[side] = null;
                    GSB.showPreviewReady(side, url);
                    return;
                }

                if (data.status === 'error' || data.status === 'not_running') {
                    clearInterval(previewPolls[side]);
                    previewPolls[side] = null;
                    showGsbPreviewFailure(side, data.logs || []);
                    return;
                }

                // Check log content for failure
                if (data.logs && data.logs.length > 0) {
                    const lastLog = data.logs[data.logs.length - 1];
                    if (lastLog.msg && lastLog.msg.includes('Preview not running')) {
                        clearInterval(previewPolls[side]);
                        previewPolls[side] = null;
                        showGsbPreviewFailure(side, data.logs);
                        return;
                    }
                }
            } catch (e) {
                clearInterval(previewPolls[side]);
                previewPolls[side] = null;
                showGsbPreviewFailure(side, [{ msg: `状态检查失败: ${e.message}`, ts: Date.now() }]);
            }
        }, 1000);
    };

    /**
     * Restart preview for a side
     */
    GSB.restartPreview = function (side) {
        const meta = previewMeta[side];
        if (meta && meta.taskId && meta.modelId) {
            // Force restart: kill existing and start new
            GSB.startPreview(side, meta.taskId, meta.modelId, true);
        }
    };

    /**
     * Open preview fullscreen in new tab
     */
    GSB.openFullscreen = function (side) {
        const btn = document.getElementById(`preview-fullscreen-${side}`);
        const url = btn && btn.getAttribute('data-url');
        if (url) {
            window.open(url, '_blank');
        }
    };

    /**
     * Submit rating
     */
    GSB.submitRating = async function (rating) {
        if (!state.currentJob || !state.currentTask) return;

        try {
            const res = await fetch(`/api/gsb/jobs/${state.currentJob.id}/rate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...GSB.getAuthHeaders() },
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

        GSB.stopHeartbeats();

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

        const modelAName = job.model_a_display || job.model_a;
        const modelBName = job.model_b_display || job.model_b;

        document.getElementById('results-job-name').textContent = job.name;
        document.getElementById('results-models').textContent = `${modelAName} vs ${modelBName}`;

        document.getElementById('result-model-a-wins').textContent = results.model_a_wins || 0;
        document.getElementById('result-model-b-wins').textContent = results.model_b_wins || 0;
        document.getElementById('result-same').textContent = results.same_count || 0;
        document.getElementById('result-failed').textContent = results.failed_count || 0;

        document.getElementById('result-model-a-label').textContent = `${modelAName} 胜出`;
        document.getElementById('result-model-b-label').textContent = `${modelBName} 胜出`;

        // Render task details table
        GSB.renderTaskDetails(job);
    };

    /**
     * Render task details table
     */
    GSB.renderTaskDetails = function (job) {
        const tbody = document.getElementById('results-task-tbody');
        const tasks = job.tasks || [];
        const modelAName = job.model_a_display || job.model_a;
        const modelBName = job.model_b_display || job.model_b;

        const ratingLabels = {
            'left_better': `${modelAName} 胜`,
            'right_better': `${modelBName} 胜`,
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
                    <td><a href="/task.html?task=${task.task_id}" target="_blank" class="gsb-task-title-link">${escapeHtml(task.title || 'Untitled')}</a></td>
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
            await fetch(`/api/gsb/jobs/${jobId}`, { method: 'DELETE', headers: GSB.getAuthHeaders() });

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
            const res = await fetch(`/api/gsb/available-models?userId=${state.currentUser.id}`, { headers: GSB.getAuthHeaders() });
            state.availableModels = await res.json();

            // Models come as objects with model_id, endpoint_name, and displayName
            const options = state.availableModels.map(m => {
                const displayName = m.displayName || m.endpoint_name || m.model_id;
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

        // 更新表头模型名称 - 使用 displayName 而非 model_id
        const thModelA = document.getElementById('th-model-a');
        const thModelB = document.getElementById('th-model-b');
        const modelAObj = state.availableModels.find(m => m.model_id === modelA);
        const modelBObj = state.availableModels.find(m => m.model_id === modelB);
        const modelADisplay = modelAObj ? (modelAObj.displayName || modelAObj.endpoint_name || modelA) : modelA;
        const modelBDisplay = modelBObj ? (modelBObj.displayName || modelBObj.endpoint_name || modelB) : modelB;
        if (thModelA) {
            thModelA.innerHTML = `<div class="model-header"><span class="model-name">${escapeHtml(modelADisplay)}</span><span class="preview-label">预览状态</span></div>`;
        }
        if (thModelB) {
            thModelB.innerHTML = `<div class="model-header"><span class="model-name">${escapeHtml(modelBDisplay)}</span><span class="preview-label">预览状态</span></div>`;
        }

        try {
            const res = await fetch(
                `/api/gsb/available-tasks?userId=${state.currentUser.id}&modelA=${modelA}&modelB=${modelB}`,
                { headers: GSB.getAuthHeaders() }
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

                // Auto-select all selectable tasks
                if (canSelect) {
                    state.selectedTasks.add(task.task_id);
                }

                return `
                    <tr class="${canSelect ? '' : 'disabled'}">
                        <td>
                            <input type="checkbox" class="gsb-checkbox"
                                   data-task-id="${task.task_id}"
                                   ${canSelect ? 'checked' : 'disabled'}
                                   onchange="GSB.toggleTask('${task.task_id}', this.checked)">
                        </td>
                        <td class="title-cell" title="${escapeHtml(task.title || 'Untitled')}">${escapeHtml(task.title || 'Untitled')}</td>
                        <td class="prompt-cell" title="${escapeHtml(task.prompt || '')}">${escapeHtml(task.prompt || '')}</td>
                        <td class="preview-cell"><span class="preview-status ${aStatus}"></span>${aStatus === 'available' ? '可预览' : '不可预览'}</td>
                        <td class="preview-cell"><span class="preview-status ${bStatus}"></span>${bStatus === 'available' ? '可预览' : '不可预览'}</td>
                    </tr>
                `;
            }).join('');

            // Check the "select all" checkbox
            const selectAllCb = document.getElementById('select-all-tasks');
            if (selectAllCb) selectAllCb.checked = true;

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
                headers: { 'Content-Type': 'application/json', ...GSB.getAuthHeaders() },
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

    /**
     * Toggle sidebar collapse/expand
     */
    GSB.toggleSidebar = function () {
        const sidebar = document.getElementById('gsb-sidebar');
        const toggleBtn = document.getElementById('gsb-sidebar-toggle');
        const collapsed = sidebar.classList.toggle('collapsed');
        toggleBtn.classList.toggle('visible', collapsed);
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
