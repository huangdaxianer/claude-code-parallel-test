/**
 * 用户认证模块
 * User authentication logic
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.auth = {};

    /**
     * 检查登录状态 (支持 URL 参数自动登录)
     */
    App.auth.checkLogin = async function () {
        const urlParams = new URLSearchParams(window.location.search);
        const urlUser = urlParams.get('user');

        // 1. 如果 URL 有 user 参数，验证并自动登录
        if (urlUser) {
            try {
                const user = await App.api.verifyUser(urlUser);
                if (user) {
                    App.state.currentUser = user;
                    localStorage.setItem('claude_user', JSON.stringify(user));
                    console.log('[Auth] Logged in via URL:', user);
                    return true;
                } else {
                    App.toast.show(`用户 ${urlUser} 不存在`);
                    App.state.currentUser = null;
                    return false;
                }
            } catch (e) {
                console.error('[Auth] URL user verification error:', e);
                App.toast.show('验证用户失败');
                return false;
            }
        }

        // 2. 检查 localStorage
        const savedUserStr = localStorage.getItem('claude_user');

        console.log('[Auth] savedUserStr:', savedUserStr);

        if (!savedUserStr) {
            window.location.href = '/login.html';
            return false;
        }

        try {
            App.state.currentUser = JSON.parse(savedUserStr);
            console.log('[Auth] Parsed currentUser:', App.state.currentUser);
            if (!App.state.currentUser || !App.state.currentUser.id) {
                throw new Error('Invalid user data');
            }
            return true;
        } catch (e) {
            console.error('[Auth] Parse error:', e);
            localStorage.removeItem('claude_user');
            window.location.href = '/login.html';
            return false;
        }
    };

    /**
     * 登出
     */
    App.auth.logout = function () {
        localStorage.removeItem('claude_user');
        window.location.href = '/login.html';
    };

    // 全局快捷方式
    window.logout = App.auth.logout;

    // 立即执行登录检查（异步）
    (async function () {
        await App.auth.checkLogin();
    })();

})();
