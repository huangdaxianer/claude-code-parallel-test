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
        // 1. Check check localStorage first (Priority: Local Session > URL Param)
        const savedUserStr = localStorage.getItem('claude_user');

        if (savedUserStr) {
            try {
                const user = JSON.parse(savedUserStr);
                if (user && user.id) {
                    App.state.currentUser = user;
                    console.log('[Auth] Logged in via localStorage:', user);

                    // Background verify to ensure role and other info is up to date
                    // This fixes the issue where old localStorage data lacks the 'role' field
                    App.api.verifyUser(user.username).then(freshUser => {
                        if (freshUser) {
                            // Only update if data changed (simple check or always update)
                            // Always update to be safe
                            if (JSON.stringify(freshUser) !== JSON.stringify(App.state.currentUser)) {
                                console.log('[Auth] Refreshed user data from server:', freshUser);
                                App.state.currentUser = freshUser;
                                localStorage.setItem('claude_user', JSON.stringify(freshUser));

                                // Dispatch an event so other components know user data updated
                                // (Optional, but good practice if we were using a framework)

                                // Force reload if role was missing and now present? 
                                // Or just let the user refresh. 
                                // Special case: If we are on a page that needs admin but didn't have it
                                if (!user.role && freshUser.role === 'admin') {
                                    console.log('[Auth] Role updated to admin, refreshing UI...');
                                    // If we are on task.html, we might want to show the admin button now.
                                    // App.init handles this on load. We can trigger a re-check or just let the user reload.
                                    // But since this is a background promise, App.init might have finished.

                                    // Let's manually trigger the admin link injection if needed
                                    if (window.location.pathname.includes('/task.html')) {
                                        const dropdownMenu = document.getElementById('user-dropdown-menu');
                                        if (dropdownMenu && !document.getElementById('admin-panel-link')) {
                                            // Re-run the injection logic - simplified here or extracting it would be better
                                            // For now, reloading is the safest bet to ensure all Admin UI is consistent
                                            // location.reload(); // Might be too aggressive
                                        }
                                    }
                                }
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

        // 2. If no valid session, check URL user param for auto-login
        const urlParams = new URLSearchParams(window.location.search);
        const urlUser = urlParams.get('user');

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
                }
            } catch (e) {
                console.error('[Auth] URL user verification error:', e);
                App.toast.show('验证用户失败');
            }
        }

        // 3. No session and no valid URL param -> Redirect to login
        window.location.href = '/login.html';
        return false;
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
