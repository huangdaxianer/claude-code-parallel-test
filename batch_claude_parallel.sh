#!/bin/bash

# 获取脚本所在目录并定义任务目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
mkdir -p "$SCRIPT_DIR/../tasks"
TASKS_DIR="$( cd "$SCRIPT_DIR/../tasks" && pwd )"
mkdir -p "$TASKS_DIR"

# Set Locale to UTF-8 to support Chinese prompts
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8

# 检查是否可用 Sudo 且存在隔离用户
USE_ISOLATION=false
if sudo -n true >/dev/null 2>&1 && id "claude-user" >/dev/null 2>&1; then
    USE_ISOLATION=true
    echo "[Info] 使用隔离用户 claude-user 运行"
else
    echo "[Info] Sudo/claude-user 不可用，将在当前用户权限下运行"
fi

# Load Environment Variables from settings.json
SETTINGS_FILE="$HOME/.claude/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
    echo "[Info] Loading environment variables from $SETTINGS_FILE"
    # Use node to parse JSON and output export commands
    VARS=$(node -e "
        try {
            const fs = require('fs');
            const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf8'));
            if (settings.env) {
                Object.keys(settings.env).forEach(key => {
                    console.log(\`export \${key}='\${settings.env[key]}'\`);
                });
            }
        } catch (e) {
            console.error('Error parsing settings.json:', e.message);
        }
    ")
    eval "$VARS"
fi

# 修正临时目录权限
if [ "$USE_ISOLATION" = true ]; then
    sudo -n mkdir -p /tmp/claude
    sudo -n chmod 777 /tmp/claude
else
    mkdir -p /tmp/claude 2>/dev/null
    chmod 777 /tmp/claude 2>/dev/null
fi

# 动态获取 claude 路径
CLAUDE_BIN=$(which claude)
if [ -z "$CLAUDE_BIN" ]; then
    if [ -f "$HOME/.npm-global/bin/claude" ]; then
        CLAUDE_BIN="$HOME/.npm-global/bin/claude"
    elif [ -f "/usr/local/bin/claude" ]; then
        CLAUDE_BIN="/usr/local/bin/claude"
    else
        echo "错误: 未找到 claude 可执行文件"
        exit 1
    fi
fi

# Set a trap to cleanup child processes on exit
cleanup() {
    echo "[Batch] Cleaning up child processes..."
    # Kill all child processes in the current process group
    # We use ps to find all PIDs that have the current script as ancestor
    pkill -P $$ 2>/dev/null
    
    # Also try to kill background jobs explicitly
    jobs -p | xargs kill 2>/dev/null
    
    # Force kill any firejail instances related to this task if we can identify them?
    # Actually, pkill -P $$ should catch the direct children (firejail/claude).
    # But grandchildren (like python server) might be detached if they used double-fork or setsid.
    
    # Wait a bit
    sleep 1
}
trap cleanup EXIT

# Function to run a single model
run_single_model() {
    local task_id="$1"
    local model_name="$2"
    local task_root="$TASKS_DIR/${task_id}"
    local folder_path="$task_root/$model_name"
    
    echo "[Task $task_id] 启动单个模型: $model_name"
    
    # Ensure directories exist
    mkdir -p "$folder_path"
    
    # Copy base files if needed (check if folder is empty)
    local base_dir=$(node -e "
        const Database = require('better-sqlite3');
        const path = require('path');
        const dbPath = path.join('$TASKS_DIR', 'tasks.db');
        try {
            const db = new Database(dbPath, { readonly: true });
            const task = db.prepare('SELECT base_dir FROM tasks WHERE task_id = ?').get('$task_id');
            if (task && task.base_dir) console.log(task.base_dir);
        } catch (e) {}
    ")
    
    if [[ -n "$base_dir" && -d "$base_dir" ]]; then
        # Only copy if folder is empty (new or restarted)
        if [ -z "$(ls -A "$folder_path" 2>/dev/null)" ]; then
            cp -R "$base_dir/." "$folder_path/"
        fi
    fi
    
    # 赋予权限
    if [ "$USE_ISOLATION" = true ]; then
        chmod -R 777 "$task_root"
        sudo -n chown -R claude-user "$task_root" 2>/dev/null
    fi
    
    cd "$folder_path" || exit 1
    
    local CMD_PREFIX=""
    if [ "$USE_ISOLATION" = true ]; then
         CMD_PREFIX="sudo -n -H -u claude-user env"
         CMD_PREFIX="$CMD_PREFIX ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN"
         CMD_PREFIX="$CMD_PREFIX ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
         CMD_PREFIX="$CMD_PREFIX CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
    fi

    # Set Pipefail to capture first command failure
    set -o pipefail

    echo "[Task $task_id] [$model_name] Environment check:"
    echo "  - CLAUDE_BIN: $CLAUDE_BIN"
    echo "  - CMD_PREFIX: $CMD_PREFIX"
    echo "  - PWD: $(pwd)"
    
    # Build firejail wrapper if available
    local USE_FIREJAIL=false
    local FIREJAIL_ARGS=""
    
    if command -v firejail &> /dev/null; then
        USE_FIREJAIL=true
        local TASK_DIR="$(dirname $(pwd))"
        local TASKS_ROOT="$(dirname $TASK_DIR)"
        local PROJECT_ROOT="$(dirname $TASKS_ROOT)"
        local CURRENT_TASK="$(basename $TASK_DIR)"
        local CURRENT_MODEL="$model_name"
        
        # 移除 whitelist 模式，因为它会导致路径访问权限异常
        # 依靠严格的 blacklist 和用户隔离来提供安全保障
        FIREJAIL_ARGS=""
        
        # 黑名单：阻止访问其他项目
        FIREJAIL_ARGS="$FIREJAIL_ARGS --blacklist=$PROJECT_ROOT/claude-code-parallel-test"
        
        # 黑名单：阻止访问其他任务目录
        for dir in "$TASKS_ROOT"/*/; do
            local dir_name=$(basename "$dir")
            if [ "$dir_name" != "$CURRENT_TASK" ] && [ "$dir_name" != "temp_uploads" ]; then
                FIREJAIL_ARGS="$FIREJAIL_ARGS --blacklist=$dir"
            fi
        done
        
        # 黑名单：阻止访问同任务下的其他模型目录
        for model_dir in "$TASK_DIR"/*/; do
            local model_dir_name=$(basename "$model_dir")
            if [ "$model_dir_name" != "$CURRENT_MODEL" ]; then
                FIREJAIL_ARGS="$FIREJAIL_ARGS --blacklist=$model_dir"
            fi
        done
        
        # 黑名单：阻止访问任务目录下的所有日志文件（除了 prompt.txt 和 title.txt）
        # 注意：移除了对 $CURRENT_MODEL.txt 的豁免，防止访问父目录的同名文件
        for log_file in "$TASK_DIR"/*.txt; do
            local log_name=$(basename "$log_file" .txt)
            FIREJAIL_ARGS="$FIREJAIL_ARGS --blacklist=$log_file"
        done
        
        # 黑名单：阻止访问敏感系统文件
        FIREJAIL_ARGS="$FIREJAIL_ARGS --blacklist=/root/.ssh"
        FIREJAIL_ARGS="$FIREJAIL_ARGS --blacklist=/root/.gnupg"
        FIREJAIL_ARGS="$FIREJAIL_ARGS --blacklist=/etc/shadow"
        FIREJAIL_ARGS="$FIREJAIL_ARGS --blacklist=/etc/passwd"
        
        echo "  - FIREJAIL: enabled (model $CURRENT_MODEL isolated from other models)"
    else
        echo "  - FIREJAIL: not installed, running without sandbox"
    fi
    
    if [ "$USE_FIREJAIL" = true ]; then
        if ! cat "$task_root/prompt.txt" | firejail --quiet --noprofile \
            $FIREJAIL_ARGS \
            -- $CMD_PREFIX "$CLAUDE_BIN" --model "$model_name" \
            --allowedTools 'Read(./**),Edit(./**),Bash(./**)' \
            --disallowedTools 'EnterPlanMode,ExitPlanMode' \
            --dangerously-skip-permissions \
            --output-format stream-json --verbose 2>&1 | \
            tee "$task_root/${model_name}.txt" | \
            node "$SCRIPT_DIR/ingest.js" "$task_id" "$model_name"
        then
            EXIT_CODE=$?
            echo "[Task $task_id] [$model_name] 运行异常 (Exit Code: $EXIT_CODE)"
            if [ $EXIT_CODE -eq 127 ]; then
                echo "  -> Error: Command not found. Check CLAUDE_BIN path."
            fi
            exit $EXIT_CODE
        else
            echo "[Task $task_id] [$model_name] 完成"
        fi
    else
        if ! cat "$task_root/prompt.txt" | $CMD_PREFIX "$CLAUDE_BIN" \
            --model "$model_name" \
            --allowedTools 'Read(./**),Edit(./**),Bash(./**)' \
            --disallowedTools 'EnterPlanMode,ExitPlanMode' \
            --dangerously-skip-permissions \
            --output-format stream-json --verbose 2>&1 | \
            tee "$task_root/${model_name}.txt" | \
            node "$SCRIPT_DIR/ingest.js" "$task_id" "$model_name"
        then
            EXIT_CODE=$?
            echo "[Task $task_id] [$model_name] 运行异常 (Exit Code: $EXIT_CODE)"
            if [ $EXIT_CODE -eq 127 ]; then
                echo "  -> Error: Command not found. Check CLAUDE_BIN path."
            fi
            exit $EXIT_CODE
        else
            echo "[Task $task_id] [$model_name] 完成"
        fi
    fi
    
    if [ "$USE_ISOLATION" = true ]; then
        sudo -n -u claude-user chmod -R a+rX "$folder_path" 2>/dev/null || true
    fi
}

# Function to process a single task (legacy - runs all pending models)
process_task() {
    local base_dir="$1"
    local title="$2"
    local prompt="$3"
    local task_id="$4"
    local models_str="$5"
    
    # Debug info
    echo "Processing Task: $task_id"
    echo "Title: $title"

    if [[ -n "$models_str" ]]; then
        OLD_IFS=$IFS; IFS=',' read -r -a MODELS <<< "$models_str"; IFS=$OLD_IFS
    else
        MODELS=("potato" "tomato" "strawberry" "watermelon" "banana" "avocado" "cherry" "pineapple")
    fi

    local task_root="$TASKS_DIR/${task_id}"
    mkdir -p "$task_root"
    echo "$title" > "$task_root/title.txt"
    echo "$prompt" > "$task_root/prompt.txt"
    
    for model_name in "${MODELS[@]}"; do
        run_single_model "$task_id" "$model_name" &
    done
    wait
}

INPUT_ARG="$1"
MODEL_ARG="$2"

# Prepare Isolation user home if needed
if [ "$USE_ISOLATION" = true ]; then
    CLAUDE_USER_HOME=$(eval echo "~claude-user")
    if [ ! -d "$CLAUDE_USER_HOME" ]; then
       if [[ "$OSTYPE" == "darwin"* ]]; then
           CLAUDE_USER_HOME="/Users/claude-user"
       else
           CLAUDE_USER_HOME="/home/claude-user"
       fi
    fi

    if [ -d "$HOME/.claude" ]; then
        sudo -n mkdir -p "$CLAUDE_USER_HOME/.claude"
        sudo -n cp -R "$HOME/.claude/." "$CLAUDE_USER_HOME/.claude/"
        sudo -n chown -R claude-user "$CLAUDE_USER_HOME/.claude"
    fi
fi

# Main Logic: Check execution mode
if [ -f "$INPUT_ARG" ]; then
    # Legacy Mode: Read from File
    echo "[Batch] Reading tasks from file: $INPUT_ARG"
    while IFS=';' read -r base_dir title prompt task_id models_str || [[ -n "$base_dir" ]]; do
         if [[ -z "$title" && -z "$prompt" ]]; then continue; fi
         if [[ -z "$task_id" ]]; then task_id=$(echo "$RANDOM" | md5sum | head -c 6 | tr '[:lower:]' '[:upper:]'); fi
         process_task "$base_dir" "$title" "$prompt" "$task_id" "$models_str"
    done < "$INPUT_ARG"
elif [ -n "$INPUT_ARG" ] && [ -n "$MODEL_ARG" ]; then
    # Single Model Mode: Run specific model for a task
    TASK_ID="$INPUT_ARG"
    MODEL_NAME="$MODEL_ARG"
    echo "[Batch] Running single model: $MODEL_NAME for task: $TASK_ID"
    
    # Ensure prompt.txt and title.txt exist (fetch from DB if needed)
    TASK_ROOT="$TASKS_DIR/${TASK_ID}"
    mkdir -p "$TASK_ROOT"
    
    if [ ! -f "$TASK_ROOT/prompt.txt" ]; then
        echo "[Batch] Creating prompt.txt from database..."
        node -e "
            const Database = require('better-sqlite3');
            const fs = require('fs');
            const path = require('path');
            const dbPath = path.join('$TASKS_DIR', 'tasks.db');
            try {
                const db = new Database(dbPath, { readonly: true });
                const task = db.prepare('SELECT title, prompt FROM tasks WHERE task_id = ?').get('$TASK_ID');
                if (!task) {
                    console.error('Task not found in database');
                    process.exit(1);
                }
                fs.writeFileSync('$TASK_ROOT/prompt.txt', task.prompt || '');
                fs.writeFileSync('$TASK_ROOT/title.txt', task.title || '');
                console.log('Created prompt.txt and title.txt');
            } catch (e) {
                console.error('Error:', e.message);
                process.exit(1);
            }
        "
        if [ $? -ne 0 ]; then
            echo "[Batch] Failed to create prompt.txt"
            exit 1
        fi
    fi
    
    run_single_model "$TASK_ID" "$MODEL_NAME"
elif [ -n "$INPUT_ARG" ]; then
    # DB Mode: Input is Task ID (legacy - runs all pending models in parallel)
    TASK_ID="$INPUT_ARG"
    echo "[Batch] Fetching details for Task ID: $TASK_ID"
    
    EVAL_STR=$(node -e "
        const Database = require('better-sqlite3');
        const path = require('path');
        const dbPath = path.join('$TASKS_DIR', 'tasks.db');
        try {
            const db = new Database(dbPath, { readonly: true });
            const task = db.prepare('SELECT title, prompt, base_dir FROM tasks WHERE task_id = ?').get('$TASK_ID');
            // 只获取 pending 状态的模型，跳过已完成或正在运行的模型
            const runs = db.prepare('SELECT model_name FROM model_runs WHERE task_id = ? AND status = ?').all('$TASK_ID', 'pending');
            
            if (!task) {
                console.error('Task not found');
                process.exit(1);
            }
            
            if (runs.length === 0) {
                console.error('No pending models to run');
                process.exit(0);
            }
            
            const models = runs.map(r => r.model_name).join(',');
            
            // Safe string escaping for shell
            const safe = (str) => (!str ? '' : str.replace(/'/g, \`'\\\\''\`));
            
            console.log(\`export TITLE='\${safe(task.title)}'\`);
            console.log(\`export PROMPT='\${safe(task.prompt)}'\`);
            console.log(\`export BASE_DIR='\${safe(task.base_dir)}'\`);
            console.log(\`export MODELS_STR='\${safe(models)}'\`);
        } catch (e) {
            console.error(e.message);
            process.exit(1);
        }
    ")
    
    if [ $? -ne 0 ] || [ -z "$EVAL_STR" ]; then
        echo "Error fetching task details from DB"
        exit 1
    fi
    
    eval "$EVAL_STR"
    process_task "$BASE_DIR" "$TITLE" "$PROMPT" "$TASK_ID" "$MODELS_STR"
else
    echo "Error: No arguments provided"
    echo "Usage: $0 <task_id> [model_name]"
    echo "  - With only task_id: runs all pending models for the task"
    echo "  - With task_id and model_name: runs only the specified model"
    exit 1
fi

echo "执行完毕！"
