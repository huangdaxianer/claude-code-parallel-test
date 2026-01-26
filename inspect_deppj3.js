
const db = require('./db');
const taskId = 'DEPPJ3';

console.log(`--- Inspecting ${taskId} ---`);
const runs = db.prepare('SELECT * FROM model_runs WHERE task_id = ?').all(taskId);
console.log(JSON.stringify(runs, null, 2));

const tasks = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
console.log('Task:', tasks);
