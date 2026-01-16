const fs = require('fs');
const path = require('path');
const db = require('./db');

const TASKS_DIR = path.join(__dirname, 'tasks');
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

    const migrateAll = db.transaction((tasks) => {
        for (const task of tasks) {
            insertTask.run(task.taskId, task.title, task.prompt, task.baseDir);

            const taskDir = path.join(TASKS_DIR, task.taskId);
            if (fs.existsSync(taskDir)) {
                // Models were recorded in task.models or found in directory
                const models = task.models || [];

                models.forEach(modelName => {
                    const logFilePath = path.join(taskDir, `${modelName}.txt`);
                    let status = 'pending';
                    let stats = { duration: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, toolCounts: { TodoWrite: 0, Read: 0, Write: 0, Bash: 0 } };

                    if (fs.existsSync(logFilePath)) {
                        const content = fs.readFileSync(logFilePath, 'utf8');
                        stats = calculateLogStats(content);

                        // Determine status
                        const lines = content.split('\n').filter(l => l.trim());
                        if (lines.length > 0) {
                            status = 'running';
                            try {
                                const lastLine = lines[lines.length - 1];
                                if (lastLine.includes('"type":"result"')) status = 'completed';
                            } catch (e) { }
                        }
                    }

                    insertRun.run(
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
                });
            }
        }
    });

    migrateAll(history);
    console.log('Migration completed successfully!');
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
