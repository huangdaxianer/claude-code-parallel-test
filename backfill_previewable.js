const db = require('./db');
const fs = require('fs');
const path = require('path');

const TASKS_DIR = path.join(__dirname, '../tasks');

function detectProjectType(projectPath) {
    if (!fs.existsSync(projectPath)) return 'unknown';
    if (fs.existsSync(path.join(projectPath, 'package.json'))) return 'node';
    if (fs.existsSync(path.join(projectPath, 'pom.xml'))) return 'java';

    // Check subfolders
    if (fs.existsSync(path.join(projectPath, 'backend', 'pom.xml'))) return 'java';
    if (fs.existsSync(path.join(projectPath, 'server', 'package.json'))) return 'node';
    if (fs.existsSync(path.join(projectPath, 'web', 'package.json'))) return 'node';
    if (fs.existsSync(path.join(projectPath, 'frontend', 'package.json'))) return 'node';

    return 'unknown';
}

const runs = db.prepare('SELECT id, task_id, model_name FROM model_runs').all();
console.log(`Found ${runs.length} runs to check.`);

const update = db.prepare('UPDATE model_runs SET previewable = ? WHERE id = ?');
let updated = 0;

db.transaction(() => {
    for (const run of runs) {
        const projectPath = path.join(TASKS_DIR, run.task_id, run.model_name);
        const type = detectProjectType(projectPath);
        const isPreviewable = (type === 'node') ? 1 : 0;

        console.log(`[${run.task_id}/${run.model_name}] Type: ${type} -> Previewable: ${isPreviewable}`);
        update.run(isPreviewable, run.id);
        updated++;
    }
})();

console.log(`Updated ${updated} runs.`);
