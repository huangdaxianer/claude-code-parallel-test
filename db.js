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
    CREATE TABLE IF NOT EXISTS user_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        is_default INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        group_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(group_id) REFERENCES user_groups(id)
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
        model_id TEXT,
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
        UNIQUE(task_id, model_id),
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
        model_id TEXT NOT NULL,
        question_id INTEGER NOT NULL,
        score INTEGER,
        comment TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(question_id) REFERENCES feedback_questions(id),
        FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS feedback_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        user_id INTEGER,
        target_type TEXT NOT NULL, -- 'trajectory' or 'artifact'
        target_ref TEXT, -- run_id for trajectory, file_path for artifact
        selection_range TEXT, -- JSON string
        content TEXT NOT NULL,
        original_content TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        user_id INTEGER,
        content TEXT NOT NULL,
        images TEXT, -- JSON array of image paths
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS model_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id TEXT UNIQUE NOT NULL,
        endpoint_name TEXT UNIQUE NOT NULL,
        description TEXT,
        is_default_checked INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS model_group_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        is_enabled INTEGER DEFAULT 1,
        is_default_checked INTEGER DEFAULT 1,
        display_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(model_id, group_id),
        FOREIGN KEY(model_id) REFERENCES model_configs(id) ON DELETE CASCADE,
        FOREIGN KEY(group_id) REFERENCES user_groups(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_task_model_question ON feedback_responses(task_id, model_id, question_id);
    CREATE INDEX IF NOT EXISTS idx_queue_status ON task_queue(status);
    CREATE INDEX IF NOT EXISTS idx_feedback_task_model ON feedback_responses(task_id, model_id);
    CREATE INDEX IF NOT EXISTS idx_user_feedback_task_id ON user_feedback(task_id);

    -- GSB 打分功能表
    CREATE TABLE IF NOT EXISTS gsb_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        model_a_id TEXT NOT NULL,
        model_b_id TEXT NOT NULL,
        user_id INTEGER,
        status TEXT DEFAULT 'scoring',
        total_count INTEGER DEFAULT 0,
        completed_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS gsb_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        display_order INTEGER DEFAULT 0,
        rating TEXT,
        rated_at DATETIME,
        FOREIGN KEY(job_id) REFERENCES gsb_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gsb_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL UNIQUE,
        model_a_wins INTEGER DEFAULT 0,
        model_b_wins INTEGER DEFAULT 0,
        same_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        FOREIGN KEY(job_id) REFERENCES gsb_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_gsb_jobs_user_id ON gsb_jobs(user_id);
    CREATE INDEX IF NOT EXISTS idx_gsb_tasks_job_id ON gsb_tasks(job_id);
`);

// Migration: Add new columns to log_entries if they don't exist
try { db.exec("ALTER TABLE log_entries ADD COLUMN type TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE log_entries ADD COLUMN tool_name TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE log_entries ADD COLUMN tool_use_id TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE log_entries ADD COLUMN preview_text TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE log_entries ADD COLUMN status_class TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE log_entries ADD COLUMN is_flagged INTEGER DEFAULT 0"); } catch (e) { }
try { db.exec("ALTER TABLE model_runs ADD COLUMN previewable TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE feedback_questions ADD COLUMN short_name TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE feedback_questions ADD COLUMN options_json TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE feedback_questions ADD COLUMN display_order INTEGER DEFAULT 0"); } catch (e) { }

// Migration: Add user_id column to tasks if it doesn't exist
try { db.exec("ALTER TABLE tasks ADD COLUMN user_id INTEGER"); } catch (e) { }
try { db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'internal'"); } catch (e) { }
try { db.exec("ALTER TABLE users ADD COLUMN group_id INTEGER"); } catch (e) { }

// Now safe to create index
try { db.exec("CREATE INDEX IF NOT EXISTS idx_log_tool_use_id ON log_entries(tool_use_id)"); } catch (e) { }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)"); } catch (e) { }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_users_group_id ON users(group_id)"); } catch (e) { }

// Create default user group and migrate existing users
try {
    // First create the default group if it doesn't exist
    const defaultGroup = db.prepare("SELECT id FROM user_groups WHERE is_default = 1").get();
    let defaultGroupId;

    if (!defaultGroup) {
        const result = db.prepare("INSERT INTO user_groups (name, is_default) VALUES (?, 1)").run('默认');
        defaultGroupId = result.lastInsertRowid;
        console.log('[DB] Created default user group: 默认 (id:', defaultGroupId, ')');
    } else {
        defaultGroupId = defaultGroup.id;
    }

    // Migrate existing users without group_id to the default group
    const migrateResult = db.prepare("UPDATE users SET group_id = ? WHERE group_id IS NULL").run(defaultGroupId);
    if (migrateResult.changes > 0) {
        console.log(`[DB] Migrated ${migrateResult.changes} existing users to default group`);
    }
} catch (e) {
    console.error('[DB] User groups migration error:', e.message);
}

// Create default user 'huangpenghao' and migrate existing tasks
try {
    const defaultGroup = db.prepare("SELECT id FROM user_groups WHERE is_default = 1").get();
    const existingUser = db.prepare("SELECT id FROM users WHERE username = ?").get('huangpenghao');
    if (!existingUser) {
        db.prepare("INSERT INTO users (username, role, group_id) VALUES (?, ?, ?)").run('huangpenghao', 'admin', defaultGroup?.id);
        console.log('[DB] Created default user: huangpenghao (admin)');
    } else if (existingUser && !existingUser.role) {
        db.prepare("UPDATE users SET role = ? WHERE username = ?").run('admin', 'huangpenghao');
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

// Migration: Add model_id and endpoint_name columns to model_configs if they don't exist
try { db.exec("ALTER TABLE model_configs ADD COLUMN model_id TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE model_configs ADD COLUMN endpoint_name TEXT"); } catch (e) { }

// Migration: Add model_id column to related tables (replacing model_name)
try { db.exec("ALTER TABLE model_runs ADD COLUMN model_id TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE feedback_responses ADD COLUMN model_id TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE feedback_comments ADD COLUMN model_id TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE user_feedback ADD COLUMN model_id TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE gsb_jobs ADD COLUMN model_a_id TEXT"); } catch (e) { }
try { db.exec("ALTER TABLE gsb_jobs ADD COLUMN model_b_id TEXT"); } catch (e) { }

// Helper function to generate 5-character model ID
function generateModelId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 5; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Migration: Generate model_id for existing models that don't have one
try {
    const tableInfo = db.prepare("PRAGMA table_info(model_configs)").all();
    const hasNameCol = tableInfo.some(col => col.name === 'name');

    // Only run if we can select something meaningful or if we need to migrate
    // If name column is missing, we assume endpoint_name is the source of truth or it is empty
    if (hasNameCol) {
        const modelsWithoutId = db.prepare("SELECT id, name FROM model_configs WHERE model_id IS NULL OR model_id = ''").all();
        if (modelsWithoutId.length > 0) {
            const updateStmt = db.prepare("UPDATE model_configs SET model_id = ?, endpoint_name = COALESCE(endpoint_name, name) WHERE id = ?");
            for (const model of modelsWithoutId) {
                let modelId;
                do {
                    modelId = generateModelId();
                } while (db.prepare("SELECT 1 FROM model_configs WHERE model_id = ?").get(modelId));
                updateStmt.run(modelId, model.id);
            }
            console.log(`[DB] Generated model_id for ${modelsWithoutId.length} existing models`);
        }
    }
} catch (e) {
    console.error('[DB] Model ID migration error:', e.message);
}

// Migration: Update model_id in related tables based on model_name
try {
    // Check if model_runs has model_name column (it might not if fresh schema used create table without it?)
    // Wait, CREATE TABLE model_runs (step 777) does NOT have model_name.
    // So this migration script will fail on db.prepare if model_name is missing.
    const mrInfo = db.prepare("PRAGMA table_info(model_runs)").all();
    const mrHasModelName = mrInfo.some(col => col.name === 'model_name');

    if (mrHasModelName) {
        const runsToMigrate = db.prepare(`
            SELECT mr.id, mr.model_name, mc.model_id 
            FROM model_runs mr 
            LEFT JOIN model_configs mc ON mc.endpoint_name = mr.model_name
            WHERE mr.model_id IS NULL AND mr.model_name IS NOT NULL AND mc.model_id IS NOT NULL
        `).all();

        if (runsToMigrate.length > 0) {
            const updateStmt = db.prepare("UPDATE model_runs SET model_id = ? WHERE id = ?");
            for (const run of runsToMigrate) {
                updateStmt.run(run.model_id, run.id);
            }
            console.log(`[DB] Migrated model_id for ${runsToMigrate.length} model_runs`);
        }
    }
} catch (e) {
    console.error('[DB] Model runs migration error:', e.message);
}

// Initialize model_group_settings for all model/group combinations that don't exist
try {
    const models = db.prepare("SELECT id, model_id, is_default_checked FROM model_configs WHERE model_id IS NOT NULL").all();
    const groups = db.prepare("SELECT id FROM user_groups").all();

    const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO model_group_settings (model_id, group_id, is_enabled, is_default_checked, display_name)
        VALUES (?, ?, 1, ?, NULL)
    `);

    let insertedCount = 0;
    for (const model of models) {
        for (const group of groups) {
            const result = insertStmt.run(model.id, group.id, model.is_default_checked);
            if (result.changes > 0) insertedCount++;
        }
    }

    if (insertedCount > 0) {
        console.log(`[DB] Initialized ${insertedCount} model_group_settings entries`);
    }
} catch (e) {
    console.error('[DB] Model group settings initialization error:', e.message);
}

module.exports = db;
