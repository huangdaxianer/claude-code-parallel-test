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
    App.compare.renderComparisonView = function () {
        const runs = App.state.currentRuns || [];
        if (runs.length === 0) return;

        const previewableRuns = runs.filter(run => {
            const htmlFile = (run.generatedFiles || []).find(f => f.endsWith('.html'));
            const packageJson = (run.generatedFiles || []).find(f => f === 'package.json');
            return htmlFile || packageJson || run.previewable;
        });

        if (previewableRuns.length === 0) return;

        if (!App.state.compareLeftRun && previewableRuns.length > 0) {
            App.state.compareLeftRun = previewableRuns[0].folderName;
        }
        if (!App.state.compareRightRun && previewableRuns.length > 0) {
            App.state.compareRightRun = previewableRuns.length > 1 ? previewableRuns[1].folderName : previewableRuns[0].folderName;
        }

        App.compare.updateComparisonSide('left');
        App.compare.updateComparisonSide('right');
    };

    /**
     * 更新对比面板
     */
    App.compare.updateComparisonPanel = function (side) {
        const select = document.getElementById(`select-${side}`);
        if (side === 'left') App.state.compareLeftRun = select.value;
        else App.state.compareRightRun = select.value;
        App.compare.renderComparisonView();
    };

    /**
     * 更新对比侧边
     */
    App.compare.updateComparisonSide = function (side) {
        const select = document.getElementById(`select-${side}`);
        const statusBadge = document.getElementById(`status-${side}`);
        const iframe = document.getElementById(`iframe-${side}`);
        const emptyState = document.getElementById(`empty-${side}`);

        App.compare.syncSelectOptions(select, App.state.currentRuns);

        const previewableRuns = App.state.currentRuns.filter(run => {
            const htmlFile = (run.generatedFiles || []).find(f => f.endsWith('.html'));
            const packageJson = (run.generatedFiles || []).find(f => f === 'package.json');
            return htmlFile || packageJson || run.previewable;
        });

        const currentTarget = (side === 'left') ? App.state.compareLeftRun : App.state.compareRightRun;

        if (currentTarget && previewableRuns.find(r => r.folderName === currentTarget)) {
            select.value = currentTarget;
        } else {
            if (previewableRuns.length > 0) {
                const fallback = previewableRuns[0].folderName;
                select.value = fallback;
                if (side === 'left') App.state.compareLeftRun = fallback;
                else App.state.compareRightRun = fallback;
            }
        }

        const run = previewableRuns.find(r => r.folderName === select.value);
        if (!run) {
            iframe.style.display = 'none';
            iframe.dataset.src = '';
            emptyState.style.display = 'flex';
            emptyState.innerHTML = '<p>无可用预览</p>';
            statusBadge.style.display = 'none';
            return;
        }

        statusBadge.textContent = run.status;
        statusBadge.className = `status-badge status-${run.status || 'pending'}`;
        statusBadge.style.display = 'inline-block';

        const htmlFile = (run.generatedFiles || []).find(f => f.endsWith('.html'));
        const packageJson = (run.generatedFiles || []).find(f => f === 'package.json');
        const hasPreview = htmlFile || packageJson;

        if (hasPreview) {
            iframe.style.display = 'block';
            emptyState.style.display = 'none';

            const runId = run.folderName;
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
            emptyState.innerHTML = `<p>暂无预览<br><span style="font-size:0.8em;color:#cbd5e1;">${statusMap[run.status] || run.status}</span></p>`;
        }
    };

    /**
     * 同步选择选项
     */
    App.compare.syncSelectOptions = function (select, runs) {
        const previewableRuns = runs.filter(run => {
            const htmlFile = (run.generatedFiles || []).find(f => f.endsWith('.html'));
            const packageJson = (run.generatedFiles || []).find(f => f === 'package.json');
            return htmlFile || packageJson || run.previewable;
        });

        const currentOptionValues = Array.from(select.options).map(o => o.value).join(',');
        const newOptionValues = previewableRuns.map(r => r.folderName).join(',');

        if (currentOptionValues === newOptionValues) return;

        const savedValue = select.value;
        select.innerHTML = '';

        if (previewableRuns.length === 0) {
            const option = document.createElement('option');
            option.value = "";
            option.textContent = "无可用预览";
            option.disabled = true;
            option.selected = true;
            select.appendChild(option);
            return;
        }

        previewableRuns.forEach(run => {
            const option = document.createElement('option');
            option.value = run.folderName;
            let statusSymbol = '⏳';
            if (run.status === 'running') statusSymbol = '🔄';
            else if (run.status === 'completed') statusSymbol = '✅';
            else if (run.status === 'stopped') statusSymbol = '⏹️';

            option.textContent = `${App.utils.getModelDisplayName(run.modelName)} (${statusSymbol})`;
            select.appendChild(option);
        });

        if (savedValue) {
            const exists = previewableRuns.find(r => r.folderName === savedValue);
            if (exists) select.value = savedValue;
        }
    };

    // 全局快捷方式
    window.updateComparisonPanel = App.compare.updateComparisonPanel;

})();
