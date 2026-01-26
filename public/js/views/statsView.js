/**
 * 统计视图模块
 * Statistics view rendering
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.stats = {};

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
     * 渲染统计视图
     */
    App.stats.renderStatisticsView = function () {
        const tbody = document.getElementById('stats-table-body');
        tbody.innerHTML = '';

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

        App.state.currentRuns.forEach(run => {
            const stats = App.stats.calculateRunStats(run);

            let actionButtons = '';
            if (run.status === 'pending') {
                actionButtons = `<button class="btn-xs action-btn" data-action="start" data-model="${run.modelName}" style="background: #dcfce7; color: #166534; border:none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: 600;">启动</button>`;
            } else if (run.status === 'stopped') {
                actionButtons = `<button class="btn-xs action-btn" data-action="start" data-model="${run.modelName}" style="background: #dcfce7; color: #166534; border:none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: 600;">重启</button>`;
            } else if (run.status === 'running') {
                actionButtons = `<button class="btn-xs action-btn" data-action="stop" data-model="${run.modelName}" style="background: #ffedd5; color: #9a3412; border:none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: 600;">中止</button>`;
            } else if (run.status === 'completed' && (run.previewable === 'static' || run.previewable === 'dynamic')) {
                actionButtons = `<button class="btn-xs action-btn" data-action="preview" data-model="${run.modelName}" style="background: #dbeafe; color: #1e40af; border:none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: 600;">预览</button>`;
            }

            const tr = document.createElement('tr');
            const isPending = run.status === 'pending';

            const formatVal = (val, fallback = '-') => {
                if (isPending) return '';
                if (val === null || val === undefined) return fallback;
                return val;
            };

            tr.innerHTML = `
                <td style="font-weight:600">${stats.modelName}</td>
                <td><span class="status-badge status-${stats.status}">${translateStatus(stats.status)}</span></td>
                <td>${actionButtons}</td>
                <td>${formatVal(stats.duration)}</td>
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
    };

    /**
     * 控制任务
     */
    App.stats.controlTask = async function (action, modelName) {
        if (!App.state.currentTaskId) {
            console.log('[controlTask] No currentTaskId');
            return;
        }

        console.log(`[controlTask] Action: ${action}, TaskId: ${App.state.currentTaskId}, Model: ${modelName}`);

        try {
            const data = await App.api.controlTask(App.state.currentTaskId, action, modelName);
            console.log(`[controlTask] Response:`, data);
            if (data.error) {
                alert(data.error);
            } else {
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
    App.stats.previewFromStats = function (modelName) {
        App.state.isStatsMode = false;
        App.loadTask(App.state.currentTaskId, true, modelName);
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
                const model = btn.dataset.model;
                console.log('[StatsTable] Button clicked, action:', action, 'model:', model);

                if (action === 'preview') {
                    if (model) App.stats.previewFromStats(model);
                } else if (action === 'start' || action === 'stop') {
                    App.stats.controlTask(action, model);
                }
            });
            console.log('[StatsTable] Event delegation setup complete');
        }
    });

})();
