#!/bin/bash

# 批量调用 Claude Code 测试脚本
# 读取 prompt.txt 文件，每行格式: title;prompt
# 为每个 title 创建文件夹，并在文件夹中执行 Claude 命令

# 检查 prompt.txt 是否存在
PROMPT_FILE="./prompt.txt"
if [ ! -f "$PROMPT_FILE" ]; then
    echo "错误: 未找到 $PROMPT_FILE 文件"
    exit 1
fi

# 读取文件并处理每一行 (使用文件描述符 3 避免 stdin 冲突)
count=0
while IFS= read -r line <&3 || [[ -n "$line" ]]; do
    # 跳过空行
    if [[ -z "${line// }" ]]; then
        continue
    fi

    ((count++))

    # 分割标题和提示内容
    if [[ "$line" == *";"* ]]; then
        title=$(echo "$line" | cut -d';' -f1)
        prompt=$(echo "$line" | cut -d';' -f2-)
    else
        title=$(printf "task_%02d" "$count")
        prompt="$line"
    fi

    # 清理标题中的特殊字符，避免创建非法路径
    title=$(echo "$title" | sed 's/[^a-zA-Z0-9_-]/_/g')

    echo "========================================="
    echo "正在处理任务 $count: $title"
    echo "========================================="

    # 创建文件夹 (如果不存在)
    mkdir -p "$title"
    # 清空文件夹内容，确保每次都是全新开始
    # 注意：仅在此文件夹内清理，避免误删
    rm -rf "${title:?}"/*

    # 保存 prompt 到文件
    echo "$prompt" > "$title/prompt.txt"

    # 调用 Claude Code 并保存输出
    echo "正在调用 Claude Code 生成代码..."
    (
        cd "$title" || exit 1
        # 使用 </dev/null 确保 claude 不抢占循环的 stdin
        claude -p "$(cat prompt.txt)" \
          --allowedTools "Read(./),Read(./**),Edit(./),Edit(./**),Bash(*)" \
          --output-format text \
          < /dev/null \
          > output.txt 2>&1
    )
    
    if [ $? -eq 0 ]; then
        echo "结果已保存到 $title/output.txt 文件"
        echo "完成处理: $title"
    else
        echo "处理失败: $title (详情请查看 $title/output.txt)"
    fi
    echo ""
done 3< "$PROMPT_FILE"

echo "共处理了 $count 个任务。所有任务已完成！"
