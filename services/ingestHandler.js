/**
 * IngestHandler - 处理 Claude CLI 的 JSON 输出
 * 封装自 ingest.js 的核心逻辑，可被 executorService 直接调用
 */
const db = require('../db');

class IngestHandler {
    constructor(taskId, modelId) {
        this.taskId = taskId;
        this.modelId = modelId;
        this.lineNumber = 0;
        this.lastFlush = Date.now();
        this.finished = false;

        // 获取 run_id
        const run = db.prepare('SELECT id FROM model_runs WHERE task_id = ? AND model_id = ?').get(taskId, modelId);
        if (!run) {
            throw new Error(`Run not found for ${taskId} - ${modelId}`);
        }
        this.runId = run.id;

        // 检查当前状态
        const currentStatus = db.prepare('SELECT status FROM model_runs WHERE id = ?').get(this.runId);
        this.wasStoppedByUser = currentStatus && currentStatus.status === 'stopped';

        // 只有未手动停止时才更新为 running
        if (!this.wasStoppedByUser) {
            db.prepare('UPDATE model_runs SET status = ? WHERE id = ?').run('running', this.runId);
        }

        // 追踪最后一条 assistant 消息的末尾内容类型（text / tool_use / thought 等）
        this.lastAssistantEndType = null;

        // 统计数据
        this.stats = {
            status: 'running',
            stopReason: null,
            duration: 0,
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            toolCounts: {
                TodoWrite: 0,
                Read: 0,
                Write: 0,
                Bash: 0
            }
        };

        // 预编译 SQL
        this.updateStats = db.prepare(`
            UPDATE model_runs SET
                status = ?,
                stop_reason = COALESCE(?, stop_reason),
                duration = ?,
                turns = ?,
                input_tokens = ?,
                output_tokens = ?,
                cache_read_tokens = ?,
                count_todo_write = ?,
                count_read = ?,
                count_write = ?,
                count_bash = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);

        this.insertLog = db.prepare(`
            INSERT INTO log_entries (run_id, line_number, type, tool_name, tool_use_id, preview_text, status_class, content)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        this.updateLogStatus = db.prepare(`
            UPDATE log_entries SET status_class = ? WHERE run_id = ? AND tool_use_id = ?
        `);

        console.log(`[IngestHandler] Initialized for ${taskId}/${modelId} (runId: ${this.runId})`);
    }

    /**
     * 处理单行输入
     */
    processLine(line) {
        if (!line.trim() || this.finished) return;

        try {
            // 匹配 JSON 对象
            const jsonMatch = line.match(/\{.*\}/);
            if (!jsonMatch) {
                if (line.trim()) {
                    console.error(`[IngestHandler] Non-JSON: ${line.slice(0, 200)}`);
                }
                return;
            }

            const parts = jsonMatch[0].replace(/}\s*{/g, '}\n{').split('\n');

            parts.forEach(part => {
                if (!part.trim()) return;
                try {
                    const obj = JSON.parse(part);
                    this.lineNumber++;
                    this._processObject(obj, part);
                } catch (e) {
                    console.error(`[IngestHandler] Parse error: ${part.slice(0, 100)}`, e.message);
                }
            });

            // 节流刷新
            if (Date.now() - this.lastFlush > 500) {
                this.flush();
                this.lastFlush = Date.now();
            }
        } catch (e) {
            console.error(`[IngestHandler] Fatal error:`, e);
        }
    }

    /**
     * 处理解析后的 JSON 对象
     */
    _processObject(obj, rawPart) {
        // 1. 更新统计
        if (obj.type === 'result') {
            if (obj.is_error) {
                this.stats.status = 'stopped';
                this.stats.stopReason = 'is_error';
            } else {
                this.stats.status = 'completed';
            }

            // 异常完成检测：最后一轮是工具调用或无内容，说明请求实际失败了
            if (this.stats.status === 'completed' && this.lastAssistantEndType !== 'text') {
                console.warn(`[IngestHandler] Task ${this.modelId} ended with '${this.lastAssistantEndType}' instead of 'text', marking as stopped`);
                this.stats.status = 'stopped';
                this.stats.stopReason = 'abnormal_completion';
            }

            if (obj.duration_ms) this.stats.duration = (obj.duration_ms / 1000).toFixed(1);
            else if (obj.duration) this.stats.duration = (obj.duration / 1000).toFixed(1);
            if (obj.usage) {
                this.stats.inputTokens = obj.usage.input_tokens || 0;
                this.stats.outputTokens = obj.usage.output_tokens || 0;
                this.stats.cacheReadTokens = obj.usage.cache_read_input_tokens || 0;
            }
            console.log(`[IngestHandler] Received full result for ${this.modelId} (status: ${this.stats.status})`);
        }

        if (obj.type === 'user') this.stats.turns++;

        if (obj.type === 'tool_use') {
            const name = obj.name;
            if (this.stats.toolCounts.hasOwnProperty(name)) this.stats.toolCounts[name]++;
        }

        if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
            obj.message.content.forEach(block => {
                if (block.type === 'tool_use') {
                    const name = block.name;
                    if (this.stats.toolCounts.hasOwnProperty(name)) this.stats.toolCounts[name]++;
                }
            });
            // 记录最后一条 assistant 消息的末尾 content block 类型
            // 过滤掉 thought / redacted_thinking 类型，只关注实际输出（text / tool_use）
            const nonThoughtBlocks = obj.message.content.filter(b => b.type !== 'thought' && b.type !== 'redacted_thinking');
            if (nonThoughtBlocks.length > 0) {
                this.lastAssistantEndType = nonThoughtBlocks[nonThoughtBlocks.length - 1].type;
            } else if (obj.message.content.length === 0) {
                this.lastAssistantEndType = 'empty';
            }
        }

        // 2. 写入日志条目
        const entries = this._getLogEntries(obj, rawPart);
        entries.forEach(entry => {
            this.insertLog.run(
                this.runId,
                this.lineNumber,
                entry.skip ? 'HIDDEN_' + entry.type : entry.type,
                entry.toolName || null,
                entry.toolUseId || null,
                entry.previewText || '',
                entry.typeClass || (entry.skip ? 'type-tool' : 'type-content'),
                entry.content
            );
        });

        // 3. 如果收到 result，标记完成
        if (obj.type === 'result') {
            this.flush();
            this.finished = true;
            console.log(`[IngestHandler] Task finished with status: ${this.stats.status}`);
        }
    }

