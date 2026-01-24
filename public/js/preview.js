/**
 * 预览模块
 * Preview functionality
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.preview = {};

    /**
     * 加载预览
     */
    App.preview.loadPreview = async function (taskId, modelName, iframe, container) {
        if (!taskId || !modelName) return;

        // 移除已有覆盖层
        const existingOverlay = container.querySelector('.preview-loading-overlay');
        if (existingOverlay) existingOverlay.remove();

        // 状态栏元素
        const statusBar = document.getElementById('preview-status-bar');
        const statusDot = document.getElementById('preview-status-dot');
        const statusText = document.getElementById('preview-status-text');
        const urlDisplay = document.getElementById('preview-url-display');
        const progressDiv = document.getElementById('preview-progress');

        if (statusBar) {
            statusBar.style.display = 'flex';
            statusDot.className = 'status-dot status-pending';
            statusText.textContent = 'Initializing...';
            urlDisplay.textContent = '-';
        }

        if (progressDiv) {
            progressDiv.style.display = 'block';
            progressDiv.innerHTML = '<div style="color:#aaa">Waiting for server...</div>';
        }

        // 创建加载覆盖层
        const overlay = document.createElement('div');
        overlay.className = 'preview-loading-overlay';
        overlay.style.cssText = 'position:absolute; inset:0; background:white; display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:10; top:187px;';
        overlay.innerHTML = '<div class="loading-spinner"></div><p style="margin-top:1rem; color:#64748b; font-size:0.9rem">Starting environment...</p>';

        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }
        container.appendChild(overlay);

        let pollInterval;

        // 轮询函数
        const startPolling = () => {
            pollInterval = setInterval(async () => {
                try {
                    const info = await App.api.getPreviewStatus(taskId, modelName);
                    if (info.logs && progressDiv) {
                        progressDiv.innerHTML = info.logs.map(l =>
                            `<div style="margin-bottom:4px"><span style="color:#999; margin-right:8px">[${new Date(l.ts).toLocaleTimeString()}]</span>${l.msg}</div>`
                        ).join('');
                        progressDiv.scrollTop = progressDiv.scrollHeight;
                    }
                    if (info.status === 'ready' && info.url) {
                        if (urlDisplay) urlDisplay.textContent = info.url;
                    }
                } catch (e) {
                    console.warn('Preview status poll failed', e);
                }
            }, 500);
        };

        startPolling();

        try {
            const data = await App.api.startPreview(taskId, modelName);

            clearInterval(pollInterval);

            if (data.url) {
                const currentSrc = iframe.getAttribute('data-src');
                if (currentSrc !== data.url) {
                    iframe.src = data.url;
                    iframe.setAttribute('data-src', data.url);
                    iframe.style.display = 'block';
                }
                overlay.remove();
                if (progressDiv) progressDiv.style.display = 'none';

                if (statusBar) {
                    statusDot.className = 'status-dot status-completed';
                    statusText.textContent = '预览运行中';
                    urlDisplay.textContent = data.url;
                }

            } else {
                throw new Error(data.error || 'Unknown response');
            }
        } catch (e) {
            clearInterval(pollInterval);
            overlay.innerHTML = `<p style="color:#ef4444; padding:1rem; text-align:center">预览加载失败:<br>${e.message}</p>`;

            if (statusBar) {
                statusDot.className = 'status-dot status-failed';
                statusText.textContent = 'Connection Failed';
                urlDisplay.textContent = 'Error';
            }
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

    // 全局快捷方式
    window.reloadPreview = App.preview.reloadPreview;
    window.closePreview = App.preview.closePreview;

})();
