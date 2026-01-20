const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const TASKS_DIR = path.join(__dirname, '../tasks');
const DB_PATH = path.join(TASKS_DIR, 'tasks.db');

// Ensure tasks directory exists
if (!fs.existsSync(TASKS_DIR)) {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Initialize Tables
db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        title TEXT,
        prompt TEXT,
        base_dir TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS model_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        model_name TEXT,
        status TEXT,
        duration REAL,
        turns INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        count_todo_write INTEGER,
        count_read INTEGER,
        count_write INTEGER,
        count_bash INTEGER,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(task_id, model_name),
        FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS log_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER,
        line_number INTEGER,
        content TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(run_id) REFERENCES model_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_log_run_id ON log_entries(run_id);
    CREATE INDEX IF NOT EXISTS idx_model_runs_task_id ON model_runs(task_id);
    CREATE TABLE IF NOT EXISTS task_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT UNIQUE,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        completed_at DATETIME,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_queue_status ON task_queue(status);
`);

// Migration: Add new columns to log_entries if they don't exist
try { db.exec("ALTER TABLE log_entries ADD COLUMN type TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE log_entries ADD COLUMN tool_name TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE log_entries ADD COLUMN tool_use_id TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE log_entries ADD COLUMN preview_text TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE log_entries ADD COLUMN status_class TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE model_runs ADD COLUMN previewable INTEGER DEFAULT 0"); } catch (e) { }

// Now safe to create index
try { db.exec("CREATE INDEX IF NOT EXISTS idx_log_tool_use_id ON log_entries(tool_use_id)"); } catch (e) { }

module.exports = db;
