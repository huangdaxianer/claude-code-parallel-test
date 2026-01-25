/**
 * 对比视图模块
 * Comparison view rendering
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.compare = {};

    /**
     * 渲染对比视图
     */
    /**
     * 渲染对比视图
     */
    App.compare.renderComparisonView = function () {
        const runs = App.state.currentRuns || [];
        if (runs.length === 0) return;

        const previewableRuns = runs.filter(run => {
            const htmlFile = (run.generatedFiles || []).find(f => f.endsWith('.html'));
            const packageJson = (run.generatedFiles || []).find(f => f === 'package.json');
            return htmlFile || packageJson || run.previewable;
        });

        if (previewableRuns.length === 0) return;

        const isSingleMode = previewableRuns.length === 1;

        // Validate current captures belong to existing previewable runs of the current task
        const leftExists = previewableRuns.some(r => r.folderName === App.state.compareLeftRun);
        const rightExists = previewableRuns.some(r => r.folderName === App.state.compareRightRun);

        if (!leftExists) App.state.compareLeftRun = null;
        if (!rightExists) App.state.compareRightRun = null;

        if (isSingleMode) {
            App.state.compareLeftRun = previewableRuns[0].folderName;
            App.state.compareRightRun = null;
        } else {
            // Default logic: load 1st and 2nd subtasks if not already set or defaulted above
            if (!App.state.compareLeftRun && previewableRuns.length > 0) {
                App.state.compareLeftRun = previewableRuns[0].folderName;
            }
            if (!App.state.compareRightRun && previewableRuns.length > 0) {
                // Try to pick a different one for right side (the 2nd model)
                if (previewableRuns.length > 1) {
                    // Always try to pick the 2nd one if we just reset or haven't set it
                    const secondRun = previewableRuns[1];
                    if (secondRun.folderName !== App.state.compareLeftRun) {
                        App.state.compareRightRun = secondRun.folderName;
                    } else {
                        // This should theoretically not happen if they are different models
                        App.state.compareRightRun = previewableRuns[0].folderName;
                    }
                } else {
                    App.state.compareRightRun = previewableRuns[0].folderName;
                }
            }

            // Ensure they are not the same if we have enough options
            if (App.state.compareLeftRun === App.state.compareRightRun && previewableRuns.length > 1) {
                const other = previewableRuns.find(r => r.folderName !== App.state.compareLeftRun);
                if (other) App.state.compareRightRun = other.folderName;
            }
        }

        // Toggle Right Panel Visibility
        const rightPanel = document.getElementById('comparison-right');
        if (rightPanel) {
            rightPanel.style.display = isSingleMode ? 'none' : 'flex';
        }

        App.compare.updateComparisonSide('left');
        if (!isSingleMode) {
            App.compare.updateComparisonSide('right');
        }
    };

    /**
     * 更新对比面板
     * Modified to accept specific folderName for tabs
     */
    App.compare.updateComparisonPanel = function (side, folderName) {
        if (side === 'left') App.state.compareLeftRun = folderName;
        else App.state.compareRightRun = folderName;

        // Render again to update disabled states on both sides
        App.compare.renderComparisonView();
    };

    /**
     * 更新对比侧边
     */
    App.compare.updateComparisonSide = function (side) {
        const container = document.getElementById(`select-${side}`); // Now a DIV
        const statusBadge = document.getElementById(`status-${side}`);
        const iframe = document.getElementById(`iframe-${side}`);
        const emptyState = document.getElementById(`empty-${side}`);

        const currentTarget = (side === 'left') ? App.state.compareLeftRun : App.state.compareRightRun;
        const otherTarget = (side === 'left') ? App.state.compareRightRun : App.state.compareLeftRun;

        App.compare.syncModelTabs(container, App.state.currentRuns, side, currentTarget, otherTarget);

        const previewableRuns = App.state.currentRuns.filter(run => {
            const htmlFile = (run.generatedFiles || []).find(f => f.endsWith('.html'));
            const packageJson = (run.generatedFiles || []).find(f => f === 'package.json');
            return htmlFile || packageJson || run.previewable;
        });

        // Validate currentTarget exists
        let activeRun = currentTarget ? previewableRuns.find(r => r.folderName === currentTarget) : null;

        // Fallback or fix state if invalid
        if (!activeRun) {
            // If we lost the current run (e.g. filtered out), try reset
            // But usually renderComparisonView handles initial defaults.
            // Here we might just clear view.
        }

        if (!activeRun) {
            iframe.style.display = 'none';
            iframe.dataset.src = '';
            emptyState.style.display = 'flex';
            emptyState.innerHTML = '<p>无可用预览</p>';
            statusBadge.style.display = 'none';
            return;
        }

        statusBadge.textContent = activeRun.status;
        statusBadge.className = `status-badge status-${activeRun.status || 'pending'}`;
        statusBadge.style.display = 'inline-block';

        const htmlFile = (activeRun.generatedFiles || []).find(f => f.endsWith('.html'));
        const packageJson = (activeRun.generatedFiles || []).find(f => f === 'package.json');
        const hasPreview = activeRun.previewable || htmlFile || packageJson;

        if (hasPreview) {
            iframe.style.display = 'block';
            emptyState.style.display = 'none';

            const runId = activeRun.folderName;
            if (iframe.dataset.runId !== runId) {
                iframe.dataset.runId = runId;
                const parts = runId.split('/');
                App.preview.loadPreview(parts[0], parts[1], iframe, iframe.parentElement);
            }
        } else {
            iframe.style.display = 'none';
            iframe.dataset.src = '';
            emptyState.style.display = 'flex';
            const statusMap = { 'pending': '排队中', 'running': '运行中', 'completed': '已完成', 'evaluated': '已评价', 'stopped': '已中止' };
            emptyState.innerHTML = `<p>暂无预览<br><span style="font-size:0.8em;color:#cbd5e1;">${statusMap[activeRun.status] || activeRun.status}</span></p>`;
        }
    };

    /**
     * 同步模型选项卡 (Sync Model Tabs)
     * Replaces syncSelectOptions
     */
    App.compare.syncModelTabs = function (container, runs, side, currentTarget, otherTarget) {
        const previewableRuns = runs.filter(run => {
            const htmlFile = (run.generatedFiles || []).find(f => f.endsWith('.html'));
            const packageJson = (run.generatedFiles || []).find(f => f === 'package.json');
            return htmlFile || packageJson || run.previewable;
        });

        container.innerHTML = '';

        if (previewableRuns.length === 0) {
            container.innerHTML = '<span style="font-size:0.85rem; color:#94a3b8;">无可用项</span>';
            return;
        }

        previewableRuns.forEach(run => {
            const btn = document.createElement('div');
            const isSelected = run.folderName === currentTarget;
            const isDisabled = run.folderName === otherTarget; // Disable if selected in other panel

            let classes = ['comparison-model-tab'];
            if (isSelected) classes.push('active');
            if (isDisabled) classes.push('disabled');

            btn.className = classes.join(' ');

            // Emoji removed as per user request
            btn.innerHTML = `<span>${App.utils.getModelDisplayName(run.modelName)}</span>`;

            if (!isDisabled && !isSelected) {
                btn.onclick = () => {
                    App.compare.updateComparisonPanel(side, run.folderName);
                };
            }

            container.appendChild(btn);
        });
    };

    // 全局快捷方式
    window.updateComparisonPanel = App.compare.updateComparisonPanel;

})();
