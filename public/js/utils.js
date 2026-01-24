/**
 * 工具函数模块
 * Utility functions used across the application
 */
(function () {
    'use strict';

    window.App = window.App || {};
    window.App.utils = {};

    /**
     * 转义 HTML 特殊字符
     */
    App.utils.escapeHtml = function (text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    };

    /**
     * JSON 语法高亮
     */
    App.utils.syntaxHighlight = function (json) {
        if (typeof json !== 'string') {
            json = JSON.stringify(json, null, 2);
        }
        json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
            let cls = 'json-number';
            if (/^"/.test(match)) {
                if (/:$/.test(match)) {
                    cls = 'json-key';
                } else {
                    cls = 'json-string';
                }
            } else if (/true|false/.test(match)) {
                cls = 'json-boolean';
            } else if (/null/.test(match)) {
                cls = 'json-null';
            }
            return '<span class="' + cls + '">' + match + '</span>';
        });
    };

    /**
     * 获取模型显示名称
     */
    App.utils.getModelDisplayName = function (modelName) {
        return modelName;
    };

    // 全局快捷方式
    window.escapeHtml = App.utils.escapeHtml;

})();
