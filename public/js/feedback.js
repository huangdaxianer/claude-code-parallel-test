/**
 * 反馈模块
 * Feedback sidebar logic
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.feedback = {};

    /**
     * 自动打开反馈侧边栏
     */
    App.feedback.autoOpenFeedbackSidebar = function () {
        const sidebar = document.getElementById('feedback-sidebar');
        if (!sidebar) return;

        if (!App.state.isStatsMode && !App.state.isCompareMode && App.state.activeFolder) {
            const currentRun = App.state.currentRuns.find(r => r.folderName === App.state.activeFolder);
            if (currentRun && (currentRun.status === 'completed' || currentRun.status === 'success' || currentRun.status === 'evaluated')) {
                App.feedback.openFeedbackSidebar();
            } else {
                App.feedback.closeFeedbackSidebar();
            }
        } else {
            App.feedback.closeFeedbackSidebar();
        }
    };

    /**
     * 关闭反馈侧边栏
     */
    App.feedback.closeFeedbackSidebar = function () {
        const sidebar = document.getElementById('feedback-sidebar');
        if (sidebar) {
            sidebar.classList.remove('open');
        }
    };

    /**
     * 防抖提交反馈
     */
    App.feedback.debouncedSubmitFeedback = function () {
        if (App.state.feedbackDebounceTimer) clearTimeout(App.state.feedbackDebounceTimer);
        App.state.feedbackDebounceTimer = setTimeout(App.feedback.submitFeedback, 500);
    };

    /**
     * 打开反馈侧边栏
     */
    App.feedback.openFeedbackSidebar = async function () {
        if (!App.state.currentTaskId || !App.state.activeFolder) return;

        const sidebar = document.getElementById('feedback-sidebar');

        if (sidebar.classList.contains('open') && sidebar.dataset.activeRun === App.state.activeFolder) {
            return;
        }

        // 默认显示打分评价标签
        App.feedback.switchTab(App.state.activeFeedbackTab || 'scoring');

        sidebar.classList.add('open');
        const scoringBody = document.getElementById('feedback-body-scoring');
        if (scoringBody) {
            scoringBody.innerHTML = '<div style="text-align:center; padding:2rem; color:#94a3b8;">加载中...</div>';
        }

        const run = App.state.currentRuns.find(r => r.folderName === App.state.activeFolder);
        const modelId = run ? run.modelId : (App.state.activeFolder.includes('/') ? App.state.activeFolder.split('/').pop() : App.state.activeFolder);

        try {
            if (App.state.feedbackQuestions.length === 0) {
                App.state.feedbackQuestions = await App.api.getFeedbackQuestions();
            }

            const checkData = await App.api.checkFeedback(App.state.currentTaskId, modelId);
            const existingMap = {};
            if (checkData.exists) {
                checkData.feedback.forEach(f => {
                    existingMap[f.question_id] = f;
                });
            }

            App.feedback.renderFeedbackForm(existingMap);
            sidebar.dataset.activeRun = App.state.activeFolder;

        } catch (e) {
            console.error("Failed to load feedback:", e);
            const scoringBody = document.getElementById('feedback-body-scoring');
            if (scoringBody) {
                scoringBody.innerHTML = '<div style="text-align:center; padding:2rem; color:#ef4444;">加载失败，请刷新重试</div>';
            }
        }
    };

    /**
     * 渲染反馈表单
     */
    App.feedback.renderFeedbackForm = function (existingMap) {
        existingMap = existingMap || {};
        const container = document.getElementById('feedback-body-scoring');
        if (!container) return;

        if (App.state.feedbackQuestions.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding:2rem; color:#94a3b8;">暂无评测题目</div>';
            return;
        }

        let html = '';

        App.state.feedbackQuestions.forEach(q => {
            const existing = existingMap[q.id];
            const score = existing ? existing.score : 0;
            const comment = existing ? existing.comment : '';

            html += `
                <div class="feedback-item" data-qid="${q.id}">
                    <label class="feedback-label">
                        ${q.is_required ? '<span class="required-star">*</span>' : ''}
                        ${App.utils.escapeHtml(q.stem)}
                    </label>
                    ${q.description ? `<div class="feedback-desc">${App.utils.escapeHtml(q.description)}</div>` : ''}
                    
                    ${(function () {
                    const options = JSON.parse(q.options_json || '[]');
                    const hasOptions = options.length > 0 && options.some(o => o.trim() !== '');

                    if (hasOptions) {
                        let optionsHtml = `<div class="radio-options" data-value="${score}">`;
                        const labels = q.scoring_type === 'stars_5' ? ['非常差', '差', '一般', '好', '非常好'] : ['差', '一般', '好'];

                        options.forEach((opt, idx) => {
                            const val = idx + 1;
                            optionsHtml += `
                                    <div class="radio-option ${score === val ? 'active' : ''}" data-val="${val}">
                                        <div class="radio-circle"></div>
                                        <div style="flex:1">
                                            <div class="radio-label">${App.utils.escapeHtml(opt || labels[idx] || val + '分')}</div>
                                        </div>
                                    </div>
                                `;
                        });
                        optionsHtml += `</div>`;
                        return optionsHtml;
                    } else {
                        return `
                                <div class="star-rating" data-max="${q.scoring_type === 'stars_5' ? 5 : 3}" data-value="${score}">
                                    ${App.feedback.renderStars(q.scoring_type === 'stars_5' ? 5 : 3, score)}
                                </div>
                            `;
                    }
                })()}
                    
                    ${q.has_comment ? `
                        <textarea class="feedback-comment" placeholder="请输入评论（可选）" rows="2" 
                            style="width:100%; border:1px solid #e2e8f0; border-radius:6px; padding:0.5rem; margin-top:0.5rem; font-size:0.9rem;"
                        >${App.utils.escapeHtml(comment || '')}</textarea>
                    ` : ''}
                </div>
            `;
        });

        container.innerHTML = html;

        // 绑定星星点击事件
        container.querySelectorAll('.star-rating').forEach(el => {
            const stars = el.querySelectorAll('.star');
            stars.forEach(star => {
                star.addEventListener('click', function () {
                    const val = parseInt(this.dataset.val);
                    App.feedback.updateStars(el, val);
                    App.feedback.submitFeedback();
                });
            });
        });

        // 绑定选项点击事件
        container.querySelectorAll('.radio-options').forEach(el => {
            const options = el.querySelectorAll('.radio-option');
            options.forEach(opt => {
                opt.addEventListener('click', function () {
                    const val = parseInt(this.dataset.val);
                    el.querySelectorAll('.radio-option').forEach(o => o.classList.remove('active'));
                    this.classList.add('active');
                    el.dataset.value = val;
                    App.feedback.submitFeedback();
                });
            });
        });

        container.querySelectorAll('.feedback-comment').forEach(textarea => {
            textarea.addEventListener('input', App.feedback.debouncedSubmitFeedback);
        });
    };

    /**
     * 渲染星星
     */
    App.feedback.renderStars = function (max, current) {
        let html = '';
        for (let i = 1; i <= max; i++) {
            html += `<span class="star ${i <= current ? 'active' : ''}" data-val="${i}">★</span>`;
        }
        return html;
    };

    /**
     * 更新星星
     */
    App.feedback.updateStars = function (container, value) {
        const stars = container.querySelectorAll('.star');
        stars.forEach(s => {
            const v = parseInt(s.dataset.val);
            if (v <= value) s.classList.add('active');
            else s.classList.remove('active');
        });
        container.dataset.value = value;
    };

    /**
     * 提交反馈
     */
    App.feedback.submitFeedback = async function () {
        if (!App.state.currentTaskId || !App.state.activeFolder) return;

        const responses = [];
        const items = document.querySelectorAll('.feedback-item');

        items.forEach(item => {
            const qid = parseInt(item.dataset.qid);
            const starsContainer = item.querySelector('.star-rating');
            const radioContainer = item.querySelector('.radio-options');

            let score = 0;
            if (starsContainer) {
                score = parseInt(starsContainer.dataset.value);
                if (isNaN(score)) {
                    score = item.querySelectorAll('.star.active').length;
                }
            } else if (radioContainer) {
                score = parseInt(radioContainer.dataset.value);
            }

            const commentEl = item.querySelector('.feedback-comment');
            const comment = commentEl ? commentEl.value.trim() : '';

            if (score > 0 || comment !== '') {
                responses.push({
                    questionId: qid,
                    score: score,
                    comment: comment
                });
            }
        });

        if (responses.length === 0) return;

        const run = App.state.currentRuns.find(r => r.folderName === App.state.activeFolder);
        const modelId = run ? run.modelId : (App.state.activeFolder.includes('/') ? App.state.activeFolder.split('/').pop() : App.state.activeFolder);

        try {
            const data = await App.api.submitFeedback(App.state.currentTaskId, modelId, responses);
            if (data.success) {
                App.fetchTaskDetails();
            }
        } catch (e) {
            console.error('Auto-save feedback failed:', e);
        }
    };

    /**
     * 切换反馈标签
     */
    App.feedback.switchTab = function (tabName) {
        tabName = tabName || 'scoring';
        console.log('Switching feedback tab to:', tabName);
        const sidebar = document.getElementById('feedback-sidebar');
        if (!sidebar) return;

        App.state.activeFeedbackTab = tabName;

        // 更新按钮状态
        const tabs = sidebar.querySelectorAll('.feedback-header .tab');
        tabs.forEach(tab => {
            if (tab.dataset.tab === tabName) {
                tab.classList.add('active');
            } else {
                tab.classList.remove('active');
            }
        });

        // 更新内容显示
        const contents = sidebar.querySelectorAll('.tab-content');
        contents.forEach(content => {
            if (content.id === `feedback-body-${tabName}`) {
                content.classList.add('active');
                content.style.display = 'flex'; // Ensure flex for layout

                // If switching to comments, load them
                if (tabName === 'comments' && App.comments && App.comments.loadComments) {
                    App.comments.loadComments();

                    // 同步开关状态
                    setTimeout(() => {
                        const toggle = document.getElementById('comment-highlight-toggle');
                        if (toggle) {
                            // 确保开关与状态一致
                            toggle.checked = App.comments.state.highlightEnabled;
                        }
                    }, 0);
                }
            } else if (content.id && content.id.startsWith('feedback-body-')) {
                content.classList.remove('active');
                content.style.display = 'none';
            }
        });
    };

})();
