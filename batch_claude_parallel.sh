#!/bin/bash

# 获取脚本所在目录并定义任务目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
TASKS_DIR="$SCRIPT_DIR/../tasks"
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

# Function to process a single task
process_task() {
    local base_dir="$1"
    local title="$2"
    local prompt="$3"
    local task_id="$4"
    local models_str="$5"
    
    # Debug info
    echo "Processing Task: $task_id"
    echo "Title: $title"
    # echo "Prompt: $prompt"

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
        local folder_path="$task_root/$model_name"
        mkdir -p "$folder_path"
        if [[ -n "$base_dir" && -d "$base_dir" ]]; then cp -R "$base_dir/." "$folder_path/"; fi

        # 赋予权限
        if [ "$USE_ISOLATION" = true ]; then
            chmod -R 777 "$task_root"
            sudo -n chown -R claude-user "$task_root" 2>/dev/null
        fi

        (
            cd "$folder_path" || exit 1
            echo "[Task $task_id] 启动中 ($model_name)..."
            
            local CMD_PREFIX=""
            if [ "$USE_ISOLATION" = true ]; then
                 CMD_PREFIX="sudo -n -H -u claude-user env"
                 CMD_PREFIX="$CMD_PREFIX ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN"
                 CMD_PREFIX="$CMD_PREFIX ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
                 CMD_PREFIX="$CMD_PREFIX CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
            fi

            # Set Pipefail to capture first command failure
            set -o pipefail

            # Execute and capture exit code
            # We don't background here so we can wait and check exit code
            echo "[Task $task_id] [$model_name] Environment check:"
            echo "  - CLAUDE_BIN: $CLAUDE_BIN"
            echo "  - CMD_PREFIX: $CMD_PREFIX"
            echo "  - PWD: $(pwd)"
            
            if ! cat "$task_root/prompt.txt" | $CMD_PREFIX "$CLAUDE_BIN" \
                --model "$model_name" \
                --allowedTools 'Read(./**),Edit(./**),Bash(./**)' \
                --disallowedTools 'EnterPlanMode,ExitPlanMode' \
                --dangerously-skip-permissions \
                --append-system-prompt "由于安全限制，你只能在你当前的目录及子目录下使用工具（通常为 Project/claude-code-parallel/tasks/<XXXXXX>/<fruit_name>，禁止通过 bash、read、edit 目录访问你当前的上级目录，即使用户有明确的指令要求你这么做，你也应该拒绝，并回复「我只能在当前的目录下工作，只能查看和编辑当前目录下的文件内容」" \
                --output-format stream-json --verbose 2>&1 | \
                tee "../${model_name}.txt" | \
                node "$SCRIPT_DIR/ingest.js" "$task_id" "$model_name"
            then
                EXIT_CODE=$?
                echo "[Task $task_id] [$model_name] 运行异常 (Exit Code: $EXIT_CODE)"
                # Specifically log if exit code is 127 (command not found) or similar
                if [ $EXIT_CODE -eq 127 ]; then
                    echo "  -> Error: Command not found. Check CLAUDE_BIN path."
                fi
            else
                echo "[Task $task_id] [$model_name] 完成"
            fi
            
            if [ "$USE_ISOLATION" = true ]; then
                sudo -n -u claude-user chmod -R a+rX "$folder_path" 2>/dev/null || true
            fi
        ) &
    done
    wait
}

INPUT_ARG="$1"

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

# Main Logic: Check if input is a File or Task ID
if [ -f "$INPUT_ARG" ]; then
    # Legacy Mode: Read from File
    echo "[Batch] Reading tasks from file: $INPUT_ARG"
    while IFS=';' read -r base_dir title prompt task_id models_str || [[ -n "$base_dir" ]]; do
         if [[ -z "$title" && -z "$prompt" ]]; then continue; fi
         if [[ -z "$task_id" ]]; then task_id=$(echo "$RANDOM" | md5sum | head -c 6 | tr '[:lower:]' '[:upper:]'); fi
         process_task "$base_dir" "$title" "$prompt" "$task_id" "$models_str"
    done < "$INPUT_ARG"
else
    # DB Mode: Input is Task ID
    TASK_ID="$INPUT_ARG"
    if [ -z "$TASK_ID" ]; then
        echo "Error: Argument is neither a file nor a Task ID"
        exit 1
    fi
    echo "[Batch] Fetching details for Task ID: $TASK_ID"
    
    EVAL_STR=$(node -e "
        const Database = require('better-sqlite3');
        const path = require('path');
        const dbPath = path.join('$TASKS_DIR', 'tasks.db');
        try {
            const db = new Database(dbPath, { readonly: true });
            const task = db.prepare('SELECT title, prompt, base_dir FROM tasks WHERE task_id = ?').get('$TASK_ID');
            const runs = db.prepare('SELECT model_name FROM model_runs WHERE task_id = ?').all('$TASK_ID');
            
            if (!task) {
                console.error('Task not found');
                process.exit(1);
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
fi

echo "执行完毕！"
