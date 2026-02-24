/**
 * 用户认证模块
 * User authentication logic
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.auth = {};

    /**
     * 检查登录状态
     */
    App.auth.checkLogin = async function () {
        // Check localStorage for saved session
        const savedUserStr = localStorage.getItem('claude_user');

        if (savedUserStr) {
            try {
                const user = JSON.parse(savedUserStr);
                if (user && user.id) {
                    App.state.currentUser = user;
                    // 确保 cookie 始终与 localStorage 同步
                    document.cookie = `username=${encodeURIComponent(user.username)}; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`;
                    console.log('[Auth] Logged in via localStorage:', user);

                    // Background verify to ensure role and other info is up to date
                    App.api.verifyUser(user.username).then(freshUser => {
                        if (freshUser) {
                            if (JSON.stringify(freshUser) !== JSON.stringify(App.state.currentUser)) {
                                console.log('[Auth] Refreshed user data from server:', freshUser);
                                App.state.currentUser = freshUser;
                                localStorage.setItem('claude_user', JSON.stringify(freshUser));
                            }
                        }
                    }).catch(err => console.error('[Auth] Background verify failed:', err));

                    return true;
                }
            } catch (e) {
                console.error('[Auth] Parse error:', e);
                localStorage.removeItem('claude_user');
            }
        }

        // No valid session -> Redirect to login
        window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
        return false;
    };

    /**
     * 登出
     */
    App.auth.logout = function () {
        localStorage.removeItem('claude_user');
        document.cookie = 'username=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        window.location.href = '/login.html';
    };

    // 全局快捷方式
    window.logout = App.auth.logout;

    // 立即执行登录检查（异步）
    (async function () {
        await App.auth.checkLogin();
    })();

})();
