/**
 * Toast 通知模块
 * Toast notification system
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.toast = {};

    /**
     * 显示 Toast 通知
     * @param {string} message - 消息内容
     * @param {string} type - 类型: 'error', 'warning', 'success'
     */
    App.toast.show = function (message, type = 'error') {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        // 添加图标
        const icon = document.createElement('span');
        if (type === 'error') icon.textContent = '❌';
        else if (type === 'warning') icon.textContent = '⚠️';
        // Success type has no icon now

        const text = document.createElement('span');
        text.textContent = message;

        toast.appendChild(icon);
        toast.appendChild(text);
        container.appendChild(toast);

        // 3 秒后自动消失
        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    };

})();
