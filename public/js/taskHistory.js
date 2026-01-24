/**
 * 任务历史侧边栏模块
 * Task history sidebar logic
 */
(function () {
    'use strict';

    window.App = window.App || {};

    /**
     * 获取任务历史列表
     */
    App.fetchTaskHistory = async function () {
        try {
            const tasks = await App.api.getTasks(App.state.currentUser.id);
            const listEl = document.getElementById('task-history-list');
            listEl.innerHTML = '';

            tasks.forEach(task => {
                const item = document.createElement('div');
                item.className = `history-item ${task.taskId === App.state.currentTaskId ? 'active' : ''}`;
                item.innerHTML = `
                    <div style="flex:1; overflow:hidden;">
                        <div style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding-right: 20px;">${task.title || 'Untitled'}</div>
                        <div style="font-size:0.75rem; color:#94a3b8;">${task.taskId}</div>
                    </div>
                    <button class="item-menu-btn" data-task-id="${task.taskId}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="1"></circle>
                            <circle cx="12" cy="5" r="1"></circle>
                            <circle cx="12" cy="19" r="1"></circle>
                        </svg>
                    </button>
                `;
                item.onclick = (e) => {
                    if (e.target.closest('.item-menu-btn')) return;
                    e.preventDefault();
                    if (App.state.currentTaskId !== task.taskId) {
                        App.loadTask(task.taskId);
                    }
                };

                // 菜单按钮
                const menuBtn = item.querySelector('.item-menu-btn');
                menuBtn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    const menu = document.getElementById('item-dropdown-menu');
                    const rect = menuBtn.getBoundingClientRect();

                    if (App.state.activeMenuTaskId === task.taskId && menu.classList.contains('show')) {
                        menu.classList.remove('show');
                        App.state.activeMenuTaskId = null;
                        return;
                    }

                    App.state.activeMenuTaskId = task.taskId;
                    menu.style.top = `${rect.bottom + 5}px`;
                    menu.style.left = `${rect.right - 120}px`;
                    menu.classList.add('show');
                };

                listEl.appendChild(item);
            });

            // 自动加载第一个任务
            const urlParams = new URLSearchParams(window.location.search);
            const urlTaskId = urlParams.get('task');

            if (!App.state.currentTaskId && !urlTaskId && tasks.length > 0) {
                App.loadTask(tasks[0].taskId, true);
            } else if (tasks.length === 0) {
                document.querySelector('.top-bar').style.display = 'none';
                document.getElementById('main-content-wrapper').innerHTML = `
                    <div class="empty-state" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: #64748b;">
                        <p>No tasks found. Click "New Task" to start.</p>
                    </div>
                `;
            }
        } catch (e) {
            console.error("Failed to fetch history:", e);
        }
    };

    /**
     * 删除任务
     */
    App.deleteTask = async function (taskId) {
        try {
            const data = await App.api.deleteTask(taskId);

            if (data.success) {
                if (taskId === App.state.currentTaskId) {
                    window.history.pushState({}, '', window.location.pathname);
                    location.reload();
                } else {
                    App.fetchTaskHistory();
                }
            } else {
                alert('删除失败: ' + (data.error || '未知错误'));
            }
        } catch (e) {
            console.error('Delete error:', e);
            alert('删除请求失败');
        }
    };

})();
