const fs = require('fs');
const path = require('path');
const db = require('./db');

const TASKS_DIR = path.join(__dirname, '../tasks');
const HISTORY_FILE = path.join(TASKS_DIR, 'history.json');

function calculateLogStats(logContent) {
    const stats = {
        duration: 0,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        toolCounts: {
            TodoWrite: 0,
            Read: 0,
            Write: 0,
            Bash: 0
        }
    };

    if (!logContent) return stats;

    const formattedContent = logContent.replace(/}\s*{/g, '}\n{');
    const lines = formattedContent.split(/\r\n|\n|\r/);

    lines.forEach(line => {
        if (!line.trim() || !line.trim().startsWith('{')) return;
        try {
            const obj = JSON.parse(line);

            if (obj.type === 'result') {
                if (obj.duration_ms) stats.duration = (obj.duration_ms / 1000).toFixed(1);
                else if (obj.duration) stats.duration = (obj.duration / 1000).toFixed(1);

                if (obj.usage) {
                    stats.inputTokens = obj.usage.input_tokens || 0;
                    stats.outputTokens = obj.usage.output_tokens || 0;
                    stats.cacheReadTokens = obj.usage.cache_read_input_tokens || 0;
                } else if (obj.tokenUsage) {
                    stats.inputTokens = obj.tokenUsage.input || obj.tokenUsage.input_tokens || 0;
                    stats.outputTokens = obj.tokenUsage.output || obj.tokenUsage.output_tokens || 0;
                    stats.cacheReadTokens = obj.tokenUsage.cacheRead || obj.tokenUsage.cache_read_input_tokens || 0;
                }
            }

            if (obj.type === 'user') stats.turns++;

            if (obj.type === 'tool_use') {
                const name = obj.name;
                if (stats.toolCounts.hasOwnProperty(name)) stats.toolCounts[name]++;
            }
            if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
                obj.message.content.forEach(block => {
                    if (block.type === 'tool_use') {
                        const name = block.name;
                        if (stats.toolCounts.hasOwnProperty(name)) stats.toolCounts[name]++;
                    }
                });
            }
        } catch (e) { }
    });
    return stats;
}

async function migrate() {
    console.log('Starting migration...');

    if (!fs.existsSync(HISTORY_FILE)) {
        console.log('No history file found. Migration skipped.');
        return;
    }

    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));

    // Use transaction for speed
    const insertTask = db.prepare('INSERT OR IGNORE INTO tasks (task_id, title, prompt, base_dir) VALUES (?, ?, ?, ?)');
    const insertRun = db.prepare(`
        INSERT OR REPLACE INTO model_runs 
        (task_id, model_name, status, duration, turns, input_tokens, output_tokens, cache_read_tokens, count_todo_write, count_read, count_write, count_bash) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertLog = db.prepare(`
        INSERT INTO log_entries (run_id, line_number, type, tool_name, tool_use_id, preview_text, status_class, content)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const updateLogStatus = db.prepare(`
        UPDATE log_entries SET status_class = ? WHERE run_id = ? AND tool_use_id = ?
    `);

    const migrateAll = db.transaction((tasks) => {
        for (const task of tasks) {
            insertTask.run(task.taskId, task.title, task.prompt, task.baseDir);

            const taskDir = path.join(TASKS_DIR, task.taskId);
            if (fs.existsSync(taskDir)) {
                const models = task.models || [];
                models.forEach(modelName => {
                    const logFilePath = path.join(taskDir, `${modelName}.txt`);
                    if (fs.existsSync(logFilePath)) {
                        const content = fs.readFileSync(logFilePath, 'utf8');
                        const stats = calculateLogStats(content);

                        const rawLines = content.split('\n').filter(l => l.trim());
                        let status = 'completed';
                        if (rawLines.length === 0) status = 'pending';
                        else if (!content.includes('"type":"result"')) status = 'running';

                        const result = insertRun.run(
                            task.taskId,
                            modelName,
                            status,
                            stats.duration,
                            stats.turns,
                            stats.inputTokens,
                            stats.outputTokens,
                            stats.cacheReadTokens,
                            stats.toolCounts.TodoWrite,
                            stats.toolCounts.Read,
                            stats.toolCounts.Write,
                            stats.toolCounts.Bash
                        );

                        const runId = result.lastInsertRowid;
                        db.prepare('DELETE FROM log_entries WHERE run_id = ?').run(runId);

                        const lines = content.replace(/}\s*{/g, '}\n{').split('\n');
                        let lineNo = 0;
                        lines.forEach(line => {
                            if (!line.trim().startsWith('{')) return;
                            try {
                                const obj = JSON.parse(line);
                                lineNo++;

                                const entries = getLogEntries(obj, line, runId);
                                entries.forEach(entry => {
                                    insertLog.run(
                                        runId,
                                        lineNo,
                                        entry.skip ? 'HIDDEN_' + entry.type : entry.type,
                                        entry.toolName || null,
                                        entry.toolUseId || null,
                                        entry.previewText || '',
                                        entry.typeClass || (entry.skip ? 'type-tool' : 'type-content'),
                                        entry.content
                                    );
                                });
                            } catch (e) { }
                        });
                    }
                });
            }
        }
    });

    migrateAll(history);
    console.log('Migration completed successfully!');
}

