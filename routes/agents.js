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
 * 在 baseDir 中查找 name 的所有大小写变体目录
 * Claude SDK 有时会用不同大小写创建目录（如 s0hdxp-nofmw 和 S0HDXP-NOFMW）
 * 返回所有匹配的路径数组
 */
function findAllCaseVariantDirs(baseDir, name) {
    const results = [];
    const entries = safeListDir(baseDir);
    const lowerName = name.toLowerCase();
    for (const entry of entries) {
        if (entry.toLowerCase() === lowerName) {
            results.push(path.join(baseDir, entry));
        }
    }
    // 如果没有找到任何匹配，直接检查精确路径
    if (results.length === 0) {
        const directPath = path.join(baseDir, name);
        if (safeDirExists(directPath)) results.push(directPath);
    }
    return results;
}

/**
 * 从实时路径读取团队数据
 * 处理 Claude SDK 可能用不同大小写创建 teams/tasks 目录的情况
 */
function readTeamDataFromLive(teamName) {
    const teamsBase = path.join(CLAUDE_USER_HOME, '.claude/teams');
    const tasksBase = path.join(CLAUDE_USER_HOME, '.claude/tasks');

    // 查找所有大小写变体目录
    const teamsDirs = findAllCaseVariantDirs(teamsBase, teamName);
    const tasksDirs = findAllCaseVariantDirs(tasksBase, teamName);

    if (teamsDirs.length === 0) return null;

    // 从任一 teams 目录中读取 config.json
    let teamConfig = null;
    for (const dir of teamsDirs) {
        const configContent = safeReadFile(path.join(dir, 'config.json'));
        if (!configContent) continue;
        try {
            teamConfig = JSON.parse(configContent);
            break;
        } catch (e) { /* ignore */ }
    }
    if (!teamConfig) return null;

    // 读取成员列表
    const members = (teamConfig.members || []).map(m => ({
        name: m.name || '',
        agentType: m.agentType || '',
        color: m.color || '',
        prompt: m.prompt || '',
        model: m.model || '',
        joinedAt: m.joinedAt || 0
    }));

    // 从所有 tasks 目录变体中合并任务
    const tasks = [];
    const seenTaskIds = new Set();
    for (const tasksDir of tasksDirs) {
        const taskFiles = safeListDir(tasksDir, '.json');
        for (const file of taskFiles) {
            if (file === '.lock') continue;
            if (seenTaskIds.has(file)) continue;
            seenTaskIds.add(file);
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
    }

    // 从所有 teams 目录变体中合并 inbox 消息
    const messages = [];
    for (const teamsDir of teamsDirs) {
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

        // 2. Fallback: 从 log_entries 中查找 TeamCreate 事件获取 team name
        const run = db.prepare('SELECT id FROM model_runs WHERE task_id = ? AND model_id = ?').get(taskId, modelId);
        if (run) {
            const teamCreateLog = db.prepare(
                "SELECT content FROM log_entries WHERE run_id = ? AND type = 'TeamCreate' LIMIT 1"
            ).get(run.id);
            if (teamCreateLog && teamCreateLog.content) {
                try {
                    const parsed = JSON.parse(teamCreateLog.content);
                    // content 是 stream-json 的原始内容，tool_use 的 input 中包含 team_name
                    const input = parsed?.input || parsed?.content?.input || {};
                    const dbTeamName = input.team_name;
                    if (dbTeamName) {
                        data = readTeamDataFromLive(dbTeamName);
                        if (data) return res.json(data);
                    }
                } catch (e) { /* ignore parse error */ }
            }
        }

        // 3. Fallback: 扫描实时 teams 目录（匹配 cwd 包含 taskId）
        const scannedTeamName = scanForTeam(taskId);
        if (scannedTeamName) {
            data = readTeamDataFromLive(scannedTeamName);
            if (data) return res.json(data);
        }

        // 4. Fallback: 快照路径
        const snapshotDir = path.join(config.TASKS_DIR, taskId, modelId, '.agent-snapshot');
        data = readTeamDataFromSnapshot(snapshotDir);
        if (data) {
            return res.json(data);
        }

        // 5. Fallback: 从 DB 获取的 team name 尝试快照路径
        // （如果 team name 是旧格式，快照可能用原始 team name 存储）

        // 6. 没有找到任何数据
        return res.status(404).json({ error: 'No agent team data found' });
    } catch (e) {
        console.error(`[Agents API] Error for ${taskId}/${modelId}:`, e);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 安全读取文件的每一行（支持大文件逐行读取）
 */
function safeReadLines(filePath) {
    const content = safeReadFile(filePath);
    if (!content) return [];
    return content.split('\n').filter(Boolean);
}

/**
 * 从 jsonl 行中提取事件摘要
 */
function extractEventSummary(line) {
    let obj;
    try {
        obj = JSON.parse(line);
    } catch (e) { return null; }

    const type = obj.type || obj.message?.role || '';
    const timestamp = obj.timestamp || '';
    const content = obj.message?.content || '';

    if (type === 'user' || obj.message?.role === 'user') {
        // 用户消息：可能是 teammate-message 或 tool_result
        if (typeof content === 'string') {
            if (content.includes('<teammate-message')) {
                // 提取 summary
                const summaryMatch = content.match(/summary="([^"]+)"/);
                return { type: 'user', timestamp, text: summaryMatch ? summaryMatch[1] : '(teammate message)' };
            }
            if (content.includes('tool_result') || content.includes('<tool-result>')) {
                return { type: 'tool_result', timestamp, text: '(tool result)' };
            }
            const short = content.slice(0, 120);
            return { type: 'user', timestamp, text: short };
        }
        if (Array.isArray(content)) {
            for (const block of content) {
                if (block.type === 'tool_result') {
                    return { type: 'tool_result', timestamp, text: '(tool result)' };
                }
                if (block.type === 'text' && block.text) {
                    if (block.text.includes('<teammate-message')) {
                        const summaryMatch = block.text.match(/summary="([^"]+)"/);
                        return { type: 'user', timestamp, text: summaryMatch ? summaryMatch[1] : '(teammate message)' };
                    }
                    return { type: 'user', timestamp, text: block.text.slice(0, 120) };
                }
            }
            return { type: 'user', timestamp, text: '(user message)' };
        }
        return null;
    }

    if (type === 'assistant' || obj.message?.role === 'assistant') {
        if (typeof content === 'string') {
            return { type: 'assistant', timestamp, text: content.slice(0, 120) };
        }
        if (Array.isArray(content)) {
            const toolUses = content.filter(b => b.type === 'tool_use');
            if (toolUses.length > 0) {
                const names = toolUses.map(t => t.name).join(', ');
                return { type: 'tool_use', timestamp, text: names };
            }
            const textBlock = content.find(b => b.type === 'text' && b.text);
            if (textBlock) {
                return { type: 'assistant', timestamp, text: textBlock.text.slice(0, 120) };
            }
            return { type: 'assistant', timestamp, text: '(assistant response)' };
        }
        return null;
    }

    return null;
}

/**
 * GET /:taskId/models/:modelId/agents/trajectories
 * 返回子 agent 的执行轨迹
 */
router.get('/:taskId/models/:modelId/agents/trajectories', (req, res) => {
    const { taskId, modelId } = req.params;

    try {
        // 推导 cwdSlug：/root/project/tasks/{taskId}/{modelId} → -root-project-tasks-{taskId}-{modelId}
        const taskCwd = path.join('/root/project/tasks', taskId, modelId);
        const cwdSlug = taskCwd.replace(/\//g, '-');
        const projectDir = path.join(CLAUDE_USER_HOME, '.claude/projects', cwdSlug);

        // 读取团队配置以获取成员 prompt 信息用于匹配
        const teamsBase = path.join(CLAUDE_USER_HOME, '.claude/teams');
        const teamName = `${taskId}-${modelId}`;
        const teamsDirs = findAllCaseVariantDirs(teamsBase, teamName);
        let teamMembers = [];
        for (const dir of teamsDirs) {
            const cfgContent = safeReadFile(path.join(dir, 'config.json'));
            if (!cfgContent) continue;
            try {
                const cfg = JSON.parse(cfgContent);
                if (cfg.members && cfg.members.length > 0) {
                    teamMembers = cfg.members;
                    break;
                }
            } catch (e) { /* ignore */ }
        }

        // 扫描 {projectDir}/*/subagents/agent-*.jsonl
        const sessionDirs = safeListDir(projectDir);
        const trajectories = [];

        for (const sessionDir of sessionDirs) {
            const subagentsDir = path.join(projectDir, sessionDir, 'subagents');
            const jsonlFiles = safeListDir(subagentsDir, '.jsonl');

            for (const file of jsonlFiles) {
                const agentIdMatch = file.match(/^agent-(.+)\.jsonl$/);
                if (!agentIdMatch) continue;

                const agentId = agentIdMatch[1];
                const filePath = path.join(subagentsDir, file);
                const lines = safeReadLines(filePath);

                const events = [];
                let memberName = '';
                let firstMsgText = '';

                for (const line of lines) {
                    const event = extractEventSummary(line);
                    if (event) {
                        events.push(event);
                    }

                    // 提取第一条消息的文本内容用于匹配成员
                    if (!firstMsgText && events.length <= 2) {
                        try {
                            const obj = JSON.parse(line);
                            const c = obj.message?.content;
                            firstMsgText = typeof c === 'string' ? c :
                                (Array.isArray(c) ? c.map(b => b.text || '').join(' ') : '');
                        } catch (e) { /* ignore */ }
                    }
                }

                // 通过首条消息内容匹配成员 prompt
                if (firstMsgText && teamMembers.length > 0) {
                    for (const m of teamMembers) {
                        if (m.prompt && firstMsgText.includes(m.prompt.slice(0, 50))) {
                            memberName = m.name;
                            break;
                        }
                    }
                }

                trajectories.push({
                    agentId,
                    memberName: memberName || agentId.slice(0, 8),
                    sessionId: sessionDir,
                    lines: lines.length,
                    events
                });
            }
        }

        return res.json({ trajectories });
    } catch (e) {
        console.error(`[Agents API] Trajectory error for ${taskId}/${modelId}:`, e);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
