/**
 * 评论反馈模块
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.comments = {};

    App.comments.state = {
        selection: null,
        comments: [],
        commentRanges: [], // Store ranges for hit testing
        activeRefIcon: null,
        highlightEnabled: true // 默认开启高亮
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

        // 初始化点击交互，用于点击高亮评论区域跳转
        App.comments.initClickInteraction();
    };

    /**
     * 加载当前任务的评论
     */
    App.comments.loadComments = async function () {
        if (!App.state.currentTaskId || !App.state.activeFolder) return;

        const run = App.state.currentRuns.find(r => r.folderName === App.state.activeFolder);
        const modelId = run ? run.modelId : (App.state.activeFolder.includes('/') ? App.state.activeFolder.split('/').pop() : App.state.activeFolder);

        try {
            const comments = await App.api.getComments(App.state.currentTaskId, modelId);
            App.comments.state.comments = comments;
            App.comments.renderComments(comments);
            App.comments.highlightAllComments(); // Trigger highlight
        } catch (e) {
            console.error('Failed to load comments:', e);
            document.getElementById('comments-list').innerHTML = '<div style="text-align:center; padding:2rem; color:#ef4444;">加载失败</div>';
        }
    };

    /**
     * 高亮所有评论对应的文本
     */
    App.comments.highlightAllComments = function () {
        if (!window.Highlight || !window.CSS || !CSS.highlights) return;

        // 如果高亮开关关闭，则不显示高亮
        if (!App.comments.state.highlightEnabled) {
            if (CSS.highlights.get('comment-persistent')) {
                CSS.highlights.delete('comment-persistent');
            }
            return;
        }

        const ranges = [];
        App.comments.state.commentRanges = []; // Reset storage
        const comments = App.comments.state.comments || [];

        comments.forEach(comment => {
            if (!comment.original_content) return;

            let container = null;

            // Determine container based on target type
            if (comment.target_type === 'artifact') {
                // For artifact comments, find the preview body
                const previewBody = document.getElementById('preview-body');
                if (previewBody) {
                    container = previewBody;
                }
            } else if (comment.target_type === 'trajectory') {
                // For trajectory comments, find log display or specific event
                const logDisplay = document.getElementById('log-display');
                if (!logDisplay) return;

                container = logDisplay;
                if (comment.target_ref && comment.target_ref !== 'current') {
                    const specific = document.querySelector(`[data-event-id="${comment.target_ref}"]`);
                    if (specific) {
                        // 检查是否是折叠的details元素，如果是则展开它
                        if (specific.tagName === 'DETAILS') {
                            if (!specific.open) {
                                // 暂时展开以加载内容
                                specific.open = true;
                                // 触发toggle事件来加载内容
                                specific.dispatchEvent(new Event('toggle'));
                            }
                            // 等待内容加载
                            if (!specific.dataset.loaded) {
                                // 等待内容加载（最多5次，每次100ms）
                                let attempts = 0;
                                while (!specific.dataset.loaded && attempts < 50) {
                                    // 使用同步等待避免异步问题
                                    new Promise(resolve => setTimeout(resolve, 10));
                                    attempts++;
                                }
                            }
                        }
                        container = specific;
                    }
                }
            }

            if (!container) return;

            let selectionRange = {};
            try { selectionRange = JSON.parse(comment.selection_range || '{}'); } catch (e) { }

            const targetOffset = selectionRange.startOffset !== undefined ? selectionRange.startOffset : -1;
            const range = App.comments.findBestRangeMatch(container, comment.original_content, targetOffset);

            if (range) {
                // Determine if we need to split the range (cross-element)
                const safe = App.comments.getSafeRanges(range);
                ranges.push(...safe);

                App.comments.state.commentRanges.push({ range, commentId: comment.id });
            }
        });

        const highlight = new Highlight(...ranges);
        CSS.highlights.set('comment-persistent', highlight);
    };

    /**
     * Initialize click interaction for comments
     */
    App.comments.initClickInteraction = function () {
        const container = document.body;

        container.addEventListener('click', function (e) {
            // Check if click is on a highlighted comment range
            App.comments.handleClick(e);
        });
    };

    /**
     * Handle click to detect if over a highlighted comment
     */
    App.comments.handleClick = function (e) {
        // Ignore clicks on UI elements
        if (e.target.closest('.floating-comment-btn') ||
            e.target.closest('.comment-input-popover') ||
            e.target.closest('.comment-more-btn') ||
            e.target.closest('.comment-menu-popup') ||
            e.target.closest('.comment-card')) {
            return;
        }

        // Get selection/caret position from click
        let range;
        try {
            if (document.caretRangeFromPoint) {
                range = document.caretRangeFromPoint(e.clientX, e.clientY);
            } else if (document.caretPositionFromPoint) {
                const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
                if (pos) {
                    range = document.createRange();
                    range.setStart(pos.offsetNode, pos.offset);
                    range.setEnd(pos.offsetNode, pos.offset);
                }
            }
        } catch (err) {
            // Ignore errors (e.g. out of bounds)
        }

        if (!range) return;

        // Check intersection with known valid ranges
        const hit = App.comments.state.commentRanges.find(item => {
            return range.compareBoundaryPoints(Range.START_TO_START, item.range) >= 0 &&
                range.compareBoundaryPoints(Range.END_TO_END, item.range) <= 0;
        });

        if (hit) {
            e.preventDefault();
            e.stopPropagation();
            App.comments.jumpToComment(hit.commentId);
        }
    };

    /**
     * Handle hover to detect if over a highlighted comment
     */
    App.comments.handleHover = function (e) {
        // If hovering over the icon itself, do nothing (keep it shown)
        if (e.target.classList.contains('comment-ref-icon') || e.target.closest('.comment-ref-icon')) return;

        // Hide existing icon if moved away (will be re-shown if hit)
        // Check if we are still close to the active icon?
        // Simpler: caretRangeFromPoint to see if we hit a range

        let range;
        try {
            if (document.caretRangeFromPoint) {
                range = document.caretRangeFromPoint(e.clientX, e.clientY);
            } else if (document.caretPositionFromPoint) {
                const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
                if (pos) {
                    range = document.createRange();
                    range.setStart(pos.offsetNode, pos.offset);
                    range.setEnd(pos.offsetNode, pos.offset);
                }
            }
        } catch (err) {
            // Ignore errors (e.g. out of bounds)
        }

        if (!range) {
            App.comments.hideRefIcon();
            return;
        }

        // Check intersection with known valid ranges
        // We look for strict containment of our cursor position within the comment range
        const hit = App.comments.state.commentRanges.find(item => {
            return range.compareBoundaryPoints(Range.START_TO_START, item.range) >= 0 &&
                range.compareBoundaryPoints(Range.END_TO_END, item.range) <= 0;
            // Note: caret range is collapsed, so START_TO_START >= 0 means caret is after start
            // END_TO_END <= 0 means caret is before end
        });

        if (hit) {
            App.comments.showRefIcon(e.clientX, e.clientY, hit.commentId);
        } else {
            App.comments.hideRefIcon();
        }
    };

    /**
     * Show the floating reference icon
     */
    App.comments.showRefIcon = function (x, y, commentId) {
        // If already showing for this ID, just update pos or ignore
        if (App.comments.state.activeRefIcon && App.comments.state.activeRefIcon.dataset.commentId === commentId) {
            return;
        }

        App.comments.hideRefIcon();

        const icon = document.createElement('div');
        icon.className = 'comment-ref-icon';
        icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>';
        icon.dataset.commentId = commentId;

        // Position slightly offset from cursor
        icon.style.left = `${x + 10}px`;
        icon.style.top = `${y - 25}px`;

        icon.onclick = (e) => {
            e.stopPropagation();
            App.comments.jumpToComment(commentId);
        };

        document.body.appendChild(icon);
        App.comments.state.activeRefIcon = icon;
    };

    /**
     * Hide the reference icon
     */
    App.comments.hideRefIcon = function () {
        if (App.comments.state.activeRefIcon) {
            App.comments.state.activeRefIcon.remove();
            App.comments.state.activeRefIcon = null;
        }
    };

    /**
     * Jump to the comment in the sidebar
     */
    App.comments.jumpToComment = function (commentId) {
        // 1. Ensure tab is open
        const feedbackBtn = document.querySelector('.sidebar-tab[data-tab="feedback"]');
        if (feedbackBtn && !feedbackBtn.classList.contains('active')) {
            if (App.feedback && App.feedback.switchTab) {
                App.feedback.switchTab('comments');
            }
        } else {
            // If already in feedback but maybe not comments subtab?
            // Not easily checked, but usually safe to just ensure sidebar is viewed.
            // Actually, switchTab('comments') in feedback.js handles internal tab switching too.
            if (App.feedback && App.feedback.switchTab) App.feedback.switchTab('comments');
        }

        setTimeout(() => {
            const card = document.querySelector(`.comment-card[data-id="${commentId}"]`);
            if (card) {
                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                card.classList.add('highlight-flash');
                setTimeout(() => card.classList.remove('highlight-flash'), 2000);
            }
        }, 100);
    };
    /**
     * 渲染评论列表
     */
    App.comments.renderComments = function (comments) {
        const container = document.getElementById('comments-list');
        const emptyHint = document.getElementById('comment-empty-hint');
        const highlightToggle = document.getElementById('highlight-toggle-wrapper');
        if (!container) return;

        if (comments.length === 0) {
            container.innerHTML = '';
            // Show hint, hide toggle
            if (emptyHint) emptyHint.style.display = '';
            if (highlightToggle) highlightToggle.style.display = 'none';
            return;
        }

        // Hide hint, show toggle
        if (emptyHint) emptyHint.style.display = 'none';
        if (highlightToggle) highlightToggle.style.display = '';

        let html = '';
        comments.forEach(c => {
            html += `
                <div class="comment-card" data-id="${c.id}" onclick="App.comments.jumpToContext(${c.id})">
                    ${App.state.currentUser && (App.state.currentUser.id === c.user_id || App.state.currentUser.role === 'admin') ? `
                    <button class="comment-more-btn" onclick="event.stopPropagation(); App.comments.toggleMenu(${c.id}, event)">⋮</button>
                    <div id="comment-menu-${c.id}" class="comment-menu-popup">
                        <button class="comment-delete-item" onclick="event.stopPropagation(); App.comments.deleteComment(${c.id})">
                            🗑️ 删除反馈
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

        // Get the initial range
        let range = selection.getRangeAt(0).cloneRange();

        // Extract text from range, excluding problematic elements like .json-summary
        // Clone the range contents and remove unwanted elements before getting text
        let text = '';
        try {
            const fragment = range.cloneContents();

            // Remove all .json-summary, .json-type-badge, and .json-preview-text elements
            const unwanted = fragment.querySelectorAll('.json-summary, .json-type-badge, .json-preview-text, .json-log-entry details');
            unwanted.forEach(el => el.remove());

            // Also remove closed details elements (they shouldn't contribute to selection)
            const details = fragment.querySelectorAll('details:not([open])');
            details.forEach(el => el.remove());

            text = fragment.textContent.trim();
        } catch (e) {
            // Fallback to simple toString
            text = range.toString().trim();
        }
        if (text.length < 1) {
            App.comments.hideFloatingButton();
            return;
        }

        // 确定选区所在的上下文
        let targetType = null;
        let targetRef = null;

        const anchorNode = selection.anchorNode.nodeType === 3 ? selection.anchorNode.parentElement : selection.anchorNode;

        // 1. 优先检查是否在代码预览中 (Preview Modal) - 更高优先级
        const previewBody = document.getElementById('preview-body');
        if (previewBody && previewBody.contains(anchorNode)) {
            targetType = 'artifact';
            // 获取当前文件路径
            const filenameEl = document.getElementById('preview-filename');
            targetRef = filenameEl ? filenameEl.textContent.trim() : 'unknown';
        }

        // 2. 如果不在预览中，检查是否在 Log Display 中 (Trajectory)
        if (!targetType) {
            const logDisplay2 = document.getElementById('log-display');
            if (logDisplay2 && logDisplay2.contains(anchorNode)) {
                targetType = 'trajectory';
                // 尝试找到所属的 event-id
                const entry = (anchorNode.nodeType === 3 ? anchorNode.parentElement : anchorNode).closest('[data-event-id]');
                if (entry) {
                    targetRef = entry.dataset.eventId;
                } else {
                    targetRef = 'current'; // Fallback
                }
            }
        }

        if (targetType) {
            // Use the trimmed range we already have instead of getting a new one
            // let range = selection.getRangeAt(0).cloneRange(); // WRONG: This gets the original untrimmed range

            const rect = range.getBoundingClientRect();

            // Calculate precise offset based on target type
            let startOffset = 0;
            let entryForOffset = null;

            if (targetType === 'artifact') {
                // For artifacts, offset is relative to the preview body
                entryForOffset = previewBody;
            } else if (targetType === 'trajectory') {
                // 1. Determine Target/Entry
                // Check if start and end are in the same event
                const startNode = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
                const endNode = range.endContainer.nodeType === 3 ? range.endContainer.parentElement : range.endContainer;

                const startEntry = startNode.closest('[data-event-id]');
                const endEntry = endNode.closest('[data-event-id]');

                // If spanning multiple events (or outside any event), use global scope
                if (startEntry && endEntry && startEntry === endEntry) {
                    // Intra-event: Keep targetRef specific
                    targetRef = startEntry.dataset.eventId;
                } else {
                    // Inter-event or partial: Use global
                    targetRef = 'current';
                }

                const logDisplay = document.getElementById('log-display');

                // If global, offset is relative to logDisplay
                entryForOffset = (targetRef !== 'current') ?
                    document.querySelector(`[data-event-id="${targetRef}"]`) :
                    logDisplay;
            }

            if (entryForOffset && entryForOffset.contains(range.startContainer)) {
                startOffset = App.comments.calculateCharacterOffset(entryForOffset, range.startContainer, range.startOffset);
            }

            App.comments.state.selection = {
                text: text,
                targetType: targetType,
                targetRef: targetRef,
                rect: rect,
                range: range,
                startOffset: startOffset
            };

            App.comments.showFloatingButton(rect);
        } else {
            App.comments.hideFloatingButton();
        }
    };

    /**
     * Get safe ranges for highlighting (excluding sensitive UI elements like headers)
     */
    App.comments.getSafeRanges = function (range) {
        const ranges = [];
        const container = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;

        // Find all summaries in the range
        // Since we can't easily query "inside range", we query container and check intersection
        const summaries = container.querySelectorAll('.json-summary');
        let currentStart = range.startContainer;
        let currentStartOffset = range.startOffset;

        // We need to cut holes in the range
        // Algorithm:
        // 1. Collect all summaries that intersect the range
        // 2. Sort them by position
        // 3. Create sub-ranges between them

        const intersections = [];
        summaries.forEach(sum => {
            if (range.intersectsNode(sum)) {
                intersections.push(sum);
            }
        });

        if (intersections.length === 0) {
            return [range];
        }

        // Just return the original range if complex? 
        // No, we want to solve the user's issue.
        // Simple approach: Use TreeWalker to walk text nodes, skipping those in summary? 
        // Too slow.

        // Split approach:
        let original = range.cloneRange();
        const safeRanges = [];

        // We iterate summaries and "subtract" them.
        // However, Range subtraction is hard.
        // Let's rely on the fact that summaries are BLOCK elements usually.

        intersections.forEach(sum => {
            const sumRange = document.createRange();
            sumRange.selectNodeContents(sum);

            // If original starts before sum, adds a segment before sum
            if (original.compareBoundaryPoints(Range.START_TO_START, sumRange) < 0) {
                const before = original.cloneRange();
                before.setEnd(sumRange.startContainer, sumRange.startOffset);
                safeRanges.push(before);
            }

            // Move start of original to end of sum
            if (original.compareBoundaryPoints(Range.END_TO_END, sumRange) > 0) {
                original.setStart(sumRange.endContainer, sumRange.endOffset);
            } else {
                // Original ends inside or at end of sum
                original.collapse(false); // finish
            }
        });

        if (!original.collapsed) {
            safeRanges.push(original);
        }

        return safeRanges;
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
        App.comments.state.selection = null;
    };

    /**
     * Handle click to detect if over a highlighted comment
     */
    App.comments.handleClick = function (e) {
        // 如果高亮关闭，不处理点击（但保留跳转到评论卡片的功能）
        if (!App.comments.state.highlightEnabled) {
            return;
        }

        // Ignore clicks on UI elements
        if (e.target.closest('.floating-comment-btn') ||
            e.target.closest('.comment-input-popover') ||
            e.target.closest('.comment-more-btn') ||
            e.target.closest('.comment-menu-popup') ||
            e.target.closest('.comment-card')) {
            return;
        }

        // Get selection/caret position from click
        let range;
        try {
            if (document.caretRangeFromPoint) {
                range = document.caretRangeFromPoint(e.clientX, e.clientY);
            } else if (document.caretPositionFromPoint) {
                const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
                if (pos) {
                    range = document.createRange();
                    range.setStart(pos.offsetNode, pos.offset);
                    range.setEnd(pos.offsetNode, pos.offset);
                }
            }
        } catch (err) {
            // Ignore errors (e.g. out of bounds)
        }

        if (!range) return;

        // Check intersection with known valid ranges
        const hit = App.comments.state.commentRanges.find(item => {
            return range.compareBoundaryPoints(Range.START_TO_START, item.range) >= 0 &&
                range.compareBoundaryPoints(Range.END_TO_END, item.range) <= 0;
        });

        if (hit) {
            e.preventDefault();
            e.stopPropagation();
            App.comments.jumpToComment(hit.commentId);
        }
    };

    /**
     * 显示输入框
     */
    App.comments.showInput = function (rect) {
        // Start Step 1: Hide button manually to preserve selection state
        const btn = document.getElementById('floating-comment-btn');
        if (btn) btn.style.display = 'none';
        // App.comments.hideFloatingButton(); // Do not call this as it clears selection
        // End Step 1

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
        popover.style.display = 'block';
        input.focus();

        // Use CSS Custom Highlight API to keep visual selection
        if (window.Highlight && window.CSS && CSS.highlights) {
            const range = App.comments.state.selection.range;
            if (range) {
                // Use safe ranges to exclude headers
                const safeRanges = App.comments.getSafeRanges(range);
                const highlight = new Highlight(...safeRanges);
                CSS.highlights.set('comment-selection', highlight);
            }
        }

        // Bind Enter to submit
        input.removeEventListener('keydown', App.comments.handleInputKeydown);
        input.addEventListener('keydown', App.comments.handleInputKeydown);
    };

    /**
     * Input keydown handler
     */
    App.comments.handleInputKeydown = function (e) {
        if (e.isComposing) return;
        if ((e.key === 'Enter' || e.keyCode === 13) && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            App.comments.submitComment();
        }
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

        const input = document.getElementById('comment-input-text');
        if (input) {
            input.removeEventListener('keydown', App.comments.handleInputKeydown);
        }

        window.getSelection().removeAllRanges(); // 清除选区
        App.comments.state.selection = null; // Clear selection state
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
        const modelId = run ? run.modelId : (App.state.activeFolder.includes('/') ? App.state.activeFolder.split('/').pop() : App.state.activeFolder);

        // 构造选区范围信息
        const selectionRange = {
            startOffset: sel.startOffset || 0,
            endOffset: (sel.startOffset || 0) + sel.text.length
        };

        try {
            await App.api.addComment({
                taskId: App.state.currentTaskId,
                modelId: modelId,
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
        // No confirmation
        try {
            await App.api.deleteComment(id);
            App.comments.loadComments();
            App.toast.show('评论已删除', 'success');
        } catch (e) {
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
     * 跳转到轨迹，作为辅助函数供jumpToContext使用
     */
    App.comments.jumpToContextTrajectory = async function (comment) {
        const logDisplay = document.getElementById('log-display');
        if (!logDisplay) return;

        // 1. Try to find specific event block by ID
        let container = logDisplay;
        if (comment.target_ref && comment.target_ref !== 'current') {
            const specific = document.querySelector(`[data-event-id="${comment.target_ref}"]`);
            if (specific) container = specific;
        }

        // Check if it is a details element and open it if needed
        const details = container.closest('details') || (container.tagName === 'DETAILS' ? container : null);
        if (details && !details.open) {
            details.open = true;
            details.dispatchEvent(new Event('toggle'));
            let attempts = 0;
            while (!details.dataset.loaded && attempts < 20) {
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }
        }

        // Now highlight text logic
        container.classList.add('highlight-context');
        setTimeout(() => container.classList.remove('highlight-context'), 2000);

        let scrolled = false;

        // Try to select the specific text if possible
        if (window.getSelection) {
            let selectionRange = {};
            try { selectionRange = JSON.parse(comment.selection_range || '{}'); } catch (e) { }

            const targetOffset = selectionRange.startOffset !== undefined ? selectionRange.startOffset : -1;
            const range = App.comments.findBestRangeMatch(container, comment.original_content, targetOffset);

            if (range) {
                scrolled = true;

                // Precise scroll using a temporary anchor
                const anchor = document.createElement('span');
                range.startContainer.parentNode.insertBefore(anchor, range.startContainer);
                anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });

                if (window.Highlight && window.CSS && CSS.highlights) {
                    const safeRanges = App.comments.getSafeRanges(range);
                    const highlight = new Highlight(...safeRanges);
                    CSS.highlights.set('comment-selection', highlight);
                }

                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);

                setTimeout(() => {
                    if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
                }, 2000);
            }
        }

        if (!scrolled) {
            container.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    };

    /**
     * 跳转到上下文
     */
    App.comments.jumpToContext = function (commentId) {
        const comment = App.comments.state.comments.find(c => c.id === commentId);
        if (!comment) return;

        if (comment.target_type === 'trajectory') {
            // Trajectory comments should always show in the trajectory view
            // Do NOT try to detect file paths in the content - that's the wrong behavior
            // The comment is about the trajectory content itself, not about opening files

            if (App.main && App.main.switchTab) App.main.switchTab('trajectory');

            setTimeout(() => {
                App.comments.jumpToContextTrajectory(comment);
            }, 300);

        } else if (comment.target_type === 'artifact') {
            // Need to open the file
            // Assuming target_ref is the filename

            // 1. Switch to files tab
            if (App.main && App.main.switchTab) App.main.switchTab('files');

            setTimeout(() => {
                // Try precise match via data-full-path first
                let targetItem = document.querySelector(`.file-tree-file[data-full-path="${comment.target_ref}"]`);

                // Fallback to text search if not found
                if (!targetItem) {
                    const items = document.querySelectorAll('.file-item, .file-tree-file');
                    for (const item of items) {
                        if (item.textContent.trim() === comment.target_ref || item.textContent.trim().endsWith(comment.target_ref)) {
                            targetItem = item;
                            break;
                        }
                    }
                }

                if (targetItem) {
                    // Auto-expand parent folders
                    let parent = targetItem.parentElement;
                    while (parent && !parent.classList.contains('file-list')) { // Stop at root container
                        if (parent.classList.contains('file-tree-children') && !parent.classList.contains('expanded')) {
                            // Find the toggle header
                            const header = parent.previousElementSibling;
                            if (header && header.classList.contains('file-tree-header')) {
                                header.click(); // Simulate click to expand
                            }
                        }
                        parent = parent.parentElement;
                    }

                    // Click the file itself
                    targetItem.click();

                    // Wait for preview to open and highlight the text
                    setTimeout(() => {
                        App.comments.highlightArtifactComment(comment);
                    }, 500);
                } else {
                    App.toast.show('找不到关联的文件');
                }
            }, 100);
        }
    };

    /**
     * 高亮 artifact 评论中的文本
     */
    App.comments.highlightArtifactComment = function (comment) {
        const previewBody = document.getElementById('preview-body');
        if (!previewBody || !comment.original_content) return;

        // Parse selection range to get the offset
        let selectionRange = {};
        try { selectionRange = JSON.parse(comment.selection_range || '{}'); } catch (e) { }

        const targetOffset = selectionRange.startOffset !== undefined ? selectionRange.startOffset : -1;
        const range = App.comments.findBestRangeMatch(previewBody, comment.original_content, targetOffset);

        if (range) {
            // Scroll to the highlighted text
            const anchor = document.createElement('span');
            range.startContainer.parentNode.insertBefore(anchor, range.startContainer);
            anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // Apply CSS Highlight API for persistent highlighting
            if (window.Highlight && window.CSS && CSS.highlights) {
                const safeRanges = App.comments.getSafeRanges(range);
                const highlight = new Highlight(...safeRanges);
                CSS.highlights.set('comment-selection', highlight);
            }

            // Also select the text
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);

            // Remove the anchor after scrolling
            setTimeout(() => {
                if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
            }, 2000);
        } else {
            console.warn('[highlightArtifactComment] Could not find text:', comment.original_content);
        }
    };

    /**
     * Find the best range match for a piece of text within a container,
     * prioritizing the one closest to the target character offset.
     */
    App.comments.findBestRangeMatch = function (container, text, targetOffset) {
        // Get the full text content of the container
        const fullText = container.textContent;

        // Find all occurrences of the target text in the full content
        const occurrences = [];
        let searchFrom = 0;
        while (true) {
            const idx = fullText.indexOf(text, searchFrom);
            if (idx === -1) break;
            occurrences.push(idx);
            searchFrom = idx + 1;
        }

        if (occurrences.length === 0) {
            console.warn('[findBestRangeMatch] No occurrences found for:', text);
            return null;
        }

        // Pick the best occurrence based on distance from targetOffset
        let bestGlobalOffset;
        if (targetOffset === -1) {
            bestGlobalOffset = occurrences[0];
        } else {
            let minDistance = Infinity;
            occurrences.forEach(occ => {
                const distance = Math.abs(occ - targetOffset);
                if (distance < minDistance) {
                    minDistance = distance;
                    bestGlobalOffset = occ;
                }
            });
        }

        // Now convert global character offsets to actual DOM Range
        // We need to find the text nodes that contain these offsets
        const startPosition = App.comments.findNodeAtCharacterOffset(container, bestGlobalOffset);
        const endPosition = App.comments.findNodeAtCharacterOffset(container, bestGlobalOffset + text.length);

        if (!startPosition || !endPosition) {
            console.warn('[findBestRangeMatch] Could not find positions for offsets:', bestGlobalOffset, bestGlobalOffset + text.length);
            return null;
        }

        try {
            const range = document.createRange();
            range.setStart(startPosition.node, startPosition.offset);
            range.setEnd(endPosition.node, endPosition.offset);
            return range;
        } catch (e) {
            console.error('[findBestRangeMatch] Error creating range:', e);
            return null;
        }
    };

    /**
     * Calculate character offset relative to a container
     */
    App.comments.calculateCharacterOffset = function (container, targetNode, targetOffset) {
        let offset = 0;
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while (node = walker.nextNode()) {
            if (node === targetNode) {
                return offset + targetOffset;
            }
            offset += node.textContent.length;
        }
        return offset; // Fallback
    };

    /**
     * Find text node and local offset from a global character offset
     */
    App.comments.findNodeAtCharacterOffset = function (container, globalOffset) {
        let currentOffset = 0;
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while (node = walker.nextNode()) {
            const len = node.textContent.length;
            if (currentOffset + len >= globalOffset) {
                return { node: node, offset: globalOffset - currentOffset };
            }
            currentOffset += len;
        }
        return null;
    };

    /**
     * 切换评论高亮显示
     */
    App.comments.toggleHighlight = function (enabled) {
        App.comments.state.highlightEnabled = enabled;

        // 重新应用高亮
        if (enabled) {
            App.comments.highlightAllComments();
        } else {
            // 删除所有高亮
            if (window.CSS && CSS.highlights && CSS.highlights.get('comment-persistent')) {
                CSS.highlights.delete('comment-persistent');
            }
        }
    };

    // ==================== User Feedback Functions ====================

    /**
     * State for user feedback modal
     */
    App.comments.feedbackState = {
        selectedImages: [],
        userFeedback: [],
        currentModelId: null
    };

    /**
     * Open the feedback modal
     */
    App.comments.openFeedbackModal = function () {
        const modal = document.getElementById('add-feedback-modal');
        if (!modal) {
            console.error('Feedback modal not found');
            return;
        }

        // Check if there's an active folder/model selected
        if (!App.state.activeFolder) {
            App.toast.show('请先选择一个子任务', 'warning');
            return;
        }

        // Get the model id from the active folder
        const run = App.state.currentRuns.find(r => r.folderName === App.state.activeFolder);
        const modelId = run ? run.modelId : (App.state.activeFolder.includes('/') ? App.state.activeFolder.split('/').pop() : App.state.activeFolder);
        const displayName = run ? run.modelName : modelId;

        // Store the current model id for submission
        App.comments.feedbackState.currentModelId = modelId;

        // Reset form
        App.comments.feedbackState.selectedImages = [];
        const contentInput = document.getElementById('feedback-content-input');
        const imagePreview = document.getElementById('feedback-image-preview');
        const imageInput = document.getElementById('feedback-image-input');
        const modelNameInput = document.getElementById('feedback-model-name');

        if (contentInput) contentInput.value = '';
        if (imagePreview) imagePreview.innerHTML = '';
        if (imageInput) imageInput.value = '';
        if (modelNameInput) modelNameInput.value = displayName;

        modal.classList.add('show');
    };

    /**
     * Close the feedback modal
     */
    App.comments.closeFeedbackModal = function () {
        const modal = document.getElementById('add-feedback-modal');
        if (modal) modal.classList.remove('show');

        // Clear state
        App.comments.feedbackState.selectedImages = [];
        App.comments.feedbackState.currentModelId = null;
    };

    /**
     * Handle image selection
     */
    App.comments.handleImageSelect = function (event) {
        const files = Array.from(event.target.files);
        const maxImages = 10;

        // Limit to max images
        const currentCount = App.comments.feedbackState.selectedImages.length;
        const remainingSlots = maxImages - currentCount;
        const newFiles = files.slice(0, remainingSlots);

        if (files.length > remainingSlots) {
            App.toast.show(`最多只能上传${maxImages}张图片`, 'warning');
        }

        // Add new files to state
        App.comments.feedbackState.selectedImages.push(...newFiles);

        // Update preview
        App.comments.updateImagePreview();
    };

    /**
     * Update image preview
     */
    App.comments.updateImagePreview = function () {
        const container = document.getElementById('feedback-image-preview');
        if (!container) return;

        container.innerHTML = '';

        App.comments.feedbackState.selectedImages.forEach((file, index) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'feedback-image-item';
            wrapper.style.cssText = 'position: relative; display: inline-block;';

            const img = document.createElement('img');
            img.style.cssText = 'width: 60px; height: 60px; object-fit: cover; border-radius: 4px; border: 1px solid #e2e8f0;';

            // Create preview URL
            const url = URL.createObjectURL(file);
            img.src = url;
            img.onload = () => URL.revokeObjectURL(url);

            const removeBtn = document.createElement('button');
            removeBtn.innerHTML = '×';
            removeBtn.style.cssText = 'position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; background: #ef4444; color: white; border: none; cursor: pointer; font-size: 12px; line-height: 1; display: flex; align-items: center; justify-content: center;';
            removeBtn.onclick = () => App.comments.removeImage(index);

            wrapper.appendChild(img);
            wrapper.appendChild(removeBtn);
            container.appendChild(wrapper);
        });
    };

    /**
     * Remove an image from selection
     */
    App.comments.removeImage = function (index) {
        App.comments.feedbackState.selectedImages.splice(index, 1);
        App.comments.updateImagePreview();
    };

    /**
     * Submit user feedback
     */
    App.comments.submitUserFeedback = async function () {
        const contentInput = document.getElementById('feedback-content-input');

        const modelId = App.comments.feedbackState.currentModelId;
        const content = contentInput.value.trim();

        if (!modelId) {
            App.toast.show('无法确定子任务', 'warning');
            return;
        }

        if (!content) {
            App.toast.show('请输入反馈内容', 'warning');
            return;
        }

        const submitBtn = document.getElementById('submit-feedback-btn');
        submitBtn.disabled = true;
        submitBtn.textContent = '提交中...';

        try {
            await App.api.addUserFeedback({
                taskId: App.state.currentTaskId,
                modelId: modelId,
                userId: App.state.currentUser ? App.state.currentUser.id : null,
                content: content,
                images: App.comments.feedbackState.selectedImages
            });

            App.toast.show('反馈已提交', 'success');
            App.comments.closeFeedbackModal();

            // Reload user feedback
            App.comments.loadUserFeedback();

        } catch (e) {
            console.error('Submit user feedback failed:', e);
            App.toast.show('提交失败', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = '提交反馈';
        }
    };

    /**
     * Load user feedback for the current task
     */
    App.comments.loadUserFeedback = async function () {
        if (!App.state.currentTaskId || !App.state.activeFolder) return;

        try {
            const feedback = await App.api.getUserFeedback(App.state.currentTaskId);
            App.comments.feedbackState.userFeedback = feedback;

            // Filter feedback for current model only
            const run = App.state.currentRuns.find(r => r.folderName === App.state.activeFolder);
            const currentModelId = run ? run.modelId : (App.state.activeFolder.includes('/') ? App.state.activeFolder.split('/').pop() : App.state.activeFolder);

            const filteredFeedback = feedback.filter(f => f.model_id === currentModelId);
            App.comments.renderUserFeedback(filteredFeedback);
        } catch (e) {
            console.error('Failed to load user feedback:', e);
        }
    };

    /**
     * Render user feedback (already filtered by current model)
     */
    App.comments.renderUserFeedback = function (feedback) {
        const container = document.getElementById('user-feedback-list');
        if (!container) return;

        if (!feedback || feedback.length === 0) {
            container.innerHTML = '';
            return;
        }

        // Parse images for each feedback item
        const processedFeedback = feedback.map(f => {
            let images = [];
            if (f.images) {
                try { images = JSON.parse(f.images); } catch (e) { }
            }
            return { ...f, parsedImages: images };
        });

        // Render all feedback items together (no grouping by image/text type)
        let html = '';
        processedFeedback.forEach(f => {
            const hasImages = f.parsedImages && f.parsedImages.length > 0;
            html += App.comments.renderUserFeedbackCard(f, hasImages);
        });

        container.innerHTML = html;
    };

    /**
     * Render a single user feedback card
     */
    App.comments.renderUserFeedbackCard = function (feedback, hasImages) {
        const images = feedback.parsedImages || [];

        let imagesHtml = '';
        if (hasImages && images.length > 0) {
            imagesHtml = `<div class="user-feedback-images">`;
            images.forEach(imgPath => {
                imagesHtml += `<img src="/artifacts/${imgPath}" onclick="App.comments.showFullImage('/artifacts/${imgPath}')" />`;
            });
            imagesHtml += '</div>';
        }

        return `
            <div class="comment-card user-feedback-card" data-feedback-id="${feedback.id}">
                ${App.state.currentUser && (App.state.currentUser.id === feedback.user_id || App.state.currentUser.role === 'admin') ? `
                <button class="comment-more-btn" onclick="event.stopPropagation(); App.comments.toggleUserFeedbackMenu(${feedback.id}, event)">⋮</button>
                <div id="user-feedback-menu-${feedback.id}" class="comment-menu-popup">
                    <button class="comment-delete-item" onclick="event.stopPropagation(); App.comments.deleteUserFeedback(${feedback.id})">
                        🗑️ 删除反馈
                    </button>
                </div>` : ''}
                <div class="comment-text">${App.utils.escapeHtml(feedback.content)}</div>
                ${imagesHtml}
            </div>
        `;
    };

    /**
     * Toggle user feedback menu
     */
    App.comments.toggleUserFeedbackMenu = function (id, event) {
        // Close all other menus
        document.querySelectorAll('.comment-menu-popup').forEach(el => {
            if (el.id !== `user-feedback-menu-${id}`) el.classList.remove('show');
        });

        const menu = document.getElementById(`user-feedback-menu-${id}`);
        if (menu) {
            menu.classList.toggle('show');
        }
    };

    /**
     * Delete user feedback
     */
    App.comments.deleteUserFeedback = async function (id) {
        try {
            await App.api.deleteUserFeedback(id);
            App.toast.show('反馈已删除', 'success');
            App.comments.loadUserFeedback();
        } catch (e) {
            console.error('Delete user feedback failed:', e);
            App.toast.show('删除失败', 'error');
        }
    };

    /**
     * Show full size image in a modal/lightbox
     */
    App.comments.showFullImage = function (src) {
        // Create lightbox overlay
        const overlay = document.createElement('div');
        overlay.id = 'image-lightbox';
        overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.9); z-index: 9999; display: flex; align-items: center; justify-content: center; cursor: zoom-out;';
        overlay.onclick = () => overlay.remove();

        const img = document.createElement('img');
        img.src = src;
        img.style.cssText = 'max-width: 90%; max-height: 90%; object-fit: contain; border-radius: 4px;';

        overlay.appendChild(img);
        document.body.appendChild(overlay);
    };

    // Override loadComments to also load user feedback
    const originalLoadComments = App.comments.loadComments;
    App.comments.loadComments = async function () {
        await originalLoadComments.call(this);
        await App.comments.loadUserFeedback();
    };

})();

