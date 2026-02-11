/**
 * 对比视图模块
 * Comparison view rendering with preview status bars
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.compare = {};

    // Per-side poll timers and meta
    const cmpPolls = { left: null, right: null };
    const cmpMeta = { left: {}, right: {} };
    let cmpHeartbeatInterval = null;

    function getCmpEls(side) {
        return {
            iframe: document.getElementById(`iframe-${side}`),
            statusBar: document.getElementById(`cmp-status-bar-${side}`),
            statusDot: document.getElementById(`cmp-status-dot-${side}`),
            statusText: document.getElementById(`cmp-status-text-${side}`),
            fullscreenBtn: document.getElementById(`cmp-fullscreen-${side}`),
            logsDiv: document.getElementById(`cmp-logs-${side}`),
            emptyState: document.getElementById(`empty-${side}`)
        };
    }

    function escapeHtml(text) {
        if (typeof text !== 'string') return text;
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    function showCmpFailure(side, logs) {
        const els = getCmpEls(side);
        els.statusBar.style.display = 'flex';
        els.statusDot.className = 'cmp-status-dot failed';
        els.statusText.innerHTML = '预览启动失败 <span class="preview-info-tip" data-tip="预览失败可能是因为产物代码有问题，也有可能是在线环境问题，建议下载产物后在本地运行">i</span>';
        els.fullscreenBtn.style.display = 'none';
        els.iframe.style.display = 'none';
        els.iframe.removeAttribute('src');
        els.emptyState.style.display = 'none';
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

    function showCmpReady(side, url) {
        const els = getCmpEls(side);
        els.statusBar.style.display = 'flex';
        els.statusDot.className = 'cmp-status-dot success';
        els.statusText.textContent = '预览运行中';
        els.fullscreenBtn.style.display = 'flex';
        els.fullscreenBtn.setAttribute('data-url', url);
        els.logsDiv.style.display = 'none';
        els.emptyState.style.display = 'none';
        els.iframe.removeAttribute('srcdoc');
        els.iframe.src = url;
        els.iframe.style.display = 'block';
    }

    function startCmpPreview(side, taskId, modelId) {
        const els = getCmpEls(side);

        // Clear old poll
        if (cmpPolls[side]) {
            clearInterval(cmpPolls[side]);
            cmpPolls[side] = null;
        }

        // Store meta
        cmpMeta[side] = { taskId, modelId };

        // Show starting state
        els.statusBar.style.display = 'flex';
        els.statusDot.className = 'cmp-status-dot starting';
        els.statusText.textContent = '预览服务启动中';
        els.fullscreenBtn.style.display = 'none';
        els.iframe.style.display = 'none';
        els.iframe.removeAttribute('src');
        els.emptyState.style.display = 'none';
        els.logsDiv.style.display = 'block';
        els.logsDiv.innerHTML = '<div style="color:#9ca3af;padding:0.5rem;">等待服务响应...</div>';

        // Start heartbeat for this side
        startCmpHeartbeat();

        // Call API
        (async () => {
            try {
                const res = await fetch('/api/preview/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ taskId, modelId })
                });
                const data = await res.json();
                if (data.status === 'ready' && data.url) {
                    showCmpReady(side, data.url);
                } else if (data.url) {
                    pollCmpStatus(side, taskId, modelId, data.url);
                } else {
                    showCmpFailure(side, [{ msg: '服务未返回预览地址', ts: Date.now() }]);
                }
            } catch (e) {
                showCmpFailure(side, [{ msg: `API Error: ${e.message}`, ts: Date.now() }]);
            }
        })();
    }

    function pollCmpStatus(side, taskId, modelId, url) {
        const els = getCmpEls(side);
        if (cmpPolls[side]) clearInterval(cmpPolls[side]);

        cmpPolls[side] = setInterval(async () => {
            try {
                const res = await fetch(`/api/preview/status/${taskId}/${modelId}`);
                const data = await res.json();

                // Update logs
                if (data.logs && data.logs.length > 0) {
                    els.logsDiv.innerHTML = data.logs.map(l =>
                        `<div style="margin-bottom:2px;"><span style="color:#6b7280;margin-right:4px;">[${new Date(l.ts).toLocaleTimeString()}]</span>${escapeHtml(l.msg)}</div>`
                    ).join('');
                    els.logsDiv.scrollTop = els.logsDiv.scrollHeight;
                }

                if (data.status === 'ready') {
                    clearInterval(cmpPolls[side]);
                    cmpPolls[side] = null;
                    showCmpReady(side, url);
                    return;
                }

                if (data.status === 'error' || data.status === 'not_running') {
                    clearInterval(cmpPolls[side]);
                    cmpPolls[side] = null;
                    showCmpFailure(side, data.logs || []);
                    return;
                }

                if (data.logs && data.logs.length > 0) {
                    const lastLog = data.logs[data.logs.length - 1];
                    if (lastLog.msg && lastLog.msg.includes('Preview not running')) {
                        clearInterval(cmpPolls[side]);
                        cmpPolls[side] = null;
                        showCmpFailure(side, data.logs);
                        return;
                    }
                }
            } catch (e) {
                clearInterval(cmpPolls[side]);
                cmpPolls[side] = null;
                showCmpFailure(side, [{ msg: `状态检查失败: ${e.message}`, ts: Date.now() }]);
            }
        }, 1000);
    }

    function startCmpHeartbeat() {
        if (cmpHeartbeatInterval) return; // Already running
        cmpHeartbeatInterval = setInterval(() => {
            ['left', 'right'].forEach(side => {
                const meta = cmpMeta[side];
                if (meta && meta.taskId && meta.modelId) {
                    fetch('/api/preview/heartbeat', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ taskId: meta.taskId, modelId: meta.modelId })
                    }).catch(() => {});
                }
            });
        }, 2000);
        // Send immediately
        ['left', 'right'].forEach(side => {
            const meta = cmpMeta[side];
            if (meta && meta.taskId && meta.modelId) {
                fetch('/api/preview/heartbeat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ taskId: meta.taskId, modelId: meta.modelId })
                }).catch(() => {});
            }
        });
    }

    App.compare.restartPreview = function (side) {
        const meta = cmpMeta[side];
        if (meta && meta.taskId && meta.modelId) {
            startCmpPreview(side, meta.taskId, meta.modelId);
        }
    };

    App.compare.openFullscreen = function (side) {
        const btn = document.getElementById(`cmp-fullscreen-${side}`);
        const url = btn && btn.getAttribute('data-url');
        if (url) window.open(url, '_blank');
    };

    /**
     * 渲染对比视图
     */
    App.compare.renderComparisonView = function () {
        const runs = App.state.currentRuns || [];
        if (runs.length === 0) return;

        const previewableRuns = runs.filter(run => {
            return run.previewable === 'static' || run.previewable === 'dynamic';
        });

        if (previewableRuns.length === 0) return;

        const isSingleMode = previewableRuns.length === 1;

        const leftExists = previewableRuns.some(r => r.folderName === App.state.compareLeftRun);
        const rightExists = previewableRuns.some(r => r.folderName === App.state.compareRightRun);

        if (!leftExists) App.state.compareLeftRun = null;
        if (!rightExists) App.state.compareRightRun = null;

        if (isSingleMode) {
            App.state.compareLeftRun = previewableRuns[0].folderName;
            App.state.compareRightRun = null;
        } else {
            if (!App.state.compareLeftRun && previewableRuns.length > 0) {
                App.state.compareLeftRun = previewableRuns[0].folderName;
            }
            if (!App.state.compareRightRun && previewableRuns.length > 0) {
                if (previewableRuns.length > 1) {
                    const secondRun = previewableRuns[1];
                    if (secondRun.folderName !== App.state.compareLeftRun) {
                        App.state.compareRightRun = secondRun.folderName;
                    } else {
                        App.state.compareRightRun = previewableRuns[0].folderName;
                    }
                } else {
                    App.state.compareRightRun = previewableRuns[0].folderName;
                }
            }

            if (App.state.compareLeftRun === App.state.compareRightRun && previewableRuns.length > 1) {
                const other = previewableRuns.find(r => r.folderName !== App.state.compareLeftRun);
                if (other) App.state.compareRightRun = other.folderName;
            }
        }

        const rightPanel = document.getElementById('comparison-right');
        if (rightPanel) {
            rightPanel.style.display = isSingleMode ? 'none' : 'flex';
        }

        App.compare.updateComparisonSide('left');
        if (!isSingleMode) {
            App.compare.updateComparisonSide('right');
        }
    };

    /**
     * 更新对比面板
     */
    App.compare.updateComparisonPanel = function (side, folderName) {
        if (side === 'left') App.state.compareLeftRun = folderName;
        else App.state.compareRightRun = folderName;

        App.compare.renderComparisonView();
    };

    /**
     * 更新对比侧边
     */
    App.compare.updateComparisonSide = function (side) {
        const container = document.getElementById(`select-${side}`);
        const statusBadge = document.getElementById(`status-${side}`);
        const iframe = document.getElementById(`iframe-${side}`);
        const emptyState = document.getElementById(`empty-${side}`);
        const els = getCmpEls(side);

        const currentTarget = (side === 'left') ? App.state.compareLeftRun : App.state.compareRightRun;
        const otherTarget = (side === 'left') ? App.state.compareRightRun : App.state.compareLeftRun;

        App.compare.syncModelTabs(container, App.state.currentRuns, side, currentTarget, otherTarget);

        const previewableRuns = App.state.currentRuns.filter(run => {
            return run.previewable === 'static' || run.previewable === 'dynamic';
        });

        let activeRun = currentTarget ? previewableRuns.find(r => r.folderName === currentTarget) : null;

        if (!activeRun) {
            iframe.style.display = 'none';
            iframe.dataset.src = '';
            emptyState.style.display = 'flex';
            emptyState.innerHTML = '<p>无可用预览</p>';
            statusBadge.style.display = 'none';
            els.statusBar.style.display = 'none';
            els.logsDiv.style.display = 'none';
            return;
        }

        // Hide old status badge (replaced by our status bar)
        statusBadge.style.display = 'none';

        const htmlFile = (activeRun.generatedFiles || []).find(f => f.endsWith('.html'));
        const packageJson = (activeRun.generatedFiles || []).find(f => f === 'package.json');
        const hasPreview = activeRun.previewable || htmlFile || packageJson;

        if (hasPreview) {
            emptyState.style.display = 'none';

            const runId = activeRun.folderName;
            if (iframe.dataset.runId !== runId) {
                iframe.dataset.runId = runId;
                const parts = runId.split('/');
                startCmpPreview(side, parts[0], parts[1]);
            }
        } else {
            iframe.style.display = 'none';
            iframe.dataset.src = '';
            els.statusBar.style.display = 'none';
            els.logsDiv.style.display = 'none';
            emptyState.style.display = 'flex';
            const statusMap = { 'pending': '排队中', 'running': '运行中', 'completed': '已完成', 'evaluated': '已评价', 'stopped': '已中止' };
            emptyState.innerHTML = `<p>暂无预览<br><span style="font-size:0.8em;color:#cbd5e1;">${statusMap[activeRun.status] || activeRun.status}</span></p>`;
        }
    };

    /**
     * 同步模型选项卡
     */
    App.compare.syncModelTabs = function (container, runs, side, currentTarget, otherTarget) {
        const previewableRuns = runs.filter(run => {
            return run.previewable === 'static' || run.previewable === 'dynamic';
        });

        container.innerHTML = '';

        if (previewableRuns.length === 0) {
            container.innerHTML = '<span style="font-size:0.85rem; color:#94a3b8;">无可用项</span>';
            return;
        }

        previewableRuns.forEach(run => {
            const btn = document.createElement('div');
            const isSelected = run.folderName === currentTarget;
            const isDisabled = run.folderName === otherTarget;

            let classes = ['comparison-model-tab'];
            if (isSelected) classes.push('active');
            if (isDisabled) classes.push('disabled');

            btn.className = classes.join(' ');
            btn.innerHTML = `<span>${App.utils.getModelDisplayName(run.modelName)}</span>`;

            if (!isDisabled && !isSelected) {
                btn.onclick = () => {
                    App.compare.updateComparisonPanel(side, run.folderName);
                };
            }

            container.appendChild(btn);
        });
    };

    // 全局快捷方式
    window.updateComparisonPanel = App.compare.updateComparisonPanel;

})();
