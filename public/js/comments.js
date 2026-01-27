/**
 * 评论反馈模块
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.comments = {};

    App.comments.state = {
        selection: null,
        comments: []
    };

    /**
     * 初始化
     */
    App.comments.init = function () {
        // 绑定全局鼠标松开事件以处理选区
        document.addEventListener('mouseup', App.comments.handleSelection);

        // 绑定滚动事件，隐藏浮动按钮
        document.addEventListener('scroll', App.comments.hideFloatingButton, true);

        // Close menus on click outside
        document.addEventListener('click', function (e) {
            if (!e.target.closest('.comment-more-btn') && !e.target.closest('.comment-menu-popup')) {
                document.querySelectorAll('.comment-menu-popup').forEach(el => el.classList.remove('show'));
            }
        });

        // Close comment input on mousedown outside
        document.addEventListener('mousedown', function (e) {
            const popover = document.getElementById('comment-input-popover');
            if (popover && popover.style.display === 'block') {
                if (!popover.contains(e.target)) {
                    App.comments.hideInput();
                }
            }
        });
    };

    /**
     * 加载当前任务的评论
     */
    App.comments.loadComments = async function () {
        if (!App.state.currentTaskId || !App.state.activeFolder) return;

        const run = App.state.currentRuns.find(r => r.folderName === App.state.activeFolder);
        const modelName = run ? run.modelName : (App.state.activeFolder.includes('/') ? App.state.activeFolder.split('/').pop() : App.state.activeFolder);

        try {
            const comments = await App.api.getComments(App.state.currentTaskId, modelName);
            App.comments.state.comments = comments;
            App.comments.renderComments(comments);
        } catch (e) {
            console.error('Failed to load comments:', e);
            document.getElementById('comments-list').innerHTML = '<div style="text-align:center; padding:2rem; color:#ef4444;">加载失败</div>';
        }
    };

    /**
     * 渲染评论列表
     */
    App.comments.renderComments = function (comments) {
        const container = document.getElementById('comments-list');
        if (!container) return;

        if (comments.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding:2rem; color:#94a3b8;">暂无评论，选中文本即可添加</div>';
            return;
        }

        let html = '';
        comments.forEach(c => {
            html += `
                <div class="comment-card" onclick="App.comments.jumpToContext(${c.id})">
                    ${App.state.currentUser && (App.state.currentUser.id === c.user_id || App.state.currentUser.role === 'admin') ? `
                    <button class="comment-more-btn" onclick="event.stopPropagation(); App.comments.toggleMenu(${c.id}, event)">⋮</button>
                    <div id="comment-menu-${c.id}" class="comment-menu-popup">
                        <button class="comment-delete-item" onclick="event.stopPropagation(); App.comments.deleteComment(${c.id})">
                            🗑️ 删除任务
                        </button>
                    </div>` : ''}
                    ${c.original_content ? `<div class="comment-quote">${App.utils.escapeHtml(c.original_content)}</div>` : ''}
                    <div class="comment-text">${App.utils.escapeHtml(c.content)}</div>
                </div>
            `;
        });

        container.innerHTML = html;
    };

    /**
     * 处理文本选择
     */
    App.comments.handleSelection = function (e) {
        // 如果正在输入，忽略
        if (e.target.closest('.comment-input-popover')) return;
        // 如果点击的是浮动按钮，忽略
        if (e.target.closest('.floating-comment-btn')) return;

        const selection = window.getSelection();
        if (selection.isCollapsed) {
            App.comments.hideFloatingButton();
            return;
        }

        const text = selection.toString().trim();
        if (text.length < 1) return;

        // 确定选区所在的上下文
        let targetType = null;
        let targetRef = null;

        // 1. 检查是否在 Log Display 中 (Trajectory)
        const logDisplay = document.getElementById('log-display');
        const anchorNode = selection.anchorNode.nodeType === 3 ? selection.anchorNode.parentElement : selection.anchorNode;

        if (logDisplay && logDisplay.contains(anchorNode)) {
            targetType = 'trajectory';
            // 尝试找到所属的 event-id
            const entry = anchorNode.closest('[data-event-id]');
            if (entry) {
                targetRef = entry.dataset.eventId;
            } else {
                targetRef = 'current'; // Fallback
            }
        }

        // 2. 检查是否在代码预览中 (Preview Modal or Code Tab)
        const previewBody = document.getElementById('preview-body');
        if (previewBody && previewBody.contains(anchorNode)) {
            targetType = 'artifact';
            // 获取当前文件路径
            const filenameEl = document.getElementById('preview-filename');
            targetRef = filenameEl ? filenameEl.textContent.trim() : 'unknown';
        }

        if (targetType) {
            // 保存选区信息
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();

            App.comments.state.selection = {
                text: text,
                targetType: targetType,
                targetRef: targetRef,
                rect: rect,
                range: range.cloneRange() // Keep a copy
            };

            App.comments.showFloatingButton(rect);
        } else {
            App.comments.hideFloatingButton();
        }
    };

    /**
     * 显示浮动按钮
     */
    App.comments.showFloatingButton = function (rect) {
        const btn = document.getElementById('floating-comment-btn');
        if (!btn) return;

        // 计算位置：选区上方居中
        const top = rect.top - 40;
        const left = rect.left + (rect.width / 2);

        btn.style.top = `${top}px`;
        btn.style.left = `${left}px`;
        btn.style.display = 'block';

        // 绑定点击事件 (一次性)
        btn.onclick = function (e) {
            e.stopPropagation();
            e.preventDefault();
            App.comments.showInput(rect);
        };

        // 防止点击按钮时丢失选区
        btn.onmousedown = function (e) {
            e.preventDefault();
        };
    };

    /**
     * 隐藏浮动按钮
     */
    App.comments.hideFloatingButton = function () {
        const btn = document.getElementById('floating-comment-btn');
        if (btn) btn.style.display = 'none';
    };

    /**
     * 显示输入框
     */
    App.comments.showInput = function (rect) {
        App.comments.hideFloatingButton();

        const popover = document.getElementById('comment-input-popover');
        if (!popover) return;

        const input = document.getElementById('comment-input-text');
        input.value = '';

        const top = rect.bottom + 10;
        const left = rect.left + (rect.width / 2);

        // 边界检查，防止溢出屏幕底部
        if (top + 150 > window.innerHeight) {
            popover.style.top = `${rect.top - 160}px`; // 显示在上方
        } else {
            popover.style.top = `${top}px`;
        }

        popover.style.left = `${left}px`;
        popover.style.left = `${left}px`;
        popover.style.display = 'block';
        input.focus();

        // Use CSS Custom Highlight API to keep visual selection
        if (window.Highlight && window.CSS && CSS.highlights) {
            const range = App.comments.state.selection.range;
            if (range) {
                const highlight = new Highlight(range);
                CSS.highlights.set('comment-selection', highlight);
            }
        }

        // Bind Enter to submit
        input.onkeydown = function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                App.comments.submitComment();
            }
        };
    };

    /**
     * 隐藏输入框
     */
    App.comments.hideInput = function () {
        const popover = document.getElementById('comment-input-popover');
        if (popover) popover.style.display = 'none';

        // Remove Custom Highlight
        if (window.CSS && CSS.highlights) {
            CSS.highlights.delete('comment-selection');
        }

        window.getSelection().removeAllRanges(); // 清除选区
    };

    /**
     * 提交评论
     */
    App.comments.submitComment = async function () {
        const input = document.getElementById('comment-input-text');
        const content = input.value.trim();
        if (!content) return;

        const sel = App.comments.state.selection;
        if (!sel) return;

        if (!App.state.currentTaskId || !App.state.activeFolder) return;

        const run = App.state.currentRuns.find(r => r.folderName === App.state.activeFolder);
        const modelName = run ? run.modelName : (App.state.activeFolder.includes('/') ? App.state.activeFolder.split('/').pop() : App.state.activeFolder);

        // 构造选区范围信息
        const selectionRange = {
            startOffset: 0,
            endOffset: 0
        };

        try {
            await App.api.addComment({
                taskId: App.state.currentTaskId,
                modelName: modelName,
                userId: App.state.currentUser ? App.state.currentUser.id : null,
                targetType: sel.targetType,
                targetRef: sel.targetRef,
                selectionRange: selectionRange,
                content: content,
                originalContent: sel.text
            });

            App.comments.hideInput();
            App.comments.loadComments(); // 刷新列表
            App.toast.show('评论已添加', 'success');

            // 自动切换到评论 Tab
            if (App.feedback && App.feedback.switchTab) {
                App.feedback.switchTab('comments');
            }

        } catch (e) {
            console.error('Submit comment failed:', e);
            App.toast.show('提交失败', 'error');
        }
    };

    /**
     * 删除评论
     */
    App.comments.deleteComment = async function (id) {
        App.comments.deleteComment = async function (id) {
            // No confirmation
            try {
                await App.api.deleteComment(id);
                App.comments.loadComments();
                App.toast.show('评论已删除', 'success');
            } catch (e) {
                console.error('Delete comment failed:', e);
                App.toast.show('删除失败', 'error');
            }
            console.error('Delete comment failed:', e);
            App.toast.show('删除失败', 'error');
        }
    };

    /**
     * 切换评论菜单
     */
    App.comments.toggleMenu = function (id, event) {
        // Close all other menus
        document.querySelectorAll('.comment-menu-popup').forEach(el => {
            if (el.id !== `comment-menu-${id}`) el.classList.remove('show');
        });

        const menu = document.getElementById(`comment-menu-${id}`);
        if (menu) {
            menu.classList.toggle('show');
        }
    };

    /**
     * 跳转到上下文
     */
    App.comments.jumpToContext = function (commentId) {
        const comment = App.comments.state.comments.find(c => c.id === commentId);
        if (!comment) return;

        if (comment.target_type === 'trajectory') {
            // Switch to trajectory tab
            if (App.main && App.main.switchTab) App.main.switchTab('trajectory');

            // Wait for render
            setTimeout(async () => {
                const logDisplay = document.getElementById('log-display');
                if (!logDisplay) return;

                // 1. Try to find specific event block by ID
                let container = null;
                if (comment.target_ref && comment.target_ref !== 'current') {
                    // Try to find the element
                    // The mainContent.js renders text entries as: div.dataset.eventId = event.id
                    // And json entries (details) as: details.dataset.eventId = event.id
                    container = document.querySelector(`[data-event-id="${comment.target_ref}"]`);
                }

                if (container) {
                    // Check if it is a details element and open it if needed
                    const details = container.closest('details') || (container.tagName === 'DETAILS' ? container : null);

                    if (details) {
                        if (!details.open) {
                            details.open = true;
                            // Trigger lazy load if not loaded
                            if (!details.dataset.loaded) {
                                details.dispatchEvent(new Event('toggle'));
                                // Wait for loading to finish (poll for dataset.loaded)
                                let attempts = 0;
                                while (!details.dataset.loaded && attempts < 20) {
                                    await new Promise(r => setTimeout(r, 100));
                                    attempts++;
                                }
                            }
                        } else if (!details.dataset.loaded) {
                            // Case where it might be open but content fail/not loaded? trigger just in case
                            details.dispatchEvent(new Event('toggle'));
                            let attempts = 0;
                            while (!details.dataset.loaded && attempts < 20) {
                                await new Promise(r => setTimeout(r, 100));
                                attempts++;
                            }
                        }
                    }

                    // Now highlight text logic
                    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    container.classList.add('highlight-context');
                    setTimeout(() => container.classList.remove('highlight-context'), 2000);

                    // Try to select the specific text if possible
                    if (window.getSelection) {
                        // Find the text node containing the content
                        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
                        let node;
                        while (node = walker.nextNode()) {
                            const idx = node.textContent.indexOf(comment.original_content);
                            if (idx !== -1) {
                                const range = document.createRange();
                                range.setStart(node, idx);
                                range.setEnd(node, idx + comment.original_content.length);
                                const sel = window.getSelection();
                                sel.removeAllRanges();
                                sel.addRange(range);
                                break;
                            }
                        }
                    }
                } else {
                    // Fallback to global search if ID not found or legacy comment
                    const walker = document.createTreeWalker(logDisplay, NodeFilter.SHOW_TEXT, null, false);
                    let node;
                    while (node = walker.nextNode()) {
                        if (node.textContent.includes(comment.original_content)) {
                            // Ensure parent details is open
                            const details = node.parentElement.closest('details');
                            if (details && !details.open) {
                                details.open = true;
                                details.dispatchEvent(new Event('toggle'));
                                await new Promise(r => setTimeout(r, 500)); // Wait for render
                            }

                            node.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            node.parentElement.classList.add('highlight-context');
                            setTimeout(() => node.parentElement.classList.remove('highlight-context'), 2000);

                            // Selection
                            if (window.getSelection) {
                                const range = document.createRange();
                                const start = node.textContent.indexOf(comment.original_content);
                                range.setStart(node, start);
                                range.setEnd(node, start + comment.original_content.length);
                                const sel = window.getSelection();
                                sel.removeAllRanges();
                                sel.addRange(range);
                            }
                            break;
                        }
                    }
                }
            }, 300); // Increased delay slightly

        } else if (comment.target_type === 'artifact') {
            // Need to open the file
            // Assuming target_ref is the filename

            // 1. Switch to files tab
            if (App.main && App.main.switchTab) App.main.switchTab('files');

            setTimeout(() => {
                const items = document.querySelectorAll('.file-item, .file-tree-file');
                let found = false;
                items.forEach(item => {
                    if (item.textContent.trim().includes(comment.target_ref)) {
                        item.click();
                        found = true;
                    }
                });

                if (found) {
                    // Wait for preview to open
                    setTimeout(() => {
                        const previewBody = document.getElementById('preview-body');
                        if (previewBody) {
                            // Search text
                            const content = previewBody.textContent;
                            const idx = content.indexOf(comment.original_content);
                            if (idx !== -1) {
                                if (window.find && window.getSelection) {
                                    window.find(comment.original_content);
                                }
                            }
                        }
                    }, 500);
                } else {
                    App.toast.show('找不到关联的文件');
                }
            }, 100);
        }
    };

})();
