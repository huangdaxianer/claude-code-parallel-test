/**
 * CLI 入口 - 用于手动调试
 * 功能已迁移到 services/ingestHandler.js
 */
const readline = require('readline');
const { IngestHandler } = require('./services/ingestHandler');

const taskId = process.argv[2];
const modelId = process.argv[3];

if (!taskId || !modelId) {
    console.error('Usage: node ingest.js <taskId> <modelId>');
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

process.stderr.write(`[Ingest] Started for Task: ${taskId}, Model: ${modelId}\n`);

let handler;
try {
    handler = new IngestHandler(taskId, modelId);
} catch (e) {
    console.error(`[Ingest] Failed to initialize: ${e.message}`);
    process.exit(1);
}

rl.on('line', (line) => {
    handler.processLine(line);

    // 如果已完成，退出
    if (handler.isFinished()) {
        process.stderr.write(`[Ingest] Task finished with status: ${handler.stats.status}. Exiting.\n`);
        process.exit(0);
    }
});

rl.on('close', () => {
    handler.finish();
});
