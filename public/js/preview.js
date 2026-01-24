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
        App.preview.cleanup();

        currentTaskId = taskId;
        currentModelName = modelName;

        // 状态栏元素
        const statusBar = document.getElementById('preview-status-bar');
        const statusDot = document.getElementById('preview-status-dot');
        const statusText = document.getElementById('preview-status-text');
        const urlDisplay = document.getElementById('preview-url-display');
        const progressDiv = document.getElementById('preview-progress');
        const countdownEl = document.getElementById('preview-countdown');

        if (statusBar) {
            statusBar.style.display = 'flex';
            statusDot.className = 'status-dot status-starting'; // Blue
            statusText.textContent = '初始化中...';
            urlDisplay.textContent = '-';
            if (countdownEl) countdownEl.style.display = 'none';
        }

        if (progressDiv) {
            progressDiv.style.display = 'block';
            progressDiv.innerHTML = '<div style="color:#aaa">等待服务响应...</div>';
        }

        const overlay = document.createElement('div');
        overlay.className = 'preview-loading-overlay';
        overlay.style.cssText = 'position:absolute; inset:0; background:white; display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:10; top:187px;';
        overlay.innerHTML = '<div class="loading-spinner"></div><p style="margin-top:1rem; color:#64748b; font-size:0.9rem">预览服务启动中，请稍候...</p>';

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

                    // 同步倒计时 (只要后端提供了剩余秒数就展示)
                    if (info.remainingSeconds !== undefined && countdownEl) {
                        // 只有在 ready 状态或 error 状态（进入了清理倒计时）才显示
                        if (info.status === 'ready' || info.status === 'error') {
                            countdownEl.style.display = 'inline';
                            const m = Math.floor(info.remainingSeconds / 60);
                            const s = info.remainingSeconds % 60;
                            countdownEl.textContent = `(${m}:${s.toString().padStart(2, '0')})`;
                        } else {
                            countdownEl.style.display = 'none';
                        }
                    }

                    // 更新日志
                    if (info.logs && progressDiv) {
                        progressDiv.innerHTML = info.logs.map(l =>
                            `<div style="margin-bottom:4px; font-family: monospace; font-size: 0.85rem;"><span style="color:#999; margin-right:8px">[${new Date(l.ts).toLocaleTimeString()}]</span>${escapeHtml(l.msg)}</div>`
                        ).join('');
                        progressDiv.scrollTop = progressDiv.scrollHeight;

                        // 动态更新状态栏文本为最新消息
                        if (info.logs.length > 0) {
                            // Find the last relevant message to display as status
                            const relevantLogs = info.logs.filter(l => !l.msg.startsWith('[Debug]'));
                            const latestLog = relevantLogs.length > 0 ? relevantLogs[relevantLogs.length - 1] : info.logs[info.logs.length - 1];
                            statusText.textContent = latestLog.msg;

                            // Optional: Add simple animation class to indicate update
                            statusText.style.animation = 'none';
                            statusText.offsetHeight; /* trigger reflow */
                            statusText.style.animation = 'fadeInDown 0.3s ease';
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
                            statusDot.className = 'status-dot status-success'; // Green
                            statusText.textContent = '预览运行中';
                            urlDisplay.textContent = info.url;
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
    App.preview.cleanup = function () {
        if (pollInterval) clearInterval(pollInterval);
        if (countdownInterval) clearInterval(countdownInterval);
        pollInterval = null;
        countdownInterval = null;

        if (currentTaskId && currentModelName) {
            App.api.stopPreview(currentTaskId, currentModelName).catch(() => { });
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
