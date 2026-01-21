const readline = require('readline');
const db = require('./db');
const path = require('path');
const fs = require('fs');

const taskId = process.argv[2];
const modelName = process.argv[3];

if (!taskId || !modelName) {
    console.error('Usage: node ingest.js <taskId> <modelName>');
    process.exit(1);
}

const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
});

// Global Error Handling
process.on('uncaughtException', (err) => {
    console.error(`[Ingest Fatal Error] Uncaught Exception: ${err.message}`);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[Ingest Fatal Error] Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

process.stderr.write(`[Ingest] Started for Task: ${taskId}, Model: ${modelName}\n`);

// Get run_id
const run = db.prepare('SELECT id FROM model_runs WHERE task_id = ? AND model_name = ?').get(taskId, modelName);
if (!run) {
    console.error(`Run not found for ${taskId} - ${modelName}`);
    process.exit(1);
}
const runId = run.id;

// Update status to running immediately
db.prepare('UPDATE model_runs SET status = ? WHERE id = ?').run('running', runId);

const updateStats = db.prepare(`
    UPDATE model_runs SET 
        status = ?,
        duration = ?,
        turns = ?,
        input_tokens = ?,
        output_tokens = ?,
        cache_read_tokens = ?,
        count_todo_write = ?,
        count_read = ?,
        count_write = ?,
        count_bash = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
`);

const insertLog = db.prepare(`
    INSERT INTO log_entries (run_id, line_number, type, tool_name, tool_use_id, preview_text, status_class, content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLogStatus = db.prepare(`
    UPDATE log_entries SET status_class = ? WHERE run_id = ? AND tool_use_id = ?
`);

// Local counters to avoid heavy DB reads
let stats = {
    status: 'running',
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

let lineNumber = 0;

function flush() {
    try {
        updateStats.run(
            stats.status,
            stats.duration,
            stats.turns,
            stats.inputTokens,
            stats.outputTokens,
            stats.cacheReadTokens,
            stats.toolCounts.TodoWrite,
            stats.toolCounts.Read,
            stats.toolCounts.Write,
            stats.toolCounts.Bash,
            runId
        );
    } catch (e) {
        console.error('Failed to update DB stats:', e);
    }
}

/**
 * Process a JSON log object and return an array of entries to be inserted into the DB.
 */
function getLogEntries(obj, rawPart) {
    const entries = [];

    // 1. Assistant Message Handling (may contain text, thought, and tool_use)
    if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
        obj.message.content.forEach(block => {
            if (block.type === 'text' && block.text && block.text.trim() && block.text.trim() !== '(no content)') {
                entries.push({
                    type: 'TXT',
                    typeClass: 'type-content',
                    previewText: block.text.trim(),
                    content: JSON.stringify(block)
                });
            } else if (block.type === 'thought' && block.thought && block.thought.trim()) {
                entries.push({
                    type: 'TXT',
                    typeClass: 'type-content',
                    previewText: `*Thought: ${block.thought.trim().slice(0, 500)}${block.thought.length > 500 ? '...' : ''}*`,
                    content: JSON.stringify(block)
                });
            } else if (block.type === 'tool_use') {
                entries.push(processToolUse(block, JSON.stringify(block)));
            }
        });
    }
    // 2. Direct Tool Use
    else if (obj.type === 'tool_use') {
        entries.push(processToolUse(obj, rawPart));
    }
    // 3. User Message Handling (may contain text or tool_result)
    else if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
        obj.message.content.forEach(block => {
            if (block.type === 'tool_result' && block.tool_use_id) {
                updateToolStatus(block);
                entries.push({
                    type: 'tool_result',
                    toolUseId: block.tool_use_id,
                    skip: true,
                    content: JSON.stringify(block)
                });
            } else if (block.type === 'text' || (block.content && block.type !== 'tool_result')) {
                const text = block.text || (typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
                entries.push({
                    type: 'USER',
                    typeClass: 'type-content',
                    previewText: text,
                    content: JSON.stringify(block)
                });
            }
        });
    }
    // 4. Standalone Tool Result
    else if (obj.type === 'tool_result') {
        updateToolStatus(obj);
        entries.push({
            type: 'tool_result',
            toolUseId: obj.tool_use_id,
            skip: true,
            content: rawPart
        });
    }
    // 5. Errors
    else if (obj.type === 'error' || obj.error) {
        entries.push({
            type: 'ERROR',
            typeClass: 'type-error',
            previewText: (obj.error && obj.error.message) ? obj.error.message : JSON.stringify(obj),
            content: rawPart
        });
    }
    // 6. Generic assistant fallback
    else if (obj.type === 'assistant' && typeof obj.message === 'string' && obj.message.trim()) {
        entries.push({
            type: 'TXT',
            typeClass: 'type-content',
            previewText: obj.message.trim(),
            content: rawPart
        });
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

    return {
        type: toolName,
        toolName: toolName,
        toolUseId: toolUseId,
        typeClass: typeClass,
        previewText: previewText,
        content: rawPart
    };
}

function updateToolStatus(block) {
    let resultClass = block.is_error ? 'type-error' : 'type-success';

    // Force certain tools to always be green
    const targetTool = db.prepare('SELECT tool_name FROM log_entries WHERE run_id = ? AND tool_use_id = ?').get(runId, block.tool_use_id);
    if (targetTool && ['EnterPlanMode', 'ExitPlanMode', 'Read'].includes(targetTool.tool_name)) {
        resultClass = 'type-success';
    }

    // Extra check for success
    if (resultClass !== 'type-success' && !block.is_error && block.content) {
        const contentStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        if (contentStr.toLowerCase().includes('successfully') || contentStr.includes("has been updated")) {
            resultClass = 'type-success';
        }
    }
    updateLogStatus.run(resultClass, runId, block.tool_use_id);
    return resultClass;
}

// Throttle DB updates
let lastFlush = Date.now();

rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
        // Match anything between { and } that looks like a JSON object
        const jsonMatch = line.match(/\{.*\}/);
        if (!jsonMatch) {
            if (line.trim()) {
                console.error(`[Ingest Non-JSON] ${line.slice(0, 200)}`);
            }
            return;
        }

        const parts = jsonMatch[0].replace(/}\s*{/g, '}\n{').split('\n');

        parts.forEach(part => {
            if (!part.trim()) return;
            try {
                const obj = JSON.parse(part);
                lineNumber++;

                // 1. Update Stats
                if (obj.type === 'result') {
                    stats.status = 'completed';
                    if (obj.duration_ms) stats.duration = (obj.duration_ms / 1000).toFixed(1);
                    else if (obj.duration) stats.duration = (obj.duration / 1000).toFixed(1);
                    if (obj.usage) {
                        stats.inputTokens = obj.usage.input_tokens || 0;
                        stats.outputTokens = obj.usage.output_tokens || 0;
                        stats.cacheReadTokens = obj.usage.cache_read_input_tokens || 0;
                    }
                    process.stderr.write(`[Ingest] Received full result for ${modelName}\n`);
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

                // 2. Structured Log Entry
                const entries = getLogEntries(obj, part);
                entries.forEach(entry => {
                    insertLog.run(
                        runId,
                        lineNumber,
                        entry.skip ? 'HIDDEN_' + entry.type : entry.type,
                        entry.toolName || null,
                        entry.toolUseId || null,
                        entry.previewText || '',
                        entry.typeClass || (entry.skip ? 'type-tool' : 'type-content'),
                        entry.content
                    );
                });
            } catch (e) {
                console.error(`[Ingest Error] Failed to parse/process part: ${part.slice(0, 100)}`, e);
            }
        });

        if (Date.now() - lastFlush > 500) {
            flush();
            lastFlush = Date.now();
        }
    } catch (e) {
        // Log general errors (like DB lock) to stderr
        console.error(`[Ingest Fatal] Error in rl.on('line'):`, e);
    }
});

// Helper: Detect project type (Duplicated from server.js for standalone execution)
function detectProjectType(projectPath) {
    if (!fs.existsSync(projectPath)) return 'unknown';

    // Check for Node
    if (fs.existsSync(path.join(projectPath, 'package.json'))) return 'node';

    // Check for Java
    if (fs.existsSync(path.join(projectPath, 'pom.xml'))) return 'java';

    // Check for simple HTML
    const files = fs.readdirSync(projectPath);
    if (files.some(f => f.endsWith('.html'))) return 'html';

    // Check subfolders
    if (fs.existsSync(path.join(projectPath, 'backend', 'pom.xml'))) return 'java';
    if (fs.existsSync(path.join(projectPath, 'server', 'package.json'))) return 'node';
    if (fs.existsSync(path.join(projectPath, 'web', 'package.json'))) return 'node';
    if (fs.existsSync(path.join(projectPath, 'frontend', 'package.json'))) return 'node';

    return 'unknown';
}

rl.on('close', () => {
    flush();

    // Check if project is previewable (only if completed successfully)
    if (stats.status === 'completed') {
        const TASKS_DIR = path.join(__dirname, '../tasks');
        const projectPath = path.join(TASKS_DIR, taskId, modelName);

        try {
            const type = detectProjectType(projectPath);
            const isPreviewable = (type === 'node' || type === 'html') ? 1 : 0;

            db.prepare('UPDATE model_runs SET previewable = ? WHERE id = ?').run(isPreviewable, runId);
            // console.log(`[Ingest] Project type: ${type}, Previewable: ${isPreviewable}`);
        } catch (e) {
            console.error('[Ingest] Failed to update previewable status:', e);
        }
    }
});
