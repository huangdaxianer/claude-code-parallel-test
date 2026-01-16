const readline = require('readline');
const db = require('./db');

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

// Update status to running immediately
db.prepare('UPDATE model_runs SET status = ? WHERE task_id = ? AND model_name = ?')
    .run('running', taskId, modelName);

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
    WHERE task_id = ? AND model_name = ?
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
            taskId,
            modelName
        );
    } catch (e) {
        console.error('Failed to update DB:', e);
    }
}

// Throttle DB updates to once per 500ms or so for multiple lines
let lastFlush = Date.now();

rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
        // Handle concatenated JSON if any
        const parts = line.replace(/}\s*{/g, '}\n{').split('\n');

        parts.forEach(part => {
            if (!part.startsWith('{')) return;
            const obj = JSON.parse(part);

            if (obj.type === 'result') {
                stats.status = 'completed';
                if (obj.duration_ms) stats.duration = (obj.duration_ms / 1000).toFixed(1);
                else if (obj.duration) stats.duration = (obj.duration / 1000).toFixed(1);

                if (obj.usage) {
                    stats.inputTokens = obj.usage.input_tokens || 0;
                    stats.outputTokens = obj.usage.output_tokens || 0;
                    stats.cacheReadTokens = obj.usage.cache_read_input_tokens || 0;
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
        });

        if (Date.now() - lastFlush > 500) {
            flush();
            lastFlush = Date.now();
        }
    } catch (e) {
        // Non-JSON or malformed line
    }
});

rl.on('close', () => {
    // Final flush
    // Check if it actually completed or just closed
    if (stats.status !== 'completed') {
        // We could check if the last line was a result, but for now just leave as is 
        // or set to 'failed' if we know it crashed?
        // Let's just flush whatever we have.
    }
    flush();
});
