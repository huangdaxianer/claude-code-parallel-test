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

    App.stats.renderStatisticsView = function () {
        const tbody = document.getElementById('stats-table-body');
        tbody.innerHTML = '';

        // 先停止旧的计时器
        stopDurationTimer();

        const translateStatus = (status) => {
            const map = {
                'pending': '排队中',
                'running': '运行中',
                'completed': '已完成',
                'evaluated': '已反馈',
                'stopped': '已中止'
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

            tr.innerHTML = `
                <td style="font-weight:600">${stats.modelName}</td>
                <td><span class="status-badge status-${stats.status}">${translateStatus(stats.status)}</span>${stopReasonHtml}</td>
                <td>${actionButtons}</td>
                ${durationHtml}
                <td>${formatVal(stats.turns, '0')}</td>
                <td>${formatVal(stats.toolCounts.TodoWrite, '0')}</td>
                <td>${formatVal(stats.toolCounts.Read, '0')}</td>
                <td>${formatVal(stats.toolCounts.Write, '0')}</td>
                <td>${formatVal(stats.toolCounts.Bash, '0')}</td>
                <td>${formatVal(stats.inputTokens)}</td>
                <td>${formatVal(stats.outputTokens)}</td>
                <td>${formatVal(stats.cacheReadTokens)}</td>
            `;
            tbody.appendChild(tr);
        });

        // 如果有运行中的任务，启动计时器
        if (hasRunning) {
            startDurationTimer();
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
                const btn = e.target.closest('.action-btn');
                if (!btn) return;

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
            });
            console.log('[StatsTable] Event delegation setup complete');
        }
    });

})();
