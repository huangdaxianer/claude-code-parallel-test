
const db = require('./db');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TASK_ID = 'TEST_NEW_FLOW';
const MODEL_NAME = 'test_model';
const PROJECT_DIR = path.join(__dirname, '../tasks', TASK_ID, MODEL_NAME);

// 1. Setup Mock Project
if (!fs.existsSync(PROJECT_DIR)) {
    fs.mkdirSync(PROJECT_DIR, { recursive: true });
}
fs.writeFileSync(path.join(PROJECT_DIR, 'server.py'), 'print("Mock Server")');
fs.writeFileSync(path.join(PROJECT_DIR, 'requirements.txt'), 'flask');

// 2. Setup DB
// db.prepare('DELETE FROM items WHERE id = ?').run(1); // Removed invalid table reference
db.prepare('DELETE FROM tasks WHERE task_id = ?').run(TASK_ID);
db.prepare('INSERT INTO tasks (task_id, title, prompt, user_id) VALUES (?, ?, ?, ?)').run(TASK_ID, 'Test Project', 'Create a server', 1);

db.prepare('DELETE FROM model_runs WHERE task_id = ?').run(TASK_ID);
const result = db.prepare('INSERT INTO model_runs (task_id, model_name, status, previewable) VALUES (?, ?, ?, ?)').run(TASK_ID, MODEL_NAME, 'completed', null);
const runId = result.lastInsertRowid;

console.log(`[Setup] Created task ${TASK_ID}/${MODEL_NAME} with previewable=NULL`);

// 3. Trigger Preview Start
const options = {
    hostname: 'localhost',
    port: 3001,
    path: `/api/preview/start`,
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    }
};

const req = http.request(options, (res) => {
    console.log(`[API] Start Status: ${res.statusCode}`);

    // 4. Poll DB for status change
    let attempts = 0;
    const interval = setInterval(() => {
        const row = db.prepare('SELECT previewable FROM model_runs WHERE id = ?').get(runId);
        console.log(`[Poll ${attempts}] Previewable: ${row.previewable}`);

        if (row.previewable === 'dynamic' || row.previewable === 'static') {
            clearInterval(interval);
            console.log('SUCCESS: Previewable status updated correctly!');
            process.exit(0);
        }

        if (row.previewable === 'preparing') {
            console.log('Still preparing...');
        }

        attempts++;
        if (attempts > 30) { // 30 seconds
            clearInterval(interval);
            console.log('TIMEOUT: Status did not update to dynamic/static in time.');
            process.exit(1);
        }
    }, 1000);
});

req.on('error', (e) => {
    console.error(`[API] Request failed: ${e.message}`);
    process.exit(1);
});

req.write(JSON.stringify({ taskId: TASK_ID, modelName: MODEL_NAME }));
req.end();
