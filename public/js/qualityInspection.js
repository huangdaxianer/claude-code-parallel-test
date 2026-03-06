/**
 * 反馈质检模块
 * Quality Inspection tab for admin users
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.qualityInspection = {};

    const QUESTIONS = [
        {
            key: 'task_quality',
            label: '请选择该任务的质量',
            options: ['高', '中', '低', '不可用']
        },
        {
            key: 'feedback_quality',
            label: '请选择该用户的反馈质量',
            options: ['完全可用', '部分可用', '完全不可用']
        }
    ];

    /**
     * 初始化：如果是管理员，动态添加质检 tab
     */
    App.qualityInspection.init = function () {
        if (!App.state.currentUser || App.state.currentUser.role !== 'admin') return;

        const tabsContainer = document.querySelector('#feedback-sidebar .feedback-header .tabs');
        if (!tabsContainer) return;

        // 避免重复添加
        if (tabsContainer.querySelector('[data-tab="qc"]')) return;

        const btn = document.createElement('button');
        btn.className = 'tab';
        btn.dataset.tab = 'qc';
        btn.textContent = '反馈质检';
        btn.onclick = function () { App.feedback.switchTab('qc'); };
        tabsContainer.appendChild(btn);
    };

    /**
     * 加载质检数据并渲染
     */
    App.qualityInspection.load = async function () {
        const container = document.getElementById('feedback-body-qc');
        if (!container) return;

        if (!App.state.currentTaskId || !App.state.activeFolder) {
            container.innerHTML = '<div class="qc-empty">请先选择一个模型运行</div>';
            return;
        }

        const run = App.state.currentRuns.find(r => r.folderName === App.state.activeFolder);
        const modelId = run ? run.modelId : (App.state.activeFolder.includes('/') ? App.state.activeFolder.split('/').pop() : App.state.activeFolder);

        container.innerHTML = '<div class="qc-empty">加载中...</div>';

        try {
            const result = await App.api.getQualityInspection(App.state.currentTaskId, modelId);
            const data = result.success ? result.data : {};
            App.qualityInspection.render(container, data, modelId);
        } catch (e) {
            console.error('[QualityInspection] Load error:', e);
            container.innerHTML = '<div class="qc-empty" style="color:#ef4444;">加载失败</div>';
        }
    };

    /**
     * 渲染质检表单
     */
    App.qualityInspection.render = function (container, data, modelId) {
        let html = '';

        QUESTIONS.forEach(q => {
            const existing = data[q.key] || {};
            const selectedAnswer = existing.answer || '';
            const note = existing.note || '';
            const adminUsername = existing.admin_username || '';

            html += '<div class="qc-question" data-key="' + q.key + '">';
            html += '<div class="qc-question-label">' + q.label + '</div>';

            html += '<div class="qc-options">';
            q.options.forEach(opt => {
                const isActive = selectedAnswer === opt ? ' active' : '';
                html += '<div class="qc-option' + isActive + '" data-answer="' + opt + '">';
                html += '<div class="qc-radio-circle"></div>';
                html += '<span>' + opt + '</span>';
                html += '</div>';
            });
            html += '</div>';

            html += '<textarea class="qc-note" placeholder="备注（选填）" rows="2">' + App.utils.escapeHtml(note) + '</textarea>';

            if (adminUsername) {
                html += '<div class="qc-meta">最近填写：' + App.utils.escapeHtml(adminUsername) + '</div>';
            }

            html += '</div>';
        });

        container.innerHTML = html;

        // 绑定选项点击
        container.querySelectorAll('.qc-option').forEach(opt => {
            opt.addEventListener('click', function () {
                const questionEl = this.closest('.qc-question');
                const key = questionEl.dataset.key;
                const answer = this.dataset.answer;

                // 更新 UI
                questionEl.querySelectorAll('.qc-option').forEach(o => o.classList.remove('active'));
                this.classList.add('active');

                const noteEl = questionEl.querySelector('.qc-note');
                const noteVal = noteEl ? noteEl.value.trim() : '';

                App.qualityInspection.submit(key, answer, noteVal, questionEl);
            });
        });

        // 绑定备注输入（防抖）
        container.querySelectorAll('.qc-note').forEach(textarea => {
            let timer;
            textarea.addEventListener('input', function () {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    const questionEl = this.closest('.qc-question');
                    const key = questionEl.dataset.key;
                    const activeOpt = questionEl.querySelector('.qc-option.active');
                    if (!activeOpt) return; // 没有选中答案则不提交
                    const answer = activeOpt.dataset.answer;
                    App.qualityInspection.submit(key, answer, this.value.trim(), questionEl);
                }, 500);
            });
        });
    };

    /**
     * 提交质检数据
     */
    App.qualityInspection.submit = async function (questionKey, answer, note, questionEl) {
        const run = App.state.currentRuns.find(r => r.folderName === App.state.activeFolder);
        const modelId = run ? run.modelId : (App.state.activeFolder.includes('/') ? App.state.activeFolder.split('/').pop() : App.state.activeFolder);

        try {
            const result = await App.api.submitQualityInspection(
                App.state.currentTaskId, modelId, questionKey, answer, note
            );
            if (result.success && questionEl) {
                // 更新 meta 显示
                let metaEl = questionEl.querySelector('.qc-meta');
                if (!metaEl) {
                    metaEl = document.createElement('div');
                    metaEl.className = 'qc-meta';
                    questionEl.appendChild(metaEl);
                }
                metaEl.textContent = '最近填写：' + App.state.currentUser.username;
            }
        } catch (e) {
            console.error('[QualityInspection] Submit error:', e);
        }
    };

})();
