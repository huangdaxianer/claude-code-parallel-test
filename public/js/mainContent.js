/**
 * 主内容渲染模块
 * Main content area rendering including file tree
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.main = {};

    /**
     * 更新标签页 UI (不含 URL 和 内容渲染)
     */
    App.main.updateTabUI = function (tabName) {
        App.state.activeTab = tabName;

        // Only target tabs within the main panel header to avoid conflicting with feedback tabs or others
        const mainTabsContainer = document.querySelector('.panel-header .tabs');
        if (mainTabsContainer) {
            mainTabsContainer.querySelectorAll('.tab').forEach(t => {
                t.classList.toggle('active', t.dataset.tab === tabName);
            });
        }

        const trajectoryContent = document.getElementById('tab-content-trajectory');
        const filesContent = document.getElementById('tab-content-files');
        const previewContent = document.getElementById('tab-content-preview');

        if (trajectoryContent) trajectoryContent.classList.toggle('active', tabName === 'trajectory');
        if (filesContent) filesContent.classList.toggle('active', tabName === 'files');
        if (previewContent) previewContent.classList.toggle('active', tabName === 'preview');
    };

    /**
     * 渲染主内容
     */
    App.main.renderMainContent = function () {
        if (!App.state.activeFolder) return;
        const activeRun = App.state.currentRuns.find(r => r.folderName === App.state.activeFolder);
        if (!activeRun) return;

        // 1. 渲染轨迹日志
        if (activeRun.runId) {
            App.elements.logDisplayEl.classList.remove('markdown-view');

            const lastRenderedCount = parseInt(App.elements.logDisplayEl.dataset.lineCount || '0', 10);
            const lastRenderedFolder = App.elements.logDisplayEl.dataset.renderedFolder;

            if (lastRenderedFolder !== App.state.activeFolder) {
                App.elements.logDisplayEl.dataset.lineCount = '0';
                App.elements.logDisplayEl.innerHTML = '<div class="empty-state"><p style="margin-top: 1rem;">正在加载...</p></div>';
                App.elements.logDisplayEl.dataset.renderedFolder = App.state.activeFolder;
            }

            App.api.getTaskEvents(activeRun.runId)
                .then(data => {
                    const events = data.events || [];
                    const currentCount = events.length;

                    // 即使 currentCount 为 0，如果是第一次渲染该目录（当前显示正在加载），也需要更新 UI
                    const isFirstRenderForFolder = App.elements.logDisplayEl.innerHTML.includes('正在加载');

                    if (currentCount > lastRenderedCount || isFirstRenderForFolder) {
                        if (lastRenderedCount === 0 || isFirstRenderForFolder) {
                            if (currentCount === 0) {
                                App.elements.logDisplayEl.innerHTML = '<div class="empty-state"><p>暂无执行轨迹</p></div>';
                                return;
                            }
                            App.elements.logDisplayEl.innerHTML = '';
                        }

                        const fragment = document.createDocumentFragment();
                        const startIndex = (lastRenderedFolder === App.state.activeFolder) ? lastRenderedCount : 0;

                        for (let i = startIndex; i < currentCount; i++) {
                            const event = events[i];

                            if (event.type === 'USER') {
                                continue;
                            }

                            const textTypes = ['TXT'];

                            if (textTypes.includes(event.type)) {
                                const div = document.createElement('div');
                                div.className = 'text-log-entry markdown-body';
                                div.dataset.eventId = event.id;
                                div.style.marginBottom = '0.7rem';

                                let contentHtml = '';
                                try {
                                    contentHtml = marked.parse(event.preview_text);
                                } catch (e) {
                                    contentHtml = App.utils.escapeHtml(event.preview_text);
                                }

                                div.innerHTML = contentHtml;
                                fragment.appendChild(div);
                            } else {
                                const details = document.createElement('details');
                                details.className = 'json-log-entry';
                                details.dataset.eventId = event.id;

                                const summary = document.createElement('summary');
                                summary.className = 'json-summary';
                                const safePreview = event.preview_text.length > 200 ? event.preview_text.slice(0, 200) + '...' : event.preview_text;

                                const standardTypes = ['TXT', 'USER', 'ERROR', 'SUBAGENT', 'SUBAGENT_RESULT', 'Bash', 'Write', 'Edit', 'Read', 'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'TodoWrite'];
                                const isStandard = standardTypes.includes(event.type);
                                const displayType = isStandard ? event.type : 'ERROR';
                                const displayClass = isStandard ? (event.status_class || 'type-tool') : 'type-error';
                                const displayPreview = isStandard ? App.utils.escapeHtml(safePreview) : '';

                                summary.innerHTML = `
                                    <span class="json-type-badge ${displayClass}">${displayType}</span>
                                    <span class="json-preview-text" title="${App.utils.escapeHtml(event.preview_text)}">${displayPreview}</span>
                                `;

                                // Flag Feature
                                const flagSpan = document.createElement('span');
                                flagSpan.className = `log-flag ${event.is_flagged ? 'active' : ''}`;
                                flagSpan.style.marginLeft = 'auto'; // Push to right
                                flagSpan.style.cursor = 'pointer';
                                flagSpan.style.padding = '0 8px';
                                flagSpan.style.display = 'flex';
                                flagSpan.style.alignItems = 'center';
                                flagSpan.style.color = event.is_flagged ? '#ef4444' : '#cbd5e1'; // Red if active, gray if not

                                const flagSvg = `
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="${event.is_flagged ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path>
                                        <line x1="4" y1="22" x2="4" y2="15"></line>
                                    </svg>
                                `;
                                flagSpan.innerHTML = flagSvg;

                                flagSpan.onclick = async (e) => {
                                    e.preventDefault();
                                    e.stopPropagation();

                                    const isNowFlagged = !flagSpan.classList.contains('active');

                                    // Optimistic Update
                                    flagSpan.classList.toggle('active');
                                    flagSpan.style.color = isNowFlagged ? '#ef4444' : '#cbd5e1';
                                    flagSpan.querySelector('svg').style.fill = isNowFlagged ? 'currentColor' : 'none';

                                    try {
                                        await App.api.toggleLogFlag(event.id, isNowFlagged);
                                    } catch (err) {
                                        console.error('Failed to toggle flag:', err);
                                        // Revert on error
                                        flagSpan.classList.toggle('active');
                                        flagSpan.style.color = !isNowFlagged ? '#ef4444' : '#cbd5e1';
                                        flagSpan.querySelector('svg').style.fill = !isNowFlagged ? 'currentColor' : 'none';
                                    }
                                };

                                summary.appendChild(flagSpan);

                                const body = document.createElement('div');
                                body.className = 'json-body';
                                body.innerHTML = '<div class="loading-spinner" style="margin: 1rem;"></div>';

                                details.appendChild(summary);
                                details.appendChild(body);

                                details.ontoggle = () => {
                                    if (details.open && !details.dataset.loaded) {
                                        App.api.getLogEventContent(event.id)
                                            .then(d => {
                                                body.innerHTML = '';
                                                const contents = d.contents || [d.content];
                                                contents.forEach((content, idx) => {
                                                    if (contents.length > 1) {
                                                        const header = document.createElement('div');
                                                        header.className = 'json-block-header';
                                                        header.textContent = idx === 0 ? 'Tool Call' : `Tool Result`;
                                                        header.style.fontSize = '0.75rem';
                                                        header.style.fontWeight = 'bold';
                                                        header.style.opacity = '0.6';
                                                        header.style.marginTop = idx === 0 ? '0' : '1rem';
                                                        header.style.marginBottom = '0.25rem';
                                                        header.style.textTransform = 'uppercase';
                                                        body.appendChild(header);
                                                    }
                                                    const pre = document.createElement('pre');
                                                    try {
                                                        let obj = JSON.parse(content);
                                                        // Simplify display: 
                                                        // Tool Call (idx === 0): show only 'input'
                                                        // Tool Result (idx > 0): show only 'content'
                                                        if (idx === 0 && obj && typeof obj === 'object' && 'input' in obj) {
                                                            obj = obj.input;
                                                        } else if (idx > 0 && obj && typeof obj === 'object' && 'content' in obj) {
                                                            obj = obj.content;
                                                        }

                                                        pre.innerHTML = App.utils.syntaxHighlight(obj);
                                                    } catch (e) {
                                                        pre.textContent = content;
                                                    }
                                                    body.appendChild(pre);
                                                });
                                                details.dataset.loaded = 'true';
                                            });
                                    }
                                };
                                fragment.appendChild(details);
                            }
                        }

                        App.elements.logDisplayEl.appendChild(fragment);
                        App.elements.logDisplayEl.dataset.lineCount = currentCount;
                        App.elements.logDisplayEl.dataset.renderedFolder = App.state.activeFolder;

                        const isScrolled = App.elements.logDisplayEl.scrollHeight - App.elements.logDisplayEl.scrollTop <= App.elements.logDisplayEl.clientHeight + 200;
                        if (isScrolled) App.elements.logDisplayEl.scrollTop = App.elements.logDisplayEl.scrollHeight;

                        // Trigger persistent highlight update
                        if (App.comments && App.comments.highlightAllComments) {
                            setTimeout(App.comments.highlightAllComments, 100);
                        }
                    }
                })
                .catch(err => {
                    console.error('Failed to fetch events:', err);
                    App.elements.logDisplayEl.innerHTML = `<div style="color:red;padding:2rem;">Failed to load events: ${err.message}</div>`;
                });
        } else {
            // 传统日志回退
            if (activeRun.outputLog === undefined || activeRun.outputLog === null) {
                App.elements.logDisplayEl.innerHTML = '<div style="padding:2rem;">Loading legacy logs...</div>';
                fetch(`/api/task_logs/${App.state.currentTaskId}/${activeRun.modelName}`, { headers: App.api.getAuthHeaders() })
                    .then(res => res.json())
                    .then(data => {
                        activeRun.outputLog = data.outputLog || '';
                        App.main.renderMainContent();
                    });
                return;
            }

            const logText = (activeRun.outputLog || '')
                .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
                .replace(/}\s*{/g, '}\n{');

            if (!logText.trim()) {
                App.elements.logDisplayEl.innerHTML = '<div class="empty-state"><p>暂无执行轨迹</p></div>';
            } else {
                const isScrolled = App.elements.logDisplayEl.scrollHeight - App.elements.logDisplayEl.scrollTop <= App.elements.logDisplayEl.clientHeight + 100;
                try {
                    App.elements.logDisplayEl.innerHTML = marked.parse(logText);
                    App.elements.logDisplayEl.classList.add('markdown-view');
                } catch (e) {
                    App.elements.logDisplayEl.textContent = logText;
                }
                if (isScrolled) App.elements.logDisplayEl.scrollTop = App.elements.logDisplayEl.scrollHeight;
            }
        }

        // 2. 渲染文件列表
        const newFiles = activeRun.generatedFiles || [];

        const previewTabBtn = document.querySelector('.tab[data-tab="preview"]');
        if (previewTabBtn) {
            // Strictly check for valid previewable status ('static' or 'dynamic')
            const isPreviewable = activeRun.previewable === 'static' || activeRun.previewable === 'dynamic';

            if (isPreviewable) {
                previewTabBtn.style.display = 'block';
            } else {
                previewTabBtn.style.display = 'none';

                // Fallback: If current tab is preview but it's not valid, switch to trajectory
                // This handles cases where user directly navigates to &page=preview but it's not valid
                if (App.state.activeTab === 'preview') {
                    App.state.activeTab = 'trajectory'; // Update state immediately
                    App.updateUrl(App.state.currentTaskId, App.state.activeFolder, 'trajectory');
                    App.main.updateTabUI('trajectory');
                }
            }
        }

        // 3. 更新预览 iframe
        if (App.state.activeTab === 'preview') {
            console.log(`[Debug] Checking Preview state for ${App.state.activeFolder}`);
            const iframe = document.getElementById('preview-iframe');
            const container = document.getElementById('tab-content-preview');

            const runId = App.state.currentTaskId + '/' + activeRun.modelId;

            if (iframe.getAttribute('data-run-id') !== runId) {
                console.log(`[Debug] Loading preview for ${runId}`);
                iframe.setAttribute('data-run-id', runId);
                App.preview.loadPreview(App.state.currentTaskId, activeRun.modelId, iframe, container);
            } else {
                console.log(`[Debug] Preview already loaded. Force UI check.`);
                const sb = document.getElementById('preview-status-bar');
                if (sb) sb.style.display = 'flex';
            }
        }

        // 4. 更新文件树
        const newFilesHash = JSON.stringify(newFiles.sort());
        if (newFilesHash !== App.elements.fileListEl.dataset.filesHash) {
            const scrollPos = document.getElementById('file-list-container')?.scrollTop || 0;
            App.elements.fileListEl.dataset.filesHash = newFilesHash;
            App.elements.fileListEl.innerHTML = '';
            if (newFiles.length === 0) {
                App.elements.fileListEl.innerHTML = '<div class="empty-state" style="height:200px;"><p>No files generated</p></div>';
            } else {
                const tree = App.main.buildFileTree(newFiles);
                App.elements.fileListEl.appendChild(App.main.renderFileTree(tree, activeRun.folderName));
            }
            const container = document.getElementById('file-list-container');
            if (container) container.scrollTop = scrollPos;
        }
    };

    /**
     * 构建文件树
     */
    App.main.buildFileTree = function (paths) {
        const root = {};
        paths.forEach(pathStr => {
            const parts = pathStr.split('/');
            let current = root;
            let currentPath = '';
            parts.forEach((part, index) => {
                currentPath = currentPath ? `${currentPath}/${part}` : part;

                if (!current[part]) {
                    const isFile = index === parts.length - 1;
                    current[part] = isFile ? null : {};

                    if (!isFile) {
                        App.state.expandedPaths.add(currentPath);
                    }
                }
                current = current[part];
            });
        });
        return root;
    };

    /**
     * 渲染文件树
     */
    App.main.renderFileTree = function (tree, rootFolder, pathPrefix) {
        pathPrefix = pathPrefix || '';
        const ul = document.createElement('ul');
        ul.className = 'file-tree';

        const keys = Object.keys(tree).sort((a, b) => {
            const aIsFolder = tree[a] !== null;
            const bIsFolder = tree[b] !== null;
            if (aIsFolder && !bIsFolder) return -1;
            if (!aIsFolder && bIsFolder) return 1;
            return a.localeCompare(b);
        });

        keys.forEach(key => {
            const isFolder = tree[key] !== null;
            const fullPath = pathPrefix ? `${pathPrefix}/${key}` : key;
            const li = document.createElement('li');

            if (isFolder) {
                li.className = 'file-tree-item';

                const isExpanded = App.state.expandedPaths.has(fullPath);

                const header = document.createElement('div');
                header.className = 'file-tree-header';
                header.innerHTML = `
                    <span class="arrow-icon ${isExpanded ? 'expanded' : ''}">▶</span>
                    <span class="icon">📁</span>
                    <span>${key}</span>
                `;

                const childrenContainer = document.createElement('div');
                childrenContainer.className = `file-tree-children ${isExpanded ? 'expanded' : ''}`;

                const subTree = App.main.renderFileTree(tree[key], rootFolder, fullPath);
                Array.from(subTree.children).forEach(child => childrenContainer.appendChild(child));

                header.onclick = (e) => {
                    e.stopPropagation();
                    const arrow = header.querySelector('.arrow-icon');
                    const wasExpanded = childrenContainer.classList.contains('expanded');

                    if (wasExpanded) {
                        childrenContainer.classList.remove('expanded');
                        arrow.classList.remove('expanded');
                        App.state.expandedPaths.delete(fullPath);
                    } else {
                        childrenContainer.classList.add('expanded');
                        arrow.classList.add('expanded');
                        App.state.expandedPaths.add(fullPath);
                    }
                };

                li.appendChild(header);
                li.appendChild(childrenContainer);

            } else {
                li.className = 'file-tree-file';
                li.dataset.fullPath = fullPath;
                li.innerHTML = `
                    <span class="icon" style="margin-left:18px;">📄</span>
                    <span>${key}</span>
                `;
                li.onclick = (e) => {
                    e.stopPropagation();
                    App.preview.openFilePreview(rootFolder, fullPath);
                    document.querySelectorAll('.file-tree-file').forEach(el => el.classList.remove('active'));
                    li.classList.add('active');
                };
            }
            ul.appendChild(li);
        });

        return ul;
    };

    /**
     * 切换标签
     */
    App.main.switchTab = function (tabName) {
        App.main.updateTabUI(tabName);

        // Update URL with new page
        App.updateUrl(App.state.currentTaskId, App.state.activeFolder, tabName);

        App.main.renderMainContent();
    };

    // 全局快捷方式
    window.switchTab = App.main.switchTab;
    window.downloadFiles = function () {
        if (!App.state.activeFolder) {
            alert('No active folder selected.');
            return;
        }
        window.location.href = `/api/download_zip?folderName=${encodeURIComponent(App.state.activeFolder)}`;
    };

    // Store the default copy button HTML once
    const copyBtnDefaultHtml = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy`;
    let copyResetTimer = null;

    window.copyPrompt = function () {
        const promptEl = document.getElementById('task-prompt-display');
        if (!promptEl) return;

        const text = promptEl.textContent;

        function onSuccess() {
            const btn = document.getElementById('copy-prompt-btn');
            if (!btn) return;
            btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#10b981"><polyline points="20 6 9 17 4 12"></polyline></svg> 已复制`;
            if (copyResetTimer) clearTimeout(copyResetTimer);
            copyResetTimer = setTimeout(() => {
                const b = document.getElementById('copy-prompt-btn');
                if (b) b.innerHTML = copyBtnDefaultHtml;
                copyResetTimer = null;
            }, 2000);
        }

        // navigator.clipboard requires HTTPS; fallback to execCommand for HTTP
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(onSuccess).catch(err => {
                console.error('Failed to copy content: ', err);
            });
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                onSuccess();
            } catch (err) {
                console.error('Failed to copy content: ', err);
            }
            document.body.removeChild(textarea);
        }
    };

})();
