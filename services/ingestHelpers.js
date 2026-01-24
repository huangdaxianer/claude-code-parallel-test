/**
 * Ingest 辅助函数模块
 * 从 ingest.js 提取的纯函数，便于测试
 */

/**
 * 处理工具调用块
 */
function processToolUse(toolObj, rawPart) {
    const toolName = toolObj.name || 'tool';
    const toolUseId = toolObj.id;
    let typeClass = (['Read', 'EnterPlanMode', 'ExitPlanMode'].includes(toolName)) ? 'type-success' : 'type-tool';
    let previewText = '';
    const input = toolObj.input || {};
    let finalToolName = toolName;

    if (toolName === 'Task') {
        finalToolName = 'SUBAGENT';
        previewText = input.description || input.prompt || '';
    } else if (toolName === 'TaskOutput') {
        finalToolName = 'SUBAGENT_RESULT';
        previewText = input.content || '';
    } else if (toolName === 'Bash' && input.command) {
        previewText = input.command;
    } else if (['Write', 'Edit', 'Read'].includes(toolName) && input.file_path) {
        previewText = input.file_path.split('/').pop();
    } else if (toolName === 'ExitPlanMode' && input.plan) {
        previewText = input.plan;
    } else if (toolName === 'AskUserQuestion') {
        if (input.question) previewText = input.question;
        else if (Array.isArray(input.questions) && input.questions[0]) previewText = input.questions[0].question || JSON.stringify(input);
        else previewText = JSON.stringify(input);
    } else if (toolName === 'TodoWrite' && Array.isArray(input.todos)) {
        const todos = input.todos;
        const idx = todos.findIndex(t => t.status === 'in_progress');
        if (idx !== -1) previewText = `(${idx + 1}/${todos.length}) ${todos[idx].content}`;
        else if (todos.every(t => t.status === 'completed')) previewText = 'completed';
        else previewText = `Assigned: ${todos.length} todos`;
    } else {
        previewText = JSON.stringify(input);
    }

    return {
        type: finalToolName,
        toolName: toolName,
        toolUseId: toolUseId,
        typeClass: typeClass,
        previewText: previewText,
        content: rawPart
    };
}

/**
 * 解析日志条目
 */
function getLogEntries(obj, rawPart, processToolUseFn = processToolUse) {
    const entries = [];

    // 1. Assistant Message Handling
    if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
        obj.message.content.forEach(block => {
            if (block.type === 'text' && block.text && block.text.trim() && block.text.trim() !== '(no content)') {
                entries.push({
                    type: 'TXT',
                    typeClass: 'type-content',
                    previewText: block.text.trim(),
                    content: JSON.stringify(block)
                });
            } else if (block.type === 'thought' && block.thought && block.thought.trim()) {
                entries.push({
                    type: 'TXT',
                    typeClass: 'type-content',
                    previewText: `*Thought: ${block.thought.trim().slice(0, 500)}${block.thought.length > 500 ? '...' : ''}*`,
                    content: JSON.stringify(block)
                });
            } else if (block.type === 'tool_use') {
                entries.push(processToolUseFn(block, JSON.stringify(block)));
            }
        });
    }
    // 2. Direct Tool Use
    else if (obj.type === 'tool_use') {
        entries.push(processToolUseFn(obj, rawPart));
    }
    // 3. User Message Handling
    else if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
        obj.message.content.forEach(block => {
            if (block.type === 'tool_result' && block.tool_use_id) {
                entries.push({
                    type: 'tool_result',
                    toolUseId: block.tool_use_id,
                    skip: true,
                    content: JSON.stringify(block)
                });
            } else if (block.type === 'text' || (block.content && block.type !== 'tool_result')) {
                const text = block.text || (typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
                entries.push({
                    type: 'USER',
                    typeClass: 'type-content',
                    previewText: text,
                    content: JSON.stringify(block)
                });
            }
        });
    }
    // 4. Standalone Tool Result
    else if (obj.type === 'tool_result') {
        entries.push({
            type: 'tool_result',
            toolUseId: obj.tool_use_id,
            skip: true,
            content: rawPart
        });
    }
    // 5. Errors
    else if (obj.type === 'error' || obj.error) {
        entries.push({
            type: 'ERROR',
            typeClass: 'type-error',
            previewText: (obj.error && obj.error.message) ? obj.error.message : JSON.stringify(obj),
            content: rawPart
        });
    }
    // 6. Generic assistant fallback
    else if (obj.type === 'assistant' && typeof obj.message === 'string' && obj.message.trim()) {
        entries.push({
            type: 'TXT',
            typeClass: 'type-content',
            previewText: obj.message.trim(),
            content: rawPart
        });
    }

    return entries;
}

/**
 * 解析统计信息
 */
function parseStats(obj, currentStats) {
    const stats = { ...currentStats };

    if (obj.type === 'result') {
        if (obj.is_error) {
            stats.status = 'stopped';
        } else {
            stats.status = 'completed';
        }
        if (obj.duration_ms) stats.duration = (obj.duration_ms / 1000).toFixed(1);
        else if (obj.duration) stats.duration = (obj.duration / 1000).toFixed(1);
        if (obj.usage) {
            stats.inputTokens = obj.usage.input_tokens || 0;
            stats.outputTokens = obj.usage.output_tokens || 0;
            stats.cacheReadTokens = obj.usage.cache_read_input_tokens || 0;
        }
    }

    if (obj.type === 'user') stats.turns++;

    if (obj.type === 'tool_use') {
        const name = obj.name;
        if (stats.toolCounts && stats.toolCounts.hasOwnProperty(name)) stats.toolCounts[name]++;
    }

    if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
        obj.message.content.forEach(block => {
            if (block.type === 'tool_use') {
                const name = block.name;
                if (stats.toolCounts && stats.toolCounts.hasOwnProperty(name)) stats.toolCounts[name]++;
            }
        });
    }

    return stats;
}

module.exports = {
    processToolUse,
    getLogEntries,
    parseStats
};
