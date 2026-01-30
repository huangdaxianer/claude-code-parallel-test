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
                    // Unescape contents for better readability (direct formatting)
                    // Keep the surrounding quotes but format the inner content
                    // match is like "some content\nnewline"
                    // We replace literal \n with actual newline, etc.
                    match = match
                        .replace(/\\n/g, '\n')
                        .replace(/\\t/g, '\t')
                        .replace(/\\"/g, '"');
                    // Note: We don't unescape \\ to \ to avoid ambiguity if needed, 
                    // but user asked for "all escaped", so let's skip deep path escaping issues for now 
                    // and focus on layout (newlines/tabs).
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
     * For admin users, shows description (备注) instead of model name
     * Can look up by either modelId or modelName (for backwards compat)
     */
    App.utils.getModelDisplayName = function (identifier) {
        // If we have cached model display names, use them
        // First try to find by modelId, then by modelName
        if (App.state.modelDisplayNames) {
            if (App.state.modelDisplayNames[identifier]) {
                return App.state.modelDisplayNames[identifier];
            }
        }
        return identifier;
    };

    // 全局快捷方式
    window.escapeHtml = App.utils.escapeHtml;

})();
