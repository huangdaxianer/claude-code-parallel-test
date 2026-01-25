/**
 * 预览模块
 * Preview functionality with Claude Code integration
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.preview = {};

    let currentTaskId = null;
    let currentModelName = null;
    let countdownInterval = null;
    let pollInterval = null;
    let heartbeatInterval = null;
    let lastLogMsg = null;
    let lastProgress = 0;

    /**
     * 加载预览
     */
    App.preview.loadPreview = async function (taskId, modelName, iframe, container) {
        if (!taskId || !modelName) return;

        // 如果正在加载同一个，则不重复加载
        if (currentTaskId === taskId && currentModelName === modelName && pollInterval) {
            return;
        }

        // 清理旧的
        await App.preview.cleanup();

        currentTaskId = taskId;
        currentModelName = modelName;
        lastLogMsg = null;
        lastProgress = 0;

        // 状态栏元素
        const statusBar = document.getElementById('preview-status-bar');
        const statusDot = document.getElementById('preview-status-dot');
        const statusText = document.getElementById('preview-status-text');
        const urlDisplay = document.getElementById('preview-url-display');
        const progressDiv = document.getElementById('preview-progress');
        const countdownEl = document.getElementById('preview-countdown');

        if (statusBar) {
            statusBar.style.display = 'none'; // Hide initially
            statusDot.className = 'status-dot status-starting'; // Blue
            statusText.textContent = '初始化中...';
            urlDisplay.textContent = '-';
            if (countdownEl) countdownEl.style.display = 'none';
        }

        if (progressDiv) {
            progressDiv.style.display = 'none'; // Keep hidden
            progressDiv.innerHTML = '';
        }

        const overlay = document.createElement('div');
        overlay.className = 'preview-loading-overlay';
        overlay.style.cssText = 'position:absolute; inset:0; background:white; display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:10; top:0;';
        overlay.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; width:300px;">
                <p style="margin-bottom:1rem; color:#64748b; font-size:0.9rem; font-weight:500;">预览服务启动中，请稍候...</p>
                <div class="progress-bar-container" style="width:100%; height:6px; background:#eff6ff; border-radius:3px; overflow:hidden; margin-bottom:0.5rem; border:1px solid #e2e8f0;">
                    <div id="preview-progress-bar" style="width:0%; height:100%; background:#3b82f6; transition:width 0.3s ease;"></div>
                </div>
                <p id="preview-loading-text" style="color:#94a3b8; font-size:0.8rem; height:1.2em; overflow:hidden; white-space:nowrap; text-align:center; width:100%;">等待服务响应...</p>
            </div>
        `;

        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }
        container.appendChild(overlay);

        // 启动预览
        try {
            const data = await App.api.startPreview(taskId, modelName);

            // 轮询状态
            pollInterval = setInterval(async () => {
                try {
                    const info = await App.api.getPreviewStatus(taskId, modelName);

                    // 同步倒计时
                    if (info.remainingSeconds !== undefined && countdownEl) {
                        countdownEl.style.display = 'none';
                    }

                    // 更新日志
                    if (info.logs && progressDiv) {
                        progressDiv.innerHTML = info.logs.map(l =>
                            `<div style="margin-bottom:4px; font-family: monospace; font-size: 0.85rem;"><span style="color:#999; margin-right:8px">[${new Date(l.ts).toLocaleTimeString()}]</span>${escapeHtml(l.msg)}</div>`
                        ).join('');
                        progressDiv.scrollTop = progressDiv.scrollHeight;

                        // 动态更新状态栏文本为最新消息
                        if (info.logs.length > 0) {
                            const relevantLogs = info.logs.filter(l => !l.msg.startsWith('[Debug]'));
                            const latestLog = relevantLogs.length > 0 ? relevantLogs[relevantLogs.length - 1] : info.logs[info.logs.length - 1];
                            statusText.textContent = latestLog.msg;

                            // Update loading overlay text and progress
                            const loadingTextEl = document.getElementById('preview-loading-text');
                            const progressBarEl = document.getElementById('preview-progress-bar');
                            const logsStr = info.logs.map(l => l.msg).join('\n');
                            const isFastPath = logsStr.includes('Fast Path detected');

                            // Determine Target Text first
                            let targetText = latestLog.msg;

                            if ((latestLog && latestLog.msg && latestLog.msg.includes('Preview not running')) || info.status === 'not_running') {
                                targetText = '预览服务启动失败';
                                if (progressBarEl) progressBarEl.style.width = '0%';

                                const topTextEl = overlay.querySelector('p');
                                if (topTextEl) topTextEl.textContent = '预览服务启动失败';
                                if (loadingTextEl) {
                                    loadingTextEl.textContent = '不是所有产物都能被正确加载，请尝试刷新页面或下载产物自行预览';
                                    loadingTextEl.style.whiteSpace = 'normal';
                                    loadingTextEl.style.height = 'auto';
                                    loadingTextEl.style.lineHeight = '1.5';
                                    loadingTextEl.style.marginTop = '4px';
                                }
                                return;
                            } else if (isFastPath) {
                                targetText = '正在启动后端服务';
                            }

                            if (loadingTextEl && targetText !== lastLogMsg) {
                                lastLogMsg = targetText;
                                loadingTextEl.textContent = targetText;
                                loadingTextEl.style.animation = 'none';
                                loadingTextEl.offsetHeight;
                                loadingTextEl.style.animation = 'fadeInUp 0.3s ease';
                            }

                            if (progressBarEl) {
                                let progress = 0;
                                if (logsStr.includes('正在分配端口')) progress += 10;
                                if (logsStr.includes('端口分配成功')) progress += 10;
                                if (logsStr.includes('尝试启动服务')) progress += 5;

                                if (isFastPath) {
                                    progress = Math.max(progress, 30);
                                }

                                const bashLogs = info.logs.filter(l =>
                                    !l.msg.includes('正在分配端口') &&
                                    !l.msg.includes('端口分配成功') &&
                                    !l.msg.includes('尝试启动服务') &&
                                    !l.msg.startsWith('[Debug]') &&
                                    !l.msg.startsWith('>>')
                                );

                                progress += (bashLogs.length * 10);
                                if (progress > 95) progress = 95;

                                if (progress > lastProgress) {
                                    progressBarEl.style.transition = 'none';
                                    progressBarEl.style.width = `${lastProgress}%`;
                                    progressBarEl.offsetHeight;
                                    progressBarEl.style.transition = `width 10s ease-out`;
                                    progressBarEl.style.width = `${progress}%`;
                                    lastProgress = progress;
                                }
                            }
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

                        overlay.remove();
                        if (progressDiv) progressDiv.style.display = 'none';

                        if (statusBar) {
                            statusBar.style.display = 'flex'; // Show when ready
                            statusDot.className = 'status-dot status-success'; // Green
                            statusText.textContent = '预览运行中';
                            statusText.textContent = '预览运行中';
                            urlDisplay.textContent = info.url;

                            // Start heartbeat to keep preview alive
                            if (!heartbeatInterval) {
                                const sendHeartbeat = () => {
                                    if (currentTaskId && currentModelName) {
                                        fetch('/api/preview/heartbeat', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ taskId: currentTaskId, modelName: currentModelName })
                                        }).catch(console.error);
                                    }
                                };

                                // Send immediately
                                sendHeartbeat();

                                // Then periodically
                                heartbeatInterval = setInterval(sendHeartbeat, 2000); // Heartbeat every 2s
                            }
                        }
                    } else if (info.status === 'error') {
                        clearInterval(pollInterval);
                        pollInterval = null;
                        overlay.innerHTML = `<p style="color:#ef4444; padding:2rem; text-align:center">Preview Failed to Start.<br>Check logs below.</p>`;
                        statusDot.className = 'status-dot status-failed';
                        statusText.textContent = 'Start Failed';
                    }
                } catch (e) {
                    console.warn('Preview poll failed', e);
                }
            }, 1000);

        } catch (e) {
            overlay.innerHTML = `<p style="color:#ef4444; padding:1rem; text-align:center">Failed to initiate preview:<br>${e.message}</p>`;
            statusDot.className = 'status-dot status-failed';
            statusText.textContent = 'API Error';
        }
    };

    /**
     * 倒计时逻辑 (弃用，改为由轮询同步后端时间)
     */
    function startCountdown(seconds) {
        // ... 被同步逻辑替代
    }

    /**
     * 清理逻辑
     */
    App.preview.cleanup = async function () { // Make async
        if (pollInterval) clearInterval(pollInterval);
        if (countdownInterval) clearInterval(countdownInterval);
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        pollInterval = null;
        countdownInterval = null;
        heartbeatInterval = null;

        if (currentTaskId && currentModelName) {
            try {
                await App.api.stopPreview(currentTaskId, currentModelName);
            } catch (e) {
                console.warn('Failed to stop preview during cleanup:', e);
            }
        }

        currentTaskId = null;
        currentModelName = null;

        const countdownEl = document.getElementById('preview-countdown');
        if (countdownEl) {
            countdownEl.style.display = 'none';
        }
    };

    /**
     * 打开文件预览模态框
     */
    App.preview.openFilePreview = async function (folder, file) {
        App.elements.previewFilename.textContent = file;
        App.elements.previewBody.textContent = 'Loading...';
        App.elements.previewModal.classList.add('show');

        try {
            const data = await App.api.getFileContent(folder, file);
            if (data.error) {
                App.elements.previewBody.textContent = 'Error: ' + data.error;
            } else {
                App.elements.previewBody.textContent = data.content;
            }
        } catch (err) {
            App.elements.previewBody.textContent = 'Failed to load file content';
        }
    };

    /**
     * 关闭预览模态框
     */
    App.preview.closePreview = function () {
        App.elements.previewModal.classList.remove('show');
    };

    /**
     * 重新加载预览
     */
    App.preview.reloadPreview = function () {
        const iframe = document.getElementById('preview-iframe');
        const container = document.getElementById('tab-content-preview');
        const runId = iframe.getAttribute('data-run-id');
        if (runId) {
            const [taskId, modelName] = runId.split('/');
            App.preview.loadPreview(taskId, modelName, iframe, container);
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

    // 全局快捷方式
    window.reloadPreview = App.preview.reloadPreview;
    window.closePreview = App.preview.closePreview;

    // 页面卸载时清理进程
    window.addEventListener('beforeunload', () => {
        App.preview.cleanup();
    });

    // 监听 Tab 切换，如果离开预览 Tab 则停止（可选，用户可能想切回来看一眼进度）
    // 但根据需求“用户关闭前端的预览页面 ... 就关闭相关的进程”，这里我们主要处理 tab 关闭和 unload。

})();
