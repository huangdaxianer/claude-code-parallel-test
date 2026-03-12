/**
 * 统计视图模块
 * Statistics view rendering
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.stats = {};

    // 运行中任务的计时器
    let durationTimerId = null;

    // 缓存 enabledModels，避免每次轮询都重新请求导致未启动行闪烁
    let cachedEnabledModels = null;

    // 记住展开状态的 runId 集合（轮询刷新不丢失）
    const expandedRunIds = new Set();
    // 缓存已加载的请求数据 { runId: requests[] }
    const requestsCache = {};

    /**
     * 格式化秒数为可读字符串
     * < 60s: 显示秒 (如 "45")
     * >= 60s: 显示 分:秒 (如 "2:05")
     * >= 3600s: 显示 时:分:秒 (如 "1:02:05")
     */
    function formatDuration(totalSeconds) {
        if (totalSeconds < 60) {
            return `${Math.floor(totalSeconds)}`;
        }
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60);
        if (hours > 0) {
            return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }
        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    /**
     * 计算运行统计
     */
    App.stats.calculateRunStats = function (run) {
        const stats = {
            modelName: App.utils.getModelDisplayName(run.modelName),
            status: run.status || 'pending',
            duration: 0,
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            toolCounts: {
                TodoWrite: 0,
                Read: 0,
                Write: 0,
                Bash: 0
            }
        };

        // 使用后端预计算的统计
        if (run.stats) {
            return { ...stats, ...run.stats };
        }

        if (!run.outputLog) return stats;

        const rawContent = run.outputLog || '';
        const formattedContent = rawContent.replace(/}\s*{/g, '}\n{');
        const lines = formattedContent.split(/\r\n|\n|\r/);

        lines.forEach(line => {
            if (!line.trim()) return;
            try {
                if (!line.trim().startsWith('{')) return;
                const obj = JSON.parse(line);

                if (obj.type === 'result') {
                    if (obj.duration_ms) {
                        stats.duration = (obj.duration_ms / 1000).toFixed(1);
                    } else if (obj.duration) {
                        stats.duration = (obj.duration / 1000).toFixed(1);
                    }

                    if (obj.usage) {
                        stats.inputTokens = obj.usage.input_tokens || 0;
                        stats.outputTokens = obj.usage.output_tokens || 0;
                        stats.cacheReadTokens = obj.usage.cache_read_input_tokens || 0;
                    } else if (obj.tokenUsage) {
                        stats.inputTokens = obj.tokenUsage.input || obj.tokenUsage.input_tokens || 0;
                        stats.outputTokens = obj.tokenUsage.output || obj.tokenUsage.output_tokens || 0;
                        stats.cacheReadTokens = obj.tokenUsage.cacheRead || obj.tokenUsage.cache_read_input_tokens || 0;
                    }
                }

                if (obj.type === 'user') {
                    stats.turns++;
                }

                if (obj.type === 'tool_use') {
                    const name = obj.name;
                    if (stats.toolCounts.hasOwnProperty(name)) {
                        stats.toolCounts[name]++;
                    }
                }

                if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
                    obj.message.content.forEach(block => {
                        if (block.type === 'tool_use') {
                            const name = block.name;
                            if (stats.toolCounts.hasOwnProperty(name)) {
                                stats.toolCounts[name]++;
                            }
                        }
                    });
                }

            } catch (e) { }
        });

        return stats;
    };

    /**
     * 更新运行中任务的耗时显示
     */
    function updateRunningDurations() {
        const cells = document.querySelectorAll('td[data-started-at]');
        if (cells.length === 0) {
            stopDurationTimer();
            return;
        }
        const now = Date.now();
        cells.forEach(cell => {
            const startedAt = cell.dataset.startedAt;
            if (!startedAt) return;
            const elapsed = (now - new Date(startedAt + 'Z').getTime()) / 1000;
            if (elapsed >= 0) {
                cell.textContent = formatDuration(elapsed);
            }
        });
    }

    /**
     * 启动耗时计时器
     */
    function startDurationTimer() {
        if (durationTimerId) return;
        durationTimerId = setInterval(updateRunningDurations, 1000);
    }

    /**
     * 停止耗时计时器
     */
    function stopDurationTimer() {
        if (durationTimerId) {
            clearInterval(durationTimerId);
            durationTimerId = null;
        }
    }

    // 对外暴露停止方法，供切换视图时调用
    App.stats.stopDurationTimer = stopDurationTimer;

    /**
     * 渲染统计视图
     */
    /**
     * 将 stop_reason 翻译为用户友好的中文描述
     */
    function translateStopReason(reason) {
        const map = {
            'activity_timeout': '模型长时间未响应',
            'wall_clock_timeout': '总执行时间过长',
            'manual_stop': '手动中止',
            'is_error': '模型响应异常（返回错误）',
            'abnormal_completion': '任务执行中断（最后一轮输出非文本）',
            'process_error': '进程启动失败',
            'non_zero_exit': '进程异常退出',
            'orphaned': '进程意外丢失',
            'server_restart': '服务器重启'
        };
        return map[reason] || '未知原因';
    }

    /**
     * 构建停止原因的 tooltip HTML
     */
    function buildStopReasonTooltip(run) {
        if (run.status !== 'stopped' || !run.stopReason) return '';
        const reasonText = translateStopReason(run.stopReason);
        const retryCount = run.retryCount || 0;
        let tooltipText = `任务由于「${reasonText}」中止`;
        if (retryCount > 0) {
            tooltipText += `，已重试 ${retryCount} 次`;
        }
        return `<span class="stop-reason-icon" data-tooltip="${tooltipText.replace(/"/g, '&quot;')}">&#8505;</span>`;
    }

    /**
     * 渲染请求详情子行
     */
    function renderDetailRows(parentTr, runId, requests, colCount) {
        const detailTr = document.createElement('tr');
        detailTr.classList.add('api-detail-row');
        detailTr.dataset.detailFor = runId;
        const td = document.createElement('td');
        td.setAttribute('colspan', colCount);

        let tableHtml = `<table class="api-detail-inner">
            <thead><tr>
                <th style="text-align:center">#</th>
                <th>Input</th>
                <th>Output</th>
                <th>Cache Read</th>
                <th>TTFT</th>
                <th>TPOT</th>
                <th>耗时</th>
            </tr></thead><tbody>`;

        requests.forEach(r => {
            const ttft = r.ttft_ms != null ? Math.round(r.ttft_ms) + 'ms' : '-';
            const tpot = r.tpot_ms != null ? (Math.round(r.tpot_ms * 10) / 10) + 'ms' : '-';
            const dur = r.duration_ms != null ? formatDuration(r.duration_ms / 1000) : '-';
            tableHtml += `<tr>
                <td style="text-align:center; color:#94a3b8">${r.request_index}</td>
                <td>${r.input_tokens || 0}</td>
                <td>${r.output_tokens || 0}</td>
                <td>${r.cache_read_tokens || 0}</td>
                <td>${ttft}</td>
                <td>${tpot}</td>
                <td>${dur}</td>
            </tr>`;
        });

        tableHtml += '</tbody></table>';
        td.innerHTML = tableHtml;
        detailTr.appendChild(td);
        parentTr.after(detailTr);
    }

    /**
     * 移除某个 runId 的详情子行
     */
    function removeDetailRows(runId) {
        document.querySelectorAll(`tr.api-detail-row[data-detail-for="${runId}"]`).forEach(r => r.remove());
    }

    /**
     * 切换展开/收起
     */
    async function toggleRunDetail(tr) {
        const runId = tr.dataset.runId;
        if (!runId) return;

        if (expandedRunIds.has(runId)) {
            // 收起
            expandedRunIds.delete(runId);
            tr.classList.remove('expanded');
            removeDetailRows(runId);
        } else {
            // 展开
            expandedRunIds.add(runId);
            tr.classList.add('expanded');
            const colCount = tr.children.length;

            if (requestsCache[runId]) {
                renderDetailRows(tr, runId, requestsCache[runId], colCount);
            } else {
                // 先显示 loading 行
                const loadingTr = document.createElement('tr');
                loadingTr.classList.add('api-detail-row');
                loadingTr.dataset.detailFor = runId;
                loadingTr.innerHTML = `<td colspan="${colCount}" style="text-align:center; padding:8px; color:#94a3b8; background:#f8fafc;">加载中...</td>`;
                tr.after(loadingTr);

                try {
                    const data = await App.api.getApiRequests(runId);
                    requestsCache[runId] = data.requests || [];
                    removeDetailRows(runId);
                    if (expandedRunIds.has(runId)) {
                        renderDetailRows(tr, runId, requestsCache[runId], colCount);
                    }
                } catch (e) {
                    console.error('[Stats] Failed to fetch API requests:', e);
                    removeDetailRows(runId);
                    expandedRunIds.delete(runId);
                    tr.classList.remove('expanded');
                }
            }
        }
    }

    App.stats.renderStatisticsView = async function () {
        const tbody = document.getElementById('stats-table-body');

        // 先停止旧的计时器
        stopDurationTimer();

        // 使用缓存的 enabledModels，避免每次轮询都异步请求导致未启动行闪烁。
        // 首次加载或缓存为空时同步等待，后续在后台静默刷新缓存。
        if (!cachedEnabledModels) {
            try {
                cachedEnabledModels = await App.api.getEnabledModels();
            } catch (e) {
                console.error('[Stats] Failed to fetch enabled models:', e);
                cachedEnabledModels = [];
            }
        } else {
            // 后台静默刷新缓存，不阻塞渲染
            App.api.getEnabledModels().then(models => {
                cachedEnabledModels = models;
            }).catch(() => {});
        }
        const enabledModels = cachedEnabledModels;

        tbody.innerHTML = '';

        // 管理员列显隐控制
        const isAdmin = App.state.currentUser && App.state.currentUser.role === 'admin';
        document.querySelectorAll('.stats-table th.admin-only').forEach(th => {
            th.style.display = isAdmin ? '' : 'none';
        });

        const translateStatus = (status) => {
            const map = {
                'pending': '排队中',
                'running': '运行中',
                'completed': '已完成',
                'evaluated': '已反馈',
                'stopped': '已中止',
                'not_started': '未启动'
            };
            return map[status] || status;
        };

        let hasRunning = false;

        App.state.currentRuns.forEach(run => {
            const stats = App.stats.calculateRunStats(run);

            let actionButtons = '';
            // Use modelId for API calls, but modelName for display
            if (run.status === 'pending') {
                // 排队中的任务不显示操作按钮
                actionButtons = '';
            } else if (run.status === 'stopped') {
                actionButtons = `<button class="btn-xs action-btn" data-action="start" data-model-id="${run.modelId}" style="background: #dcfce7; color: #166534; border:none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: 600;">重启</button>`;
            } else if (run.status === 'running') {
                actionButtons = `<button class="btn-xs action-btn" data-action="stop" data-model-id="${run.modelId}" style="background: #ffedd5; color: #9a3412; border:none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: 600;">中止</button>`;
            } else if (run.status === 'completed' || run.status === 'evaluated') {
                actionButtons = `<button class="btn-xs action-btn" data-action="start" data-model-id="${run.modelId}" style="background: #dcfce7; color: #166534; border:none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: 600;">重启</button>`;
            }

            const tr = document.createElement('tr');
            const isPending = run.status === 'pending';

            // admin 可展开（非 pending 行）
            if (isAdmin && !isPending && run.runId) {
                tr.classList.add('clickable-row');
                tr.dataset.runId = run.runId;
                if (expandedRunIds.has(String(run.runId))) {
                    tr.classList.add('expanded');
                }
            }

            const formatVal = (val, fallback = '-') => {
                if (isPending) return '';
                if (val === null || val === undefined) return fallback;
                return val;
            };

            // 耗时显示逻辑：
            // - 运行中且有 startedAt：实时计算并显示
            // - 已完成/已中止且有 duration：显示最终耗时
            // - 其他：显示 '-'
            let durationHtml;
            if (run.status === 'running' && stats.startedAt) {
                hasRunning = true;
                const elapsed = (Date.now() - new Date(stats.startedAt + 'Z').getTime()) / 1000;
                const display = elapsed >= 0 ? formatDuration(elapsed) : '-';
                durationHtml = `<td data-started-at="${stats.startedAt}">${display}</td>`;
            } else if (stats.duration && stats.duration > 0) {
                durationHtml = `<td>${formatDuration(Number(stats.duration))}</td>`;
            } else {
                durationHtml = `<td>${formatVal(null)}</td>`;
            }

            // 停止原因 tooltip
            const stopReasonHtml = buildStopReasonTooltip(run);

            // 模型名称前的展开箭头（仅 admin 且非 pending）
            const chevron = (isAdmin && !isPending && run.runId)
                ? '<span class="expand-chevron">&#9654;</span>'
                : '';

            // TTFT/TPOT 列（仅 admin 可见）
            let adminCols = '';
            if (isAdmin) {
                const m = run.apiMetrics;
                if (m && m.avgTtft != null) {
                    const ttftTooltip = `min: ${m.minTtft}ms / max: ${m.maxTtft}ms / ${m.mainRequests} 次请求`;
                    const tpotTooltip = m.avgTpot != null ? `min: ${m.minTpot}ms / max: ${m.maxTpot}ms` : '';
                    adminCols = `
                        <td class="admin-only" title="${ttftTooltip}">${m.avgTtft}ms</td>
                        <td class="admin-only" title="${tpotTooltip}">${m.avgTpot != null ? m.avgTpot + 'ms' : '-'}</td>
                    `;
                } else {
                    adminCols = `<td class="admin-only">${formatVal(null)}</td><td class="admin-only">${formatVal(null)}</td>`;
                }
            }

            tr.innerHTML = `
                <td style="font-weight:600">${chevron}${stats.modelName}</td>
                <td><span class="status-badge status-${stats.status}">${translateStatus(stats.status)}</span>${stopReasonHtml}</td>
                <td>${actionButtons}</td>
                ${durationHtml}
                <td>${formatVal(stats.turns, '0')}</td>
                <td>${formatVal(stats.toolCounts.TodoWrite, '0')}</td>
                <td>${formatVal(stats.toolCounts.Read, '0')}</td>
                <td>${formatVal(stats.toolCounts.Write, '0')}</td>
                <td>${formatVal(stats.toolCounts.Bash, '0')}</td>
                <td>${formatVal(stats.inputTokens != null ? (stats.inputTokens || 0) + (stats.cacheReadTokens || 0) : null)}</td>
                <td>${formatVal(stats.outputTokens)}</td>
                <td>${formatVal(stats.cacheReadTokens)}</td>
                ${adminCols}
            `;
            tbody.appendChild(tr);

            // 如果之前展开过，自动恢复展开状态
            if (run.runId && expandedRunIds.has(String(run.runId)) && requestsCache[run.runId]) {
                renderDetailRows(tr, run.runId, requestsCache[run.runId], tr.children.length);
            }
        });

        // 如果有运行中的任务，启动计时器
        if (hasRunning) {
            startDurationTimer();
        }

        // 显示未启动的模型（enabledModels 已在清空 DOM 前预先获取）
        if (enabledModels.length > 0) {
            const existingModelIds = new Set(App.state.currentRuns.map(r => r.modelId));
            const unstartedModels = enabledModels.filter(m => !existingModelIds.has(m.id));

            // 更新 modelDisplayNames 缓存
            enabledModels.forEach(model => {
                App.state.modelDisplayNames[model.name] = model.displayName || model.name;
            });

            unstartedModels.forEach(model => {
                const tr = document.createElement('tr');
                tr.style.opacity = '0.6';
                const displayName = model.displayName || model.name;

                tr.innerHTML = `
                    <td style="font-weight:600">${displayName}</td>
                    <td><span class="status-badge status-not-started">${translateStatus('not_started')}</span></td>
                    <td><button class="btn-xs action-btn" data-action="start" data-model-id="${model.id}"
                        style="background: #dbeafe; color: #1e40af; border:none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: 600;">启动</button></td>
                    <td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>
                    ${isAdmin ? '<td class="admin-only"></td><td class="admin-only"></td>' : ''}
                `;
                tbody.appendChild(tr);
            });
        }
    };

    /**
     * 控制任务
     */
    App.stats.controlTask = async function (action, modelId) {
        if (!App.state.currentTaskId) {
            console.log('[controlTask] No currentTaskId');
            return;
        }

        console.log(`[controlTask] Action: ${action}, TaskId: ${App.state.currentTaskId}, ModelId: ${modelId}`);

        try {
            const data = await App.api.controlTask(App.state.currentTaskId, action, modelId);
            console.log(`[controlTask] Response:`, data);
            if (data.error) {
                alert(data.error);
            } else {
                // Restore high-frequency polling after restart/start action
                if (action === 'start' && App.adjustPollingInterval) {
                    App.adjustPollingInterval(3000);
                }
                App.fetchTaskDetails();
            }
        } catch (e) {
            console.error(`[controlTask] Error:`, e);
            alert(`操作失败: ${e.message}`);
        }
    };

    /**
     * 从统计视图预览
     */
    App.stats.previewFromStats = function (modelId) {
        App.state.isStatsMode = false;
        App.loadTask(App.state.currentTaskId, true, modelId, 'preview');
    };

    // 全局快捷方式
    window.controlTask = App.stats.controlTask;
    window.previewFromStats = App.stats.previewFromStats;

    // 事件委托
    document.addEventListener('DOMContentLoaded', () => {
        const tbody = document.getElementById('stats-table-body');
        if (tbody) {
            tbody.addEventListener('click', (e) => {
                // 按钮点击优先处理
                const btn = e.target.closest('.action-btn');
                if (btn) {
                    e.preventDefault();
                    e.stopPropagation();

                    const action = btn.dataset.action;
                    const modelId = btn.dataset.modelId;
                    console.log('[StatsTable] Button clicked, action:', action, 'modelId:', modelId);

                    if (action === 'preview') {
                        if (modelId) App.stats.previewFromStats(modelId);
                    } else if (action === 'start' || action === 'stop') {
                        App.stats.controlTask(action, modelId);
                    }
                    return;
                }

                // 行点击展开/收起（仅 admin）
                const tr = e.target.closest('tr.clickable-row');
                if (tr && tr.dataset.runId) {
                    toggleRunDetail(tr);
                }
            });
            console.log('[StatsTable] Event delegation setup complete');
        }
    });

})();
