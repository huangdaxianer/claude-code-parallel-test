/**
 * 子Agent状态API
 * GET /tasks/:taskId/models/:modelId/agents
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const config = require('../config');
const db = require('../db');

const CLAUDE_USER_HOME = '/home/claude-user';
const MAX_MESSAGES = 200;

/**
 * 安全读取文件（支持 sudo 读取 claude-user 拥有的文件）
 */
function safeReadFile(filePath) {
    // 先尝试直接读取
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (e) { /* ignore */ }

    // 再尝试 sudo 读取
    try {
        return execSync(`sudo -n cat "${filePath}" 2>/dev/null`, { encoding: 'utf8' });
    } catch (e) { /* ignore */ }

    return null;
}

/**
 * 安全列出目录内容
 */
function safeListDir(dirPath, ext) {
    // 先尝试直接读取
    try {
        const files = fs.readdirSync(dirPath);
        return ext ? files.filter(f => f.endsWith(ext)) : files;
    } catch (e) { /* ignore */ }

    // 再尝试 sudo
    try {
        const output = execSync(`sudo -n ls "${dirPath}" 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (!output) return [];
        const files = output.split('\n').filter(Boolean);
        return ext ? files.filter(f => f.endsWith(ext)) : files;
    } catch (e) { /* ignore */ }

    return [];
}

/**
 * 安全检查目录是否存在
 */
function safeDirExists(dirPath) {
    try {
        return fs.statSync(dirPath).isDirectory();
    } catch (e) { /* ignore */ }
    try {
        return execSync(`sudo -n test -d "${dirPath}" && echo yes || echo no`, { encoding: 'utf8' }).trim() === 'yes';
    } catch (e) { /* ignore */ }
    return false;
}

/**
 * 从实时路径读取团队数据
 */
function readTeamDataFromLive(teamName) {
    const teamsDir = path.join(CLAUDE_USER_HOME, '.claude/teams', teamName);
    const tasksDir = path.join(CLAUDE_USER_HOME, '.claude/tasks', teamName);

    if (!safeDirExists(teamsDir)) return null;

    const configContent = safeReadFile(path.join(teamsDir, 'config.json'));
    if (!configContent) return null;

    let teamConfig;
    try {
        teamConfig = JSON.parse(configContent);
    } catch (e) { return null; }

    // 读取成员列表
    const members = (teamConfig.members || []).map(m => ({
        name: m.name || '',
        agentType: m.agentType || '',
        color: m.color || '',
        prompt: m.prompt || '',
        model: m.model || '',
        joinedAt: m.joinedAt || 0
    }));

    // 读取任务文件
    const tasks = [];
    const taskFiles = safeListDir(tasksDir, '.json');
    for (const file of taskFiles) {
        if (file === '.lock') continue;
        const content = safeReadFile(path.join(tasksDir, file));
        if (!content) continue;
        try {
            const task = JSON.parse(content);
            tasks.push({
                id: task.id || file.replace('.json', ''),
                owner: task.subject || '',
                description: task.description || '',
                status: task.status || 'pending'
            });
        } catch (e) { /* ignore */ }
    }

    // 读取并合并所有 inbox 消息
    const messages = [];
    const inboxesDir = path.join(teamsDir, 'inboxes');
    const inboxFiles = safeListDir(inboxesDir, '.json');
    for (const file of inboxFiles) {
        const recipientName = file.replace('.json', '');
        const content = safeReadFile(path.join(inboxesDir, file));
        if (!content) continue;
        try {
            const inboxMessages = JSON.parse(content);
            if (!Array.isArray(inboxMessages)) continue;
            for (const msg of inboxMessages) {
                // 过滤系统消息（idle_notification）
                let isSystem = false;
                let text = msg.text || '';
                try {
                    const parsed = JSON.parse(text);
                    if (parsed && parsed.type === 'idle_notification') {
                        isSystem = true;
                    }
                } catch (e) { /* not JSON, that's fine */ }

                messages.push({
                    from: msg.from || '',
                    to: recipientName,
                    text: text,
                    summary: msg.summary || '',
                    timestamp: msg.timestamp || '',
                    read: !!msg.read,
                    isSystem: isSystem
                });
            }
        } catch (e) { /* ignore */ }
    }

    // 按时间排序
    messages.sort((a, b) => {
        const ta = new Date(a.timestamp).getTime() || 0;
        const tb = new Date(b.timestamp).getTime() || 0;
        return tb - ta;
    });

    return {
        teamName: teamConfig.name || teamName,
        members,
        tasks: tasks.sort((a, b) => parseInt(a.id) - parseInt(b.id)),
        messages: messages.slice(0, MAX_MESSAGES)
    };
}

/**
 * 从快照路径读取团队数据
 */
function readTeamDataFromSnapshot(snapshotDir) {
    const configContent = safeReadFile(path.join(snapshotDir, 'config.json'));
    if (!configContent) return null;

    let teamConfig;
    try {
        teamConfig = JSON.parse(configContent);
    } catch (e) { return null; }

    // 读取成员列表
    const members = (teamConfig.members || []).map(m => ({
        name: m.name || '',
        agentType: m.agentType || '',
        color: m.color || '',
        prompt: m.prompt || '',
        model: m.model || '',
        joinedAt: m.joinedAt || 0
    }));

    // 读取任务文件
    const tasks = [];
    const tasksSnapshotDir = path.join(snapshotDir, 'tasks');
    try {
        const taskFiles = fs.readdirSync(tasksSnapshotDir).filter(f => f.endsWith('.json'));
        for (const file of taskFiles) {
            const content = safeReadFile(path.join(tasksSnapshotDir, file));
            if (!content) continue;
            try {
                const task = JSON.parse(content);
                tasks.push({
                    id: task.id || file.replace('.json', ''),
                    owner: task.subject || '',
                    description: task.description || '',
                    status: task.status || 'pending'
                });
            } catch (e) { /* ignore */ }
        }
    } catch (e) { /* ignore */ }

    // 读取并合并所有 inbox 消息
    const messages = [];
    const inboxesSnapshotDir = path.join(snapshotDir, 'inboxes');
    try {
        const inboxFiles = fs.readdirSync(inboxesSnapshotDir).filter(f => f.endsWith('.json'));
        for (const file of inboxFiles) {
            const recipientName = file.replace('.json', '');
            const content = safeReadFile(path.join(inboxesSnapshotDir, file));
            if (!content) continue;
            try {
                const inboxMessages = JSON.parse(content);
                if (!Array.isArray(inboxMessages)) continue;
                for (const msg of inboxMessages) {
                    let isSystem = false;
                    let text = msg.text || '';
                    try {
                        const parsed = JSON.parse(text);
                        if (parsed && parsed.type === 'idle_notification') {
                            isSystem = true;
                        }
                    } catch (e) { /* not JSON */ }

                    messages.push({
                        from: msg.from || '',
                        to: recipientName,
                        text: text,
                        summary: msg.summary || '',
                        timestamp: msg.timestamp || '',
                        read: !!msg.read,
                        isSystem: isSystem
                    });
                }
            } catch (e) { /* ignore */ }
        }
    } catch (e) { /* ignore */ }

    messages.sort((a, b) => {
        const ta = new Date(a.timestamp).getTime() || 0;
        const tb = new Date(b.timestamp).getTime() || 0;
        return tb - ta;
    });

    return {
        teamName: teamConfig.name || '',
        members,
        tasks: tasks.sort((a, b) => parseInt(a.id) - parseInt(b.id)),
        messages: messages.slice(0, MAX_MESSAGES)
    };
}

/**
 * Fallback: 扫描所有 teams 目录，匹配 cwd 包含 taskId 的团队
 */
function scanForTeam(taskId) {
    const allTeamsDir = path.join(CLAUDE_USER_HOME, '.claude/teams');
    const teamDirs = safeListDir(allTeamsDir);

    for (const dir of teamDirs) {
        const configContent = safeReadFile(path.join(allTeamsDir, dir, 'config.json'));
        if (!configContent) continue;
        try {
            const cfg = JSON.parse(configContent);
            const hasMemberWithTaskCwd = (cfg.members || []).some(m => m.cwd && m.cwd.includes(taskId));
            if (hasMemberWithTaskCwd) {
                return dir;
            }
        } catch (e) { /* ignore */ }
    }

    return null;
}

/**
 * GET /:taskId/models/:modelId/agents
 */
router.get('/:taskId/models/:modelId/agents', (req, res) => {
    const { taskId, modelId } = req.params;

    try {
        // 1. 尝试约定名称的实时路径
        const teamName = `${taskId}-${modelId}`;
        let data = readTeamDataFromLive(teamName);

        if (data) {
            return res.json(data);
        }

        // 2. Fallback: 扫描实时 teams 目录
        const scannedTeamName = scanForTeam(taskId);
        if (scannedTeamName) {
            data = readTeamDataFromLive(scannedTeamName);
            if (data) return res.json(data);
        }

        // 3. Fallback: 快照路径
        const snapshotDir = path.join(config.TASKS_DIR, taskId, modelId, '.agent-snapshot');
        data = readTeamDataFromSnapshot(snapshotDir);
        if (data) {
            return res.json(data);
        }

        // 4. 没有找到任何数据
        return res.status(404).json({ error: 'No agent team data found' });
    } catch (e) {
        console.error(`[Agents API] Error for ${taskId}/${modelId}:`, e);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
