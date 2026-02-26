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
        const subagentContent = document.getElementById('tab-content-subagent');

        if (trajectoryContent) trajectoryContent.classList.toggle('active', tabName === 'trajectory');
        if (filesContent) filesContent.classList.toggle('active', tabName === 'files');
        if (previewContent) previewContent.classList.toggle('active', tabName === 'preview');
        if (subagentContent) subagentContent.classList.toggle('active', tabName === 'subagent');
    };

    // ---- 成员选择器 ----

    let _lastMemberSelectorHash = '';

    /**
     * 渲染执行轨迹 Tab 中的成员选择器
     */
    App.main.renderMemberSelector = function () {
        const selector = document.getElementById('trajectory-member-selector');
        if (!selector) return;

        if (!App.state._hasAgentTeams || !App.state.agentTeamMembers || App.state.agentTeamMembers.length === 0) {
            selector.style.display = 'none';
            _lastMemberSelectorHash = '';
            return;
        }

        // 去重检查：成员列表和选中状态未变化时跳过
        const hash = JSON.stringify(App.state.agentTeamMembers.map(m => m.name)) + ':' + (App.state.selectedTrajectoryMember || '');
        if (hash === _lastMemberSelectorHash) return;
        _lastMemberSelectorHash = hash;

        selector.style.display = 'flex';
        selector.innerHTML = '';

        const members = App.state.agentTeamMembers;

        // 为每个成员创建 pill
        members.forEach(function (member) {
            const pill = document.createElement('span');
            const isActive = App.state.selectedTrajectoryMember === member.name;
            pill.className = 'traj-member-pill' + (isActive ? ' active' : '');
            pill.textContent = member.name;
            pill.onclick = function () {
                if (App.state.selectedTrajectoryMember === member.name) {
                    // 再次点击取消选中，回到主轨迹
                    App.state.selectedTrajectoryMember = null;
                } else {
                    App.state.selectedTrajectoryMember = member.name;
                }
                _lastMemberSelectorHash = ''; // 强制刷新选择器
                App.main.renderMemberSelector();
                // 重置 log display 状态
                App.elements.logDisplayEl.dataset.lineCount = '0';
                App.elements.logDisplayEl.dataset.saMember = '';
                App.elements.logDisplayEl.dataset.saLineCount = '0';
                App.elements.logDisplayEl.innerHTML = '';
                App.main.renderMainContent();
            };
            selector.appendChild(pill);
        });
    };

    // ---- 主轨迹渲染 ----

    /**
     * 渲染主Agent（team-lead）的执行轨迹
     */
    function renderMainTrajectory(activeRun) {
        const logEl = App.elements.logDisplayEl;

        // 如果从子Agent切换回来，清除子Agent相关dataset
        if (logEl.dataset.saMember) {
            logEl.dataset.saMember = '';
            logEl.dataset.saLineCount = '0';
            logEl.dataset.lineCount = '0';
            logEl.innerHTML = '';
        }

        const lastRenderedCount = parseInt(logEl.dataset.lineCount || '0', 10);
        const lastRenderedFolder = logEl.dataset.renderedFolder;

        if (lastRenderedFolder !== App.state.activeFolder) {
            logEl.dataset.lineCount = '0';
            logEl.innerHTML = '<div class="empty-state"><p style="margin-top: 1rem;">正在加载...</p></div>';
            logEl.dataset.renderedFolder = App.state.activeFolder;
        }

        App.api.getTaskEvents(activeRun.runId)
            .then(function (data) {
                const events = data.events || [];
                const currentCount = events.length;
                const isFirstRenderForFolder = logEl.innerHTML.includes('正在加载');

                if (currentCount > lastRenderedCount || isFirstRenderForFolder) {
                    if (lastRenderedCount === 0 || isFirstRenderForFolder) {
                        if (currentCount === 0) {
                            logEl.innerHTML = '<div class="empty-state"><p>暂无执行轨迹</p></div>';
                            return;
                        }
                        logEl.innerHTML = '';
                    }

                    var fragment = document.createDocumentFragment();
                    var startIndex = (lastRenderedFolder === App.state.activeFolder) ? lastRenderedCount : 0;

                    for (var i = startIndex; i < currentCount; i++) {
                        var event = events[i];

                        if (event.type === 'USER') continue;

                        if (event.type === 'TXT') {
                            var div = document.createElement('div');
                            div.className = 'text-log-entry markdown-body';
                            div.dataset.eventId = event.id;
                            div.style.marginBottom = '0.7rem';
                            try {
                                div.innerHTML = marked.parse(event.preview_text);
                            } catch (e) {
                                div.innerHTML = App.utils.escapeHtml(event.preview_text);
                            }
                            fragment.appendChild(div);
                        } else {
                            var details = document.createElement('details');
                            details.className = 'json-log-entry';
                            details.dataset.eventId = event.id;

                            var summary = document.createElement('summary');
                            summary.className = 'json-summary';
                            var safePreview = event.preview_text.length > 200 ? event.preview_text.slice(0, 200) + '...' : event.preview_text;

                            var standardTypes = ['TXT', 'USER', 'ERROR', 'SUBAGENT', 'SUBAGENT_RESULT', 'Bash', 'Write', 'Edit', 'Read', 'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'TodoWrite', 'SendMessage', 'TeamCreate', 'TeamDelete', 'TaskCreate', 'TaskUpdate', 'TaskList'];
                            var isStandard = standardTypes.includes(event.type);
                            var displayType = isStandard ? event.type : 'ERROR';
                            var displayClass = isStandard ? (event.status_class || 'type-tool') : 'type-error';
                            var displayPreview = isStandard ? App.utils.escapeHtml(safePreview) : '';

                            summary.innerHTML =
                                '<span class="json-type-badge ' + displayClass + '">' + displayType + '</span>' +
                                '<span class="json-preview-text" title="' + App.utils.escapeHtml(event.preview_text) + '">' + displayPreview + '</span>';

                            // Flag Feature
                            var flagSpan = document.createElement('span');
                            flagSpan.className = 'log-flag ' + (event.is_flagged ? 'active' : '');
                            flagSpan.style.cssText = 'margin-left:auto; cursor:pointer; padding:0 8px; display:flex; align-items:center; color:' + (event.is_flagged ? '#ef4444' : '#cbd5e1');
                            flagSpan.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="' + (event.is_flagged ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>';
                            (function (fs, evtId) {
                                fs.onclick = async function (e) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    var isNow = !fs.classList.contains('active');
                                    fs.classList.toggle('active');
                                    fs.style.color = isNow ? '#ef4444' : '#cbd5e1';
                                    fs.querySelector('svg').style.fill = isNow ? 'currentColor' : 'none';
                                    try {
                                        await App.api.toggleLogFlag(evtId, isNow);
                                    } catch (err) {
                                        console.error('Failed to toggle flag:', err);
                                        fs.classList.toggle('active');
                                        fs.style.color = !isNow ? '#ef4444' : '#cbd5e1';
                                        fs.querySelector('svg').style.fill = !isNow ? 'currentColor' : 'none';
                                    }
                                };
                            })(flagSpan, event.id);

                            summary.appendChild(flagSpan);

                            var body = document.createElement('div');
                            body.className = 'json-body';
                            body.innerHTML = '<div class="loading-spinner" style="margin: 1rem;"></div>';

                            details.appendChild(summary);
                            details.appendChild(body);

                            (function (det, bod, evtId) {
                                det.ontoggle = function () {
                                    if (det.open && !det.dataset.loaded) {
                                        App.api.getLogEventContent(evtId)
                                            .then(function (d) {
                                                bod.innerHTML = '';
                                                var contents = d.contents || [d.content];
                                                contents.forEach(function (content, idx) {
                                                    if (contents.length > 1) {
                                                        var header = document.createElement('div');
                                                        header.className = 'json-block-header';
                                                        header.textContent = idx === 0 ? 'Tool Call' : 'Tool Result';
                                                        header.style.cssText = 'font-size:0.75rem; font-weight:bold; opacity:0.6; margin-top:' + (idx === 0 ? '0' : '1rem') + '; margin-bottom:0.25rem; text-transform:uppercase;';
                                                        bod.appendChild(header);
                                                    }
                                                    var pre = document.createElement('pre');
                                                    try {
                                                        var obj = JSON.parse(content);
                                                        if (idx === 0 && obj && typeof obj === 'object' && 'input' in obj) obj = obj.input;
                                                        else if (idx > 0 && obj && typeof obj === 'object' && 'content' in obj) obj = obj.content;
                                                        pre.innerHTML = App.utils.syntaxHighlight(obj);
                                                    } catch (e) {
                                                        pre.textContent = content;
                                                    }
                                                    bod.appendChild(pre);
                                                });
                                                det.dataset.loaded = 'true';
                                            });
                                    }
                                };
                            })(details, body, event.id);

                            fragment.appendChild(details);
                        }
                    }

                    logEl.appendChild(fragment);
                    logEl.dataset.lineCount = currentCount;
                    logEl.dataset.renderedFolder = App.state.activeFolder;

                    var isScrolled = logEl.scrollHeight - logEl.scrollTop <= logEl.clientHeight + 200;
                    if (isScrolled) logEl.scrollTop = logEl.scrollHeight;

                    if (App.comments && App.comments.highlightAllComments) {
                        setTimeout(App.comments.highlightAllComments, 100);
                    }
                }
            })
            .catch(function (err) {
                console.error('Failed to fetch events:', err);
                logEl.innerHTML = '<div style="color:red;padding:2rem;">Failed to load events: ' + err.message + '</div>';
            });
    }

    // ---- 子Agent轨迹渲染 ----

    let _saFetching = false;

    /**
     * 将子Agent事件数组分组：tool_use + tool_result 配对
     */
    function groupSubAgentEvents(events) {
        var groups = [];
        var i = 0;
        while (i < events.length) {
            var evt = events[i];
            if (evt.type === 'tool_use') {
                // 向前查找配对的 tool_result
                if (i + 1 < events.length && events[i + 1].type === 'tool_result') {
                    groups.push({ type: 'tool_pair', toolUse: evt, toolResult: events[i + 1] });
                    i += 2;
                } else {
                    groups.push({ type: 'tool_single', toolUse: evt });
                    i += 1;
                }
            } else if (evt.type === 'tool_result') {
                // 孤立的 tool_result
                groups.push({ type: 'tool_result_only', toolResult: evt });
                i += 1;
            } else {
                groups.push({ type: evt.type, event: evt });
                i += 1;
            }
        }
        return groups;
    }

    /**
     * 从工具文本中提取工具名和预览文本
     */
    function parseToolText(text) {
        if (!text) return { name: 'Tool', preview: '' };
        var arrowIdx = text.indexOf('→');
        var colonIdx = text.indexOf(':');

        // "SendMessage → target: content"
        if (arrowIdx > 0 && (colonIdx < 0 || arrowIdx < colonIdx)) {
            var name = text.slice(0, arrowIdx).trim();
            var rest = text.slice(arrowIdx).trim(); // "→ target: content"
            return { name: name, preview: rest };
        }
        // "ToolName: detail"
        if (colonIdx > 0 && colonIdx < 30) {
            return { name: text.slice(0, colonIdx).trim(), preview: text.slice(colonIdx + 1).trim() };
        }
        // "ToolName(...)"
        var spaceIdx = text.indexOf(' ');
        if (spaceIdx > 0 && spaceIdx < 25) {
            return { name: text.slice(0, spaceIdx).trim(), preview: text.slice(spaceIdx + 1).trim() };
        }
        return { name: text.trim(), preview: '' };
    }

    /**
     * 为单个子Agent事件组创建DOM元素
     */
    function renderSubAgentGroup(group) {
        var esc = App.utils.escapeHtml;

        // assistant 文本 → markdown
        if (group.type === 'assistant') {
            var div = document.createElement('div');
            div.className = 'text-log-entry markdown-body';
            div.style.marginBottom = '0.7rem';
            try {
                div.innerHTML = marked.parse(group.event.text || '');
            } catch (e) {
                div.textContent = group.event.text || '';
            }
            return div;
        }

        // user 消息 → 蓝色区块
        if (group.type === 'user') {
            var div = document.createElement('div');
            div.className = 'user-prompt-entry';
            div.innerHTML = '<div class="user-prompt-label">USER</div>';
            var textDiv = document.createElement('div');
            var text = group.event.text || '';
            if (text.length > 500) text = text.slice(0, 500) + '...';
            textDiv.textContent = text;
            div.appendChild(textDiv);
            return div;
        }

        // tool_pair / tool_single → 可折叠 details
        if (group.type === 'tool_pair' || group.type === 'tool_single') {
            var toolText = group.toolUse.text || '';
            var parsed = parseToolText(toolText);

            var details = document.createElement('details');
            details.className = 'json-log-entry';

            var summary = document.createElement('summary');
            summary.className = 'json-summary';
            summary.innerHTML =
                '<span class="json-type-badge type-tool">' + esc(parsed.name) + '</span>' +
                '<span class="json-preview-text" title="' + esc(toolText) + '">' + esc(parsed.preview.slice(0, 200)) + '</span>';

            var body = document.createElement('div');
            body.className = 'json-body';

            // Tool Call
            var callHeader = document.createElement('div');
            callHeader.style.cssText = 'font-size:0.75rem; font-weight:bold; opacity:0.6; margin-bottom:0.25rem; text-transform:uppercase;';
            callHeader.textContent = 'Tool Call';
            body.appendChild(callHeader);
            var callPre = document.createElement('pre');
            callPre.textContent = toolText;
            callPre.style.whiteSpace = 'pre-wrap';
            body.appendChild(callPre);

            // Tool Result (if paired)
            if (group.type === 'tool_pair') {
                var resultHeader = document.createElement('div');
                resultHeader.style.cssText = 'font-size:0.75rem; font-weight:bold; opacity:0.6; margin-top:1rem; margin-bottom:0.25rem; text-transform:uppercase;';
                resultHeader.textContent = 'Tool Result';
                body.appendChild(resultHeader);
                var resultPre = document.createElement('pre');
                resultPre.textContent = group.toolResult.text || '';
                resultPre.style.whiteSpace = 'pre-wrap';
                body.appendChild(resultPre);
            }

            details.appendChild(summary);
            details.appendChild(body);
            return details;
        }

        // 孤立 tool_result
        if (group.type === 'tool_result_only') {
            var details = document.createElement('details');
            details.className = 'json-log-entry';
            var summary = document.createElement('summary');
            summary.className = 'json-summary';
            summary.innerHTML =
                '<span class="json-type-badge type-content">RES</span>' +
                '<span class="json-preview-text">' + esc((group.toolResult.text || '').slice(0, 200)) + '</span>';
            var body = document.createElement('div');
            body.className = 'json-body';
            var pre = document.createElement('pre');
            pre.textContent = group.toolResult.text || '';
            pre.style.whiteSpace = 'pre-wrap';
            body.appendChild(pre);
            details.appendChild(summary);
            details.appendChild(body);
            return details;
        }

        return null;
    }

    /**
     * 渲染子Agent的执行轨迹（主格式）
     */
    function renderSubAgentTrajectory(memberName) {
        if (_saFetching) return;
        _saFetching = true;

        var taskId = App.state.currentTaskId;
        var folder = App.state.activeFolder;
        if (!taskId || !folder) { _saFetching = false; return; }
        var modelId = folder.includes('/') ? folder.split('/').pop() : folder;
        var logEl = App.elements.logDisplayEl;

        var prevMember = logEl.dataset.saMember || '';
        var prevCount = parseInt(logEl.dataset.saLineCount || '0', 10);

        if (prevMember !== memberName) {
            logEl.innerHTML = '<div class="empty-state"><p style="margin-top: 1rem;">正在加载...</p></div>';
            logEl.dataset.saMember = memberName;
            logEl.dataset.saLineCount = '0';
            logEl.dataset.lineCount = '0'; // 清除主轨迹计数
            prevCount = 0;
        }

        fetch('/api/tasks/' + taskId + '/models/' + modelId + '/agents/trajectories', {
            headers: App.api.getAuthHeaders()
        })
            .then(function (resp) { return resp.ok ? resp.json() : { trajectories: [] }; })
            .then(function (data) {
                _saFetching = false;
                // 确保选中状态未变化
                if (App.state.selectedTrajectoryMember !== memberName) return;

                var trajectories = data.trajectories || [];
                var traj = null;
                for (var t = 0; t < trajectories.length; t++) {
                    if (trajectories[t].memberName === memberName ||
                        trajectories[t].memberName.toLowerCase() === memberName.toLowerCase()) {
                        traj = trajectories[t];
                        break;
                    }
                }

                if (!traj || !traj.events || traj.events.length === 0) {
                    if (prevCount === 0) {
                        logEl.innerHTML = '<div class="empty-state"><p>暂无 ' + App.utils.escapeHtml(memberName) + ' 的执行轨迹</p></div>';
                    }
                    return;
                }

                var currentCount = traj.events.length;
                if (currentCount <= prevCount && prevMember === memberName) return; // 无新事件

                // 分组并渲染
                var groups = groupSubAgentEvents(traj.events);
                logEl.innerHTML = '';
                var fragment = document.createDocumentFragment();
                for (var g = 0; g < groups.length; g++) {
                    var el = renderSubAgentGroup(groups[g]);
                    if (el) fragment.appendChild(el);
                }
                logEl.appendChild(fragment);
                logEl.dataset.saLineCount = String(currentCount);
                logEl.dataset.saMember = memberName;

                // 自动滚动
                var isScrolled = logEl.scrollHeight - logEl.scrollTop <= logEl.clientHeight + 200;
                if (isScrolled) logEl.scrollTop = logEl.scrollHeight;
            })
            .catch(function (e) {
                _saFetching = false;
                console.error('[MainContent] Sub-agent trajectory fetch error:', e);
            });
    }

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

            // 如果选中了子Agent，渲染子Agent轨迹
            if (App.state.selectedTrajectoryMember !== null) {
                renderSubAgentTrajectory(App.state.selectedTrajectoryMember);
            } else {
                // 主轨迹渲染（team-lead / 默认）
                renderMainTrajectory(activeRun);
            }
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

        // 子Agent tab 显示/隐藏控制 + 成员选择器
        const subagentTabBtn = document.querySelector('.tab[data-tab="subagent"]');
        if (subagentTabBtn) {
            const saModelId = activeRun.modelId || (App.state.activeFolder.includes('/') ? App.state.activeFolder.split('/').pop() : App.state.activeFolder);
            const cacheKey = `sa_${App.state.currentTaskId}_${saModelId}`;
            if (App.state._subagentCache !== cacheKey) {
                App.state._subagentCache = cacheKey;
                App.state._hasAgentTeams = false;
                fetch(`/api/tasks/${App.state.currentTaskId}/models/${saModelId}/agents`, {
                    headers: App.api.getAuthHeaders()
                }).then(resp => {
                    if (!resp.ok) {
                        App.state._hasAgentTeams = false;
                        App.state.agentTeamMembers = [];
                        subagentTabBtn.style.display = 'none';
                        App.main.renderMemberSelector();
                        if (App.state.activeTab === 'subagent') {
                            App.state.activeTab = 'trajectory';
                            App.updateUrl(App.state.currentTaskId, App.state.activeFolder, 'trajectory');
                            App.main.updateTabUI('trajectory');
                        }
                        return;
                    }
                    return resp.json().then(function (data) {
                        App.state._hasAgentTeams = true;
                        App.state.agentTeamMembers = data.members || [];
                        subagentTabBtn.style.display = 'block';
                        App.main.renderMemberSelector();
                        // 触发子Agent面板渲染
                        if (App.state.activeTab === 'subagent' && App.subAgent) {
                            App.subAgent.render();
                        }
                    });
                }).catch(() => {
                    subagentTabBtn.style.display = 'none';
                    App.state.agentTeamMembers = [];
                    App.main.renderMemberSelector();
                });
            } else {
                subagentTabBtn.style.display = App.state._hasAgentTeams ? 'block' : 'none';
                // 每次渲染都更新成员选择器（可能已有缓存数据）
                App.main.renderMemberSelector();
            }
        }

        // 触发子Agent面板渲染（subagent tab 或 trajectory tab 有 agent teams 时启动轮询）
        if (App.subAgent && App.state._hasAgentTeams) {
            if (App.state.activeTab === 'subagent' || App.state.activeTab === 'trajectory') {
                App.subAgent.render();
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
