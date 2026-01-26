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
db.pragma('journal_mode = WAL');

// Cleanup duplicates before index creation
try {
    db.prepare(`
        DELETE FROM feedback_responses 
        WHERE id NOT IN (
            SELECT MIN(id) 
            FROM feedback_responses 
            GROUP BY task_id, model_name, question_id
        )
    `).run();
} catch (e) {
    console.error('[DB] Deduplication error:', e.message);
}

// Initialize Tables
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        title TEXT,
        prompt TEXT,
        base_dir TEXT,
        user_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
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
        previewable TEXT, -- 'static', 'dynamic', 'preparing', 'unpreviewable'
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

    CREATE TABLE IF NOT EXISTS feedback_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stem TEXT NOT NULL,
        short_name TEXT,
        scoring_type TEXT NOT NULL, -- 'stars_3' or 'stars_5'
        description TEXT,
        has_comment INTEGER DEFAULT 0, -- 0 or 1
        is_required INTEGER DEFAULT 0, -- 0 or 1
        is_active INTEGER DEFAULT 1, -- 0 or 1
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS feedback_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        question_id INTEGER NOT NULL,
        score INTEGER,
        comment TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(question_id) REFERENCES feedback_questions(id),
        FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_task_model_question ON feedback_responses(task_id, model_name, question_id);
    CREATE INDEX IF NOT EXISTS idx_queue_status ON task_queue(status);
    CREATE INDEX IF NOT EXISTS idx_feedback_task_model ON feedback_responses(task_id, model_name);
`);

// Migration: Add new columns to log_entries if they don't exist
try { db.exec("ALTER TABLE log_entries ADD COLUMN type TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE log_entries ADD COLUMN tool_name TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE log_entries ADD COLUMN tool_use_id TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE log_entries ADD COLUMN preview_text TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE log_entries ADD COLUMN status_class TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE model_runs ADD COLUMN previewable TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE feedback_questions ADD COLUMN short_name TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE feedback_questions ADD COLUMN options_json TEXT"); } catch (e) { }

// Migration: Add user_id column to tasks if it doesn't exist
try { db.exec("ALTER TABLE tasks ADD COLUMN user_id INTEGER"); } catch (e) { }

// Now safe to create index
try { db.exec("CREATE INDEX IF NOT EXISTS idx_log_tool_use_id ON log_entries(tool_use_id)"); } catch (e) { }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)"); } catch (e) { }

// Create default user 'huangpenghao' and migrate existing tasks
try {
    const existingUser = db.prepare("SELECT id FROM users WHERE username = ?").get('huangpenghao');
    if (!existingUser) {
        db.prepare("INSERT INTO users (username) VALUES (?)").run('huangpenghao');
        console.log('[DB] Created default user: huangpenghao');
    }
    // Migrate existing tasks without user_id to huangpenghao
    const defaultUser = db.prepare("SELECT id FROM users WHERE username = ?").get('huangpenghao');
    if (defaultUser) {
        const result = db.prepare("UPDATE tasks SET user_id = ? WHERE user_id IS NULL").run(defaultUser.id);
        if (result.changes > 0) {
            console.log(`[DB] Migrated ${result.changes} existing tasks to user huangpenghao`);
        }
    }
} catch (e) {
    console.error('[DB] Migration error:', e.message);
}

module.exports = db;
