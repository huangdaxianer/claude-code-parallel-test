/**
 * 任务详情模块
 * Task details fetching and model list rendering
 */
(function () {
    'use strict';

    window.App = window.App || {};

    /**
     * 获取任务详情
     */
    App.fetchTaskDetails = async function () {
        try {
            const data = await App.api.getTaskDetails(App.state.currentTaskId);

            // Start Global Task Heartbeat
            if (App.state.currentTaskId) {
                App.startTaskHeartbeat(App.state.currentTaskId);
            }

            if (!data.runs || data.runs.length === 0) {
                App.elements.modelListEl.innerHTML = '<div style="padding:1rem; color:#94a3b8; font-size:0.9rem;">正在启动任务...</div>';
                return;
            }

            // Initialize batch previews (Concurrent Start)
            if (App.preview && App.preview.initAll) {
                App.preview.initAll(data.runs);
            }

            // 合并新数据与现有日志
            if (App.state.currentRuns.length > 0) {
                const oldRunsMap = new Map(App.state.currentRuns.map(r => [r.folderName, r]));
                App.state.currentRuns = data.runs.map(newRun => {
                    const oldRun = oldRunsMap.get(newRun.folderName);
                    if (oldRun && oldRun.outputLog && !newRun.outputLog) {
                        newRun.outputLog = oldRun.outputLog;
                    }
                    return newRun;
                });
            } else {
                App.state.currentRuns = data.runs;
            }

            // 自动选择第一个
            if (!App.state.isStatsMode && !App.state.activeFolder && App.state.currentRuns.length > 0) {
                App.state.activeFolder = App.state.currentRuns[0].folderName;
            }

            // 更新 Prompt 显示
            const promptEl = document.getElementById('task-prompt-display');
            if (promptEl && data.prompt && promptEl.textContent !== data.prompt) {
                promptEl.textContent = data.prompt;
            }

            // 确保 activeFolder 存在
            const activeRunExists = App.state.currentRuns.find(r => r.folderName === App.state.activeFolder);
            if (!activeRunExists && App.state.currentRuns.length > 0 && !App.state.isStatsMode) {
                App.state.activeFolder = App.state.currentRuns[0].folderName;
            }

            // 渲染模型列表
            App.renderModelList();

            if (App.state.currentTaskId) {
                const statsView = document.getElementById('statistics-view');
                const comparisonView = document.getElementById('comparison-view');
                const mainContent = document.getElementById('main-content');

                if (App.state.isStatsMode) {
                    statsView.classList.add('active');
                    comparisonView.classList.remove('active');
                    mainContent.classList.add('hidden');
                    App.stats.renderStatisticsView();
                } else if (App.state.isCompareMode) {
                    comparisonView.classList.add('active');
                    statsView.classList.remove('active');
                    mainContent.classList.add('hidden');
                    App.compare.renderComparisonView();
                } else {
                    statsView.classList.remove('active');
                    comparisonView.classList.remove('active');
                    mainContent.classList.remove('hidden');

                    // Ensure UI reflects the active tab state
                    App.main.updateTabUI(App.state.activeTab || 'trajectory');

                    App.main.renderMainContent();
                }
                App.feedback.autoOpenFeedbackSidebar();
            }
        } catch (err) {
            console.error('Failed to fetch details:', err);
        }
    };

    /**
     * 渲染模型列表
     */
    App.renderModelList = function () {
        App.elements.modelListEl.innerHTML = '';

        // 统计按钮
        const statsBtn = document.createElement('div');
        statsBtn.className = `stats-btn ${App.state.isStatsMode ? 'active' : ''}`;
        statsBtn.innerHTML = `<span>📈</span> 数据统计`;
        statsBtn.onclick = () => {
            if (!App.state.isStatsMode) {
                App.toggleStatsMode();
                App.updateUrl(App.state.currentTaskId, 'stats');
            }
        };
        App.elements.modelListEl.appendChild(statsBtn);

        // 对比按钮
        const canCompare = App.state.currentRuns.some(r => r.previewable);
        if (canCompare) {
            const compareBtn = document.createElement('div');
            compareBtn.className = `compare-btn ${App.state.isCompareMode ? 'active' : ''}`;
            compareBtn.innerHTML = `<span>📊</span> 产物对比`;
            compareBtn.onclick = () => {
                if (!App.state.isCompareMode) {
                    App.toggleCompareMode();
                    App.updateUrl(App.state.currentTaskId, 'compare');
                }
            };
            App.elements.modelListEl.appendChild(compareBtn);
        }

        // 模型标签
        App.state.currentRuns.forEach(run => {
            const isSelected = !App.state.isCompareMode && !App.state.isStatsMode && run.folderName === App.state.activeFolder;

            const tab = document.createElement('div');
            tab.className = `model-tab ${isSelected ? 'active' : ''}`;
            tab.onclick = () => {
                if (App.state.activeFolder !== run.folderName) {
                    App.preview.cleanup(App.state.currentTaskId); // Stop heartbeat for the old preview, but keep backend alive if same task
                }

                App.state.isCompareMode = false;
                App.state.isStatsMode = false;
                App.state.activeFolder = run.folderName;

                // Reset to trajectory view when switching subtasks
                // Usage switchTab to handle UI updates, URL updates, and content rendering
                App.main.switchTab('trajectory');

                App.renderModelList();

                document.getElementById('comparison-view').classList.remove('active');
                document.getElementById('statistics-view').classList.remove('active');
                document.getElementById('main-content').classList.remove('hidden');

                App.elements.logDisplayEl.innerHTML = '<div class="empty-state"><p style="margin-top: 1rem; font-size: 0.9rem;">正在加载...</p></div>';
                App.elements.logDisplayEl.dataset.lineCount = '0';
                App.elements.logDisplayEl.dataset.renderedFolder = App.state.activeFolder;

                App.feedback.autoOpenFeedbackSidebar();
            };

            const displayName = App.utils.getModelDisplayName(run.modelName);

            tab.innerHTML = `
                <span class="status-dot status-${run.status || 'pending'}"></span>
                <span class="model-name-text">${displayName}</span>
            `;

            App.elements.modelListEl.appendChild(tab);
        });
    };

    /**
     * 切换统计模式
     */
    App.toggleStatsMode = function () {
        App.state.isStatsMode = !App.state.isStatsMode;
        App.state.isCompareMode = false;

        App.renderModelList();

        const statsView = document.getElementById('statistics-view');
        const comparisonView = document.getElementById('comparison-view');
        const mainContent = document.getElementById('main-content');

        if (App.state.isStatsMode) {
            statsView.classList.add('active');
            comparisonView.classList.remove('active');
            mainContent.classList.add('hidden');
            App.stats.renderStatisticsView();
        } else {
            statsView.classList.remove('active');
            mainContent.classList.remove('hidden');
            App.main.renderMainContent();
        }
    };

    /**
     * 切换对比模式
     */
    App.toggleCompareMode = function () {
        App.state.isCompareMode = !App.state.isCompareMode;
        App.state.isStatsMode = false;

        App.renderModelList();

        const statsView = document.getElementById('statistics-view');
        const comparisonView = document.getElementById('comparison-view');
        const mainContent = document.getElementById('main-content');

        if (App.state.isCompareMode) {
            comparisonView.classList.add('active');
            statsView.classList.remove('active');
            mainContent.classList.add('hidden');
            App.compare.renderComparisonView();
        } else {
            comparisonView.classList.remove('active');
            mainContent.classList.remove('hidden');
            App.main.renderMainContent();
        }
    };

    /**
     *Start task-level heartbeat
     */
    let taskHeartbeatInterval = null;
    App.startTaskHeartbeat = function (taskId) {
        if (taskHeartbeatInterval) clearInterval(taskHeartbeatInterval);

        const sendHeartbeat = () => {
            if (taskId) {
                fetch('/api/preview/heartbeat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ taskId: taskId })
                }).catch(e => console.error('Task heartbeat failed', e));
            }
        };

        sendHeartbeat();
        taskHeartbeatInterval = setInterval(sendHeartbeat, 3000); // Send every 3s
    };

    // Stop heartbeat when page unloads
    window.addEventListener('beforeunload', () => {
        if (taskHeartbeatInterval) clearInterval(taskHeartbeatInterval);
    });

})();