    /**
     * 获取日志条目
     */
    _getLogEntries(obj, rawPart) {
        const entries = [];

        // 1. Assistant Message
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
                    entries.push(this._processToolUse(block, JSON.stringify(block)));
                }
            });
        }
        // 2. Direct Tool Use
        else if (obj.type === 'tool_use') {
            entries.push(this._processToolUse(obj, rawPart));
        }
        // 3. User Message
        else if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
            obj.message.content.forEach(block => {
                if (block.type === 'tool_result' && block.tool_use_id) {
                    this._updateToolStatus(block);
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
            this._updateToolStatus(obj);
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
     * 处理工具调用
     */
    _processToolUse(toolObj, rawPart) {
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
     * 更新工具状态
     */
    _updateToolStatus(block) {
        let resultClass = block.is_error ? 'type-error' : 'type-success';

        // 某些工具强制绿色
        const targetTool = db.prepare('SELECT tool_name FROM log_entries WHERE run_id = ? AND tool_use_id = ?').get(this.runId, block.tool_use_id);
        if (targetTool && ['EnterPlanMode', 'ExitPlanMode', 'Read'].includes(targetTool.tool_name)) {
            resultClass = 'type-success';
        }

        // 额外检查成功
        if (resultClass !== 'type-success' && !block.is_error && block.content) {
            const contentStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            if (contentStr.toLowerCase().includes('successfully') || contentStr.includes("has been updated")) {
                resultClass = 'type-success';
            }
        }
        this.updateLogStatus.run(resultClass, this.runId, block.tool_use_id);
        return resultClass;
    }

    /**
     * 刷新统计到数据库
     */
    flush() {
        try {
            // 重新检查是否被手动停止
            const currentDb = db.prepare('SELECT status FROM model_runs WHERE id = ?').get(this.runId);
            const statusToWrite = (currentDb && currentDb.status === 'stopped') ? 'stopped' : this.stats.status;

            this.updateStats.run(
                statusToWrite,
                this.stats.stopReason,
                this.stats.duration,
                this.stats.turns,
                this.stats.inputTokens,
                this.stats.outputTokens,
                this.stats.cacheReadTokens,
                this.stats.toolCounts.TodoWrite,
                this.stats.toolCounts.Read,
                this.stats.toolCounts.Write,
                this.stats.toolCounts.Bash,
                this.runId
            );
        } catch (e) {
            console.error('[IngestHandler] Failed to flush stats:', e);
        }
    }

    /**
     * 完成处理
     */
    finish() {
        this.flush();
        this.finished = true;
    }

    /**
     * 是否已完成
     */
    isFinished() {
        return this.finished;
    }
}

module.exports = { IngestHandler };
