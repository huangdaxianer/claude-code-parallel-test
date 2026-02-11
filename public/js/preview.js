/**
 * 预览模块
 * Preview functionality with Claude Code integration
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.preview = {};

    let currentTaskId = null;
    let currentModelId = null;
    let countdownInterval = null;
    let pollInterval = null;
    let heartbeatInterval = null;
    let lastLogMsg = null;
    let lastProgress = 0;

    /**
     * 批量初始化预览
     * 尝试为列表中的所有任务启动预览
     */
    App.preview.initAll = async function (runs) {
        if (!runs || runs.length === 0) return;

        console.log('[Preview] Initializing batch previews for', runs.length, 'runs');

        // 这里的 taskId 应该是统一的
        const taskId = runs[0].taskId || (runs[0].folderName ? runs[0].folderName.split('/')[0] : null);

        if (!taskId) return;

        // 并发启动所有预览
        // 使用 fire-and-forget 模式，不阻塞主流程
        runs.forEach(async (run) => {
            if (!run.previewable) {
                console.log(`[Preview] Skipping non-previewable run: ${run.modelId}`);
                return;
            }

            // Only auto-start if completed
            if (run.status !== 'completed') {
                console.log(`[Preview] Skipping incomplete run: ${run.modelId} (${run.status})`);
                return;
            }

            const modelId = run.modelId;
            if (!modelId) return;

            try {
                // Check status first
                const startRes = await App.api.getPreviewStatus(taskId, modelId);
                if (startRes && (startRes.status === 'starting' || startRes.status === 'ready')) {
                    console.log(`[Preview] ${modelId} already running/starting.`);
                    return;
                }

                // If not running, start it
                console.log(`[Preview] Auto-starting preview for ${modelId}`);
                await App.api.startPreview(taskId, modelId);
            } catch (e) {
                console.warn(`[Preview] Failed to auto-start ${modelId}:`, e);
            }
        });
    };

    /**
     * 加载预览
     */
    App.preview.loadPreview = async function (taskId, modelId, iframe, container) {
        if (!taskId || !modelId) return;

        // 如果正在加载同一个，则不重复加载
        if (currentTaskId === taskId && currentModelId === modelId && pollInterval) {
            return;
        }

        // 清理旧的 (尝试保留相同任务的进程)
        await App.preview.cleanup(taskId);

        currentTaskId = taskId;
        currentModelId = modelId;
        lastLogMsg = null;
        lastProgress = 0;

        // 状态栏元素
        const statusBar = document.getElementById('preview-status-bar');
        const statusDot = document.getElementById('preview-status-dot');
        const statusText = document.getElementById('preview-status-text');
        const urlDisplay = document.getElementById('preview-url-display');
        const progressDiv = document.getElementById('preview-progress');
        const countdownEl = document.getElementById('preview-countdown');

        // Fast Path: Check if already running before showing loading UI
        try {
            const preCheck = await App.api.getPreviewStatus(taskId, modelId);
            if (preCheck && preCheck.status === 'ready' && preCheck.url) {
                console.log('[Preview] Fast path: Service ready, skipping loading UI');

                // Ensure heartbeat is monitoring this
                if (!heartbeatInterval) {
                    const sendHeartbeat = () => {
                        const taskIdToSend = taskId || currentTaskId;
                        const modelIdToSend = modelId || currentModelId;
                        if (taskIdToSend && modelIdToSend) {
                            fetch('/api/preview/heartbeat', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ taskId: taskIdToSend, modelId: modelIdToSend })
                            }).catch(console.error);
                        }
                    };
                    sendHeartbeat();
                    heartbeatInterval = setInterval(sendHeartbeat, 2000);
                }

                if (iframe.getAttribute('data-src') !== preCheck.url) {
                    iframe.src = preCheck.url;
                    iframe.setAttribute('data-src', preCheck.url);
                }
                iframe.style.display = 'block';

                if (statusBar) {
                    statusBar.style.display = 'flex';
                    statusBar.style.background = '#f8fafc';
                    statusBar.style.borderBottomColor = '#e2e8f0';
                    statusDot.className = 'status-dot status-success';
                    statusText.textContent = '预览运行中';
                    urlDisplay.setAttribute('data-url', preCheck.url);
                    if (urlDisplay) urlDisplay.style.display = 'flex';
                }
                if (progressDiv) progressDiv.style.display = 'none';
                return;
            }
        } catch (e) {
            // Ignore fast path errors
        }

        // 显示状态栏：蓝色指示灯 + "预览服务启动中"
        if (statusBar) {
            statusBar.style.display = 'flex';
            statusBar.style.background = '#f8fafc';
            statusBar.style.borderBottomColor = '#e2e8f0';
            statusDot.className = 'status-dot status-starting'; // Blue
            statusText.textContent = '预览服务启动中';
            if (urlDisplay) urlDisplay.style.display = 'none';
            if (countdownEl) countdownEl.style.display = 'none';
        }

        // 隐藏 iframe，显示日志区域
        iframe.style.display = 'none';
        if (progressDiv) {
            progressDiv.style.display = 'block';
            progressDiv.style.height = '100%';
            progressDiv.style.flex = '1';
            progressDiv.style.background = '#f9fafb';
            progressDiv.innerHTML = '<div style="color:#9ca3af; padding:1rem;">等待服务响应...</div>';
        }

        // 启动心跳以保活 (立即启动，防止并发的其他 Preview 被杀)
        if (!heartbeatInterval) {
            const sendHeartbeat = () => {
                const taskIdToSend = taskId || currentTaskId;
                const modelIdToSend = modelId || currentModelId;
                if (taskIdToSend && modelIdToSend) {
                    fetch('/api/preview/heartbeat', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ taskId: taskIdToSend, modelId: modelIdToSend })
                    }).catch(console.error);
                }
            };

            sendHeartbeat();
            heartbeatInterval = setInterval(sendHeartbeat, 2000);
        }

        // 启动/连接预览
        try {
            // 尝试连接现有会话 (大部分情况下 initAll 应该已经启动了)
            let shouldStart = true;
            try {
                const existingStatus = await App.api.getPreviewStatus(taskId, modelId);
                if (existingStatus && (existingStatus.status === 'starting' || existingStatus.status === 'ready')) {
                    console.log('[Preview] Connecting to existing active session...');
                    shouldStart = false;
                }
            } catch (e) {
                // If check fails (e.g. 404), proceed to start
            }

            if (shouldStart) {
                console.log('[Preview] No active session found during load, starting new...');
                await App.api.startPreview(taskId, modelId);
            }

            // 轮询状态
            pollInterval = setInterval(async () => {
                // Guard: if user switched to a different model, stop this stale poll
                if (currentModelId !== modelId || currentTaskId !== taskId) {
                    clearInterval(pollInterval);
                    pollInterval = null;
                    return;
                }
                try {
                    const info = await App.api.getPreviewStatus(taskId, modelId);

                    // 同步倒计时
                    if (info.remainingSeconds !== undefined && countdownEl) {
                        countdownEl.style.display = 'none';
                    }

                    // 更新日志到 progressDiv
                    if (info.logs && progressDiv) {
                        const logsHtml = info.logs.map(l =>
                            `<div style="margin-bottom:2px;"><span style="color:#6b7280;margin-right:6px;">[${new Date(l.ts).toLocaleTimeString()}]</span>${escapeHtml(l.msg)}</div>`
                        ).join('');
                        progressDiv.innerHTML = logsHtml || '<div style="color:#9ca3af; padding:1rem;">等待服务响应...</div>';
                        progressDiv.scrollTop = progressDiv.scrollHeight;
                    }

                    // 检测 not_running 状态
                    if (info.status === 'not_running') {
                        clearInterval(pollInterval);
                        pollInterval = null;
                        showPreviewFailure(info.logs, null, statusBar, statusDot, statusText, urlDisplay, progressDiv);
                        return;
                    }
                    if (info.logs && info.logs.length > 0) {
                        const latestLog = info.logs.filter(l => !l.msg.startsWith('[Debug]')).pop() || info.logs[info.logs.length - 1];
                        if (latestLog && latestLog.msg && latestLog.msg.includes('Preview not running')) {
                            clearInterval(pollInterval);
                            pollInterval = null;
                            showPreviewFailure(info.logs, null, statusBar, statusDot, statusText, urlDisplay, progressDiv);
                            return;
                        }
                    }

                    // 准备好了
                    if (info.status === 'ready' && info.url) {
                        clearInterval(pollInterval);
                        pollInterval = null;

                        const currentSrc = iframe.getAttribute('data-src');
                        if (currentSrc !== info.url) {
                            iframe.src = info.url;
                            iframe.setAttribute('data-src', info.url);
                            iframe.style.display = 'block';
                        }

                        if (progressDiv) progressDiv.style.display = 'none';

                        if (statusBar) {
                            statusBar.style.display = 'flex'; // Show when ready
                            statusBar.style.background = '#f8fafc';
                            statusBar.style.borderBottomColor = '#e2e8f0';
                            statusDot.className = 'status-dot status-success'; // Green
                            statusText.textContent = '预览运行中';
                            urlDisplay.setAttribute('data-url', info.url);
                            if (urlDisplay) urlDisplay.style.display = 'flex';
                        }
                    } else if (info.status === 'error') {
                        clearInterval(pollInterval);
                        pollInterval = null;
                        showPreviewFailure(info.logs, null, statusBar, statusDot, statusText, urlDisplay, progressDiv);
                    }
                } catch (e) {
                    console.warn('Preview poll failed', e);
                }
            }, 1000);

        } catch (e) {
            showPreviewFailure([{ msg: `API Error: ${e.message}`, ts: Date.now() }], null, statusBar, statusDot, statusText, urlDisplay, progressDiv);
        }
    };

    /**
     * 统一的预览失败展示
     * 使用与运行中相同的 status bar（红色指示灯 + 重新启动按钮），日志展示在下方
     */
    function showPreviewFailure(logs, overlay, statusBar, statusDot, statusText, urlDisplay, progressDiv) {
        // 1. 移除 overlay
        if (overlay && overlay.parentNode) overlay.remove();

        // 2. 更新 status bar 为失败状态
        if (statusBar) {
            statusBar.style.display = 'flex';
            statusBar.style.background = '#f8fafc';
            statusBar.style.borderBottomColor = '#e2e8f0';
        }
        if (statusDot) statusDot.className = 'status-dot status-failed';
        if (statusText) statusText.textContent = '预览启动失败';
        if (urlDisplay) urlDisplay.style.display = 'none';

        // 3. 展示日志在 progressDiv 中
        if (progressDiv) {
            const logsHtml = (logs || []).map(l =>
                `<div style="margin-bottom:2px;"><span style="color:#6b7280;margin-right:6px;">[${new Date(l.ts).toLocaleTimeString()}]</span>${escapeHtml(l.msg)}</div>`
            ).join('');
            progressDiv.style.display = 'block';
            progressDiv.style.height = '100%';
            progressDiv.style.flex = '1';
            progressDiv.style.background = '#f9fafb';
            progressDiv.innerHTML = logsHtml || '<div style="color:#9ca3af; padding:1rem;">无日志</div>';
        }
    }

    /**
     * 倒计时逻辑 (弃用，改为由轮询同步后端时间)
     */
    function startCountdown(seconds) {
        // ... 被同步逻辑替代
    }

    /**
     * 清理逻辑
     * @param {string} nextTaskId 下一个要加载的任务ID (可选)
     */
    App.preview.cleanup = async function (nextTaskId) { // Make async
        if (pollInterval) clearInterval(pollInterval);
        if (countdownInterval) clearInterval(countdownInterval);
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        pollInterval = null;
        countdownInterval = null;
        heartbeatInterval = null;

        // 移除所有旧的 overlay（防止切换时残留失败/加载页面）
        document.querySelectorAll('.preview-loading-overlay').forEach(el => el.remove());

        // 隐藏 iframe 并清空 src（防止切换时闪现旧页面内容）
        const iframe = document.getElementById('preview-iframe');
        if (iframe) {
            iframe.style.display = 'none';
            iframe.removeAttribute('src');
            iframe.removeAttribute('data-src');
        }

        // 如果切换到了不同的 parent task，才真正停止后端进程
        if (currentTaskId && currentModelId && (!nextTaskId || nextTaskId !== currentTaskId)) {
            try {
                await App.api.stopPreview(currentTaskId, currentModelId);
            } catch (e) {
                console.warn('Failed to stop preview during cleanup:', e);
            }
        }

        // 仅在任务改变时清除任务上下文，否则保留以供心跳检测
        if (!nextTaskId || nextTaskId !== currentTaskId) {
            currentTaskId = null;
        }
        currentModelId = null;

        const countdownEl = document.getElementById('preview-countdown');
        if (countdownEl) {
            countdownEl.style.display = 'none';
        }
    };

    /**
     * 打开文件预览模态框
     */
    /**
     * 打开文件预览模态框
     */
    App.preview.openFilePreview = async function (folder, file) {
        App.elements.previewFilename.textContent = file;
        App.elements.previewBody.textContent = 'Loading...';
        // Reset class to base
        App.elements.previewBody.className = 'preview-body';
        App.elements.previewBody.removeAttribute('data-highlighted');

        App.elements.previewModal.classList.add('show');

        // Determine language from extension
        const ext = file.split('.').pop().toLowerCase();

        try {
            const data = await App.api.getFileContent(folder, file);
            if (data.error) {
                App.elements.previewBody.textContent = 'Error: ' + data.error;
            } else {
                // Determine if we should highlight
                // Common code extensions
                const codeExts = ['js', 'json', 'html', 'css', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'php', 'rb', 'sh', 'yaml', 'yml', 'xml', 'md', 'sql'];

                if (codeExts.includes(ext)) {
                    // Start with clean text
                    App.elements.previewBody.textContent = data.content;
                    // Add language class
                    App.elements.previewBody.classList.add(`language-${ext}`);
                    // Trigger highlight
                    hljs.highlightElement(App.elements.previewBody);
                } else {
                    App.elements.previewBody.textContent = data.content;
                }
            }
        } catch (err) {
            App.elements.previewBody.textContent = 'Failed to load file content';
            console.error(err);
        }
    };

    /**
     * 关闭预览模态框
     */
    App.preview.closePreview = function () {
        App.elements.previewModal.classList.remove('show');
        document.querySelectorAll('.file-tree-file').forEach(el => el.classList.remove('active'));
    };

    /**
     * 重新加载预览
     */
    App.preview.reloadPreview = function () {
        const iframe = document.getElementById('preview-iframe');
        const container = document.getElementById('tab-content-preview');
        const runId = iframe.getAttribute('data-run-id');
        if (runId) {
            const [taskId, modelId] = runId.split('/');
            App.preview.loadPreview(taskId, modelId, iframe, container);
        }
    };

    function escapeHtml(text) {
        if (typeof text !== 'string') return text;
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // 全屏打开预览
    App.preview.openFullscreen = function () {
        const urlDisplay = document.getElementById('preview-url-display');
        const url = urlDisplay && urlDisplay.getAttribute('data-url');
        if (url) {
            window.open(url, '_blank');
        }
    };

    // 全局快捷方式
    window.reloadPreview = App.preview.reloadPreview;
    window.closePreview = App.preview.closePreview;
    window.openPreviewFullscreen = App.preview.openFullscreen;

    // 页面卸载时清理进程
    window.addEventListener('beforeunload', () => {
        App.preview.cleanup();
    });

    // 监听 Tab 切换，如果离开预览 Tab 则停止（可选，用户可能想切回来看一眼进度）
    // 但根据需求“用户关闭前端的预览页面 ... 就关闭相关的进程”，这里我们主要处理 tab 关闭 and unload。

})();