function getLogEntries(obj, rawPart, runId) {
    const entries = [];

    if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
        obj.message.content.forEach(block => {
            if (block.type === 'text' && block.text && block.text.trim() && block.text.trim() !== '(no content)') {
                entries.push({ type: 'TXT', typeClass: 'type-content', previewText: block.text.trim(), content: JSON.stringify(block) });
            } else if (block.type === 'thought' && block.thought && block.thought.trim()) {
                entries.push({ type: 'TXT', typeClass: 'type-content', previewText: `*Thought: ${block.thought.trim().slice(0, 500)}...*`, content: JSON.stringify(block) });
            } else if (block.type === 'tool_use') {
                entries.push(processToolUse(block, JSON.stringify(block)));
            }
        });
    } else if (obj.type === 'tool_use') {
        entries.push(processToolUse(obj, rawPart));
    } else if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
        obj.message.content.forEach(block => {
            if (block.type === 'tool_result' && block.tool_use_id) {
                updateToolStatus(block, runId);
                entries.push({ type: 'tool_result', toolUseId: block.tool_use_id, skip: true, content: JSON.stringify(block) });
            } else if (block.type === 'text' || (block.content && block.type !== 'tool_result')) {
                const text = block.text || (typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
                entries.push({ type: 'USER', typeClass: 'type-content', previewText: text, content: JSON.stringify(block) });
            }
        });
    } else if (obj.type === 'tool_result') {
        updateToolStatus(obj, runId);
        entries.push({ type: 'tool_result', toolUseId: obj.tool_use_id, skip: true, content: rawPart });
    } else if (obj.type === 'error' || obj.error) {
        entries.push({ type: 'ERROR', typeClass: 'type-error', previewText: (obj.error && obj.error.message) ? obj.error.message : JSON.stringify(obj), content: rawPart });
    } else if (obj.type === 'assistant' && typeof obj.message === 'string' && obj.message.trim()) {
        entries.push({ type: 'TXT', typeClass: 'type-content', previewText: obj.message.trim(), content: rawPart });
    }

    return entries;
}

function processToolUse(toolObj, rawPart) {
    const toolName = toolObj.name || 'tool';
    const toolUseId = toolObj.id;
    let typeClass = (['Read', 'EnterPlanMode', 'ExitPlanMode'].includes(toolName)) ? 'type-success' : 'type-tool';
    let previewText = '';

    const input = toolObj.input || {};
    if (toolName === 'Bash' && input.command) previewText = input.command;
    else if (['Write', 'Edit', 'Read'].includes(toolName) && input.file_path) previewText = input.file_path.split('/').pop();
    else if (toolName === 'ExitPlanMode' && input.plan) previewText = input.plan;
    else if (toolName === 'AskUserQuestion') {
        if (input.question) previewText = input.question;
        else if (Array.isArray(input.questions) && input.questions[0]) previewText = input.questions[0].question || JSON.stringify(input);
        else previewText = JSON.stringify(input);
    } else if (toolName === 'TodoWrite' && Array.isArray(input.todos)) {
        const todos = input.todos;
        const idx = todos.findIndex(t => t.status === 'in_progress');
        if (idx !== -1) previewText = `(${idx + 1}/${todos.length}) ${todos[idx].content}`;
        else if (todos.every(t => t.status === 'completed')) previewText = 'completed';
        else previewText = `Assigned: ${todos.length} todos`;
    } else previewText = JSON.stringify(input);

    return { type: toolName, toolName, toolUseId, typeClass, previewText, content: rawPart };
}

function updateToolStatus(block, runId) {
    let resultClass = block.is_error ? 'type-error' : 'type-success';
    const targetTool = db.prepare('SELECT tool_name FROM log_entries WHERE run_id = ? AND tool_use_id = ?').get(runId, block.tool_use_id);
    if (targetTool && ['EnterPlanMode', 'ExitPlanMode', 'Read'].includes(targetTool.tool_name)) {
        resultClass = 'type-success';
    }
    if (resultClass !== 'type-success' && !block.is_error && block.content) {
        const contentStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        if (contentStr.toLowerCase().includes('successfully') || contentStr.includes("has been updated")) resultClass = 'type-success';
    }
    const updateLogStatus = db.prepare('UPDATE log_entries SET status_class = ? WHERE run_id = ? AND tool_use_id = ?');
    updateLogStatus.run(resultClass, runId, block.tool_use_id);
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
