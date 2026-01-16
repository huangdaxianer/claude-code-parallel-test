#!/bin/bash

# 批量调用 Claude Code 并行版测试脚本
PROMPT_FILE="${1:-./prompt.txt}"
if [ ! -f "$PROMPT_FILE" ]; then
    echo "错误: 未找到 $PROMPT_FILE 文件"
    exit 1
fi

# 获取脚本所在目录并定义任务目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
TASKS_DIR="$SCRIPT_DIR/tasks"
mkdir -p "$TASKS_DIR"


# 检查隔离用户
if ! id "claude-user" >/dev/null 2>&1; then
    echo "错误: 隔离用户 claude-user 未就绪"
    exit 1
fi

# 修正临时目录权限，避免不同用户冲突
sudo -n mkdir -p /tmp/claude
sudo -n chmod 777 /tmp/claude

# 动态获取 claude 路径和 claude-user 家目录
CLAUDE_BIN=$(which claude)
if [ -z "$CLAUDE_BIN" ]; then
    echo "错误: 未找到 claude 可执行文件"
    exit 1
fi

CLAUDE_USER_HOME=$(eval echo "~claude-user")
if [ ! -d "$CLAUDE_USER_HOME" ]; then
   # Fallback if eval fails or dir doesn't exist (e.g. freshly created)
   if [[ "$OSTYPE" == "darwin"* ]]; then
       CLAUDE_USER_HOME="/Users/claude-user"
   else
       CLAUDE_USER_HOME="/home/claude-user"
   fi
fi

# 在脚本启动时同步登录状态 (仅同步配置目录，避免递归 chown 整个家目录)
if [ -d "$HOME/.claude" ]; then
    sudo -n mkdir -p "$CLAUDE_USER_HOME/.claude"
    sudo -n cp -R "$HOME/.claude/." "$CLAUDE_USER_HOME/.claude/"
    sudo -n chown -R claude-user "$CLAUDE_USER_HOME/.claude"
fi

task_count=0
while IFS=';' read -r base_dir title prompt task_id models_str <&3 || [[ -n "$base_dir" ]]; do
    if [[ -n "$models_str" ]]; then
        OLD_IFS=$IFS; IFS=',' read -r -a MODELS <<< "$models_str"; IFS=$OLD_IFS
    else
        MODELS=("potato" "tomato" "strawberry" "watermelon" "banana" "avocado" "cherry" "pineapple")
    fi

    if [[ -z "$title" && -z "$prompt" ]]; then continue; fi
    ((task_count++))
    if [[ -z "$task_id" ]]; then task_id=$(echo "$RANDOM" | md5sum | head -c 6 | tr '[:lower:]' '[:upper:]'); fi
    
    task_root="$TASKS_DIR/${task_id}"
    mkdir -p "$task_root"
    echo "$title" > "$task_root/title.txt"

    echo "$prompt" > "$task_root/prompt.txt"
    
    for model_name in "${MODELS[@]}"; do
        folder_path="$task_root/$model_name"
        mkdir -p "$folder_path"
        if [[ -n "$base_dir" && -d "$base_dir" ]]; then cp -R "$base_dir/." "$folder_path/"; fi

        # 赋予最大权限确保隔离用户可读写
        chmod -R 777 "$task_root"
        sudo -n chown -R claude-user "$task_root" 2>/dev/null

        (
            cd "$folder_path" || exit 1
            echo "[Task $task_count] 启动中..."
            
            # 使用简化的 sudo 命令，直接运行 claude 而不通过 bash -c
            # 这样可以减少 visudo 的配置项 (只需 claude 二进制本身)
            # 同时使用 -H 确保 Home 目录正确映射到 claude-user
            # 同时输出到文本日志和数据库抓取脚本
            if ! nohup sudo -n -H -u claude-user "$CLAUDE_BIN" -p "$prompt" \
                --model "$model_name" \
                --allowedTools 'Read(./**),Edit(./**),Bash(*)' \
                --disallowedTools 'EnterPlanMode,ExitPlanMode' \
                --dangerously-skip-permissions \
                --output-format stream-json --verbose 2>&1 | \
                tee "../${model_name}.txt" | \
                node "$SCRIPT_DIR/ingest.js" "$task_id" "$model_name" &
            then
                echo "[错误] sudo 权限拒绝。请检查 visudo 配置。" > "../${model_name}.txt"
                exit 1
            fi
            
            wait $!
            # 任务完成后恢复权限，使用 sudo -u claude-user 确保有权限修改
            # 使用 a+rX 确保所有用户（包括同组用户）都能读取
            sudo -n -u claude-user chmod -R a+rX "$folder_path" 2>/dev/null || true
        ) &
    done
done 3< "$PROMPT_FILE"
wait
echo "执行完毕！"
