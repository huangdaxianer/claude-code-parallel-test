/**
 * Utility functions for Task Manager
 */

// Escape HTML to prevent XSS
export function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Format datetime
export function formatDateTime(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Truncate text
export function truncate(text, maxLength) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
}

// Get model status CSS class
export function getModelStatusClass(status) {
    switch (status) {
        case 'running':
            return 'running';
        case 'pending':
            return 'pending';
        case 'completed':
            return 'completed';
        case 'stopped':
            return 'stopped';
        case 'evaluated':
            return 'evaluated';
        default:
            return 'not-started';
    }
}

// Status text mapping
export function getStatusText(status) {
    const map = {
        'pending': '排队中',
        'running': '运行中',
        'completed': '已完成',
        'evaluated': '已反馈',
        'stopped': '已中止',
        'unknown': '未知'
    };
    return map[status] || status || '未知';
}
