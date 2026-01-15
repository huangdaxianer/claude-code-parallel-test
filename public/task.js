const modelListEl = document.getElementById('model-list');
const logDisplayEl = document.getElementById('log-display');
const fileListEl = document.getElementById('file-list');
const previewModal = document.getElementById('preview-modal');
const previewFilename = document.getElementById('preview-filename');
const previewBody = document.getElementById('preview-body');

// State
let currentRuns = [];
// 我们使用 folderName 作为唯一标识符，因为它比索引更稳定
let activeFolder = null;
let lastTaskResult = null;
let isCompareMode = false;
let isStatsMode = false;

// 获取 Task ID
const urlParams = new URLSearchParams(window.location.search);
const taskId = urlParams.get('id');

// Utility to get human-readable model names
function getModelDisplayName(modelName) {
    return modelName;
}

if (!taskId) {
    alert('No Task ID provided');
    window.location.href = '/';
} else {
    init();
}

function init() {
    fetchTaskDetails();
    // 自动刷新
    setInterval(fetchTaskDetails, 3000);

    // Close modal on click outside
    previewModal.addEventListener('click', (e) => {
        if (e.target === previewModal) closePreview();
    });

    // ESC to close modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closePreview();
    });
}

async function fetchTaskDetails() {
    try {
        const res = await fetch(`/api/task_details/${taskId}`);
        const data = await res.json();

        if (!data.runs || data.runs.length === 0) {
            modelListEl.innerHTML = '<div style="padding:1rem; color:#94a3b8; font-size:0.9rem;">Waiting for task execution...</div>';
            return;
        }

        currentRuns = data.runs;

        // 如果没有选中的 activeFolder，默认选第一个
        if (!activeFolder && currentRuns.length > 0) {
            activeFolder = currentRuns[0].folderName;
        }

        // 确保 activeFolder 仍然存在于当前的 runs 中 (防止它被删除了?)
        const activeRunExists = currentRuns.find(r => r.folderName === activeFolder);
        if (!activeRunExists && currentRuns.length > 0) {
            activeFolder = currentRuns[0].folderName;
        }

        renderSidebar();
        if (isStatsMode) {
            renderStatisticsView();
        } else if (isCompareMode) {
            renderComparisonView();
        } else {
            renderMainContent();
        }

    } catch (err) {
        console.error('Failed to fetch details:', err);
    }
}

function renderSidebar() {
    modelListEl.innerHTML = '';

    // 1. Stats Button
    const statsBtn = document.createElement('div');
    statsBtn.className = `compare-btn ${isStatsMode ? 'active' : ''}`;
    statsBtn.style.marginRight = '0.5rem';
    statsBtn.style.backgroundColor = isStatsMode ? '#10b981' : '#ecfdf5';
    statsBtn.style.color = isStatsMode ? 'white' : '#059669';
    statsBtn.style.borderColor = isStatsMode ? '#10b981' : '#d1fae5';
    statsBtn.innerHTML = `<span>📈</span> 数据统计`;
    statsBtn.onclick = toggleStatsMode;
    modelListEl.appendChild(statsBtn);

    // 2. Compare Button
    const compareBtn = document.createElement('div');
    compareBtn.className = `compare-btn ${isCompareMode ? 'active' : ''}`;
    compareBtn.innerHTML = `<span>📊</span> 产物对比`;
    compareBtn.onclick = toggleCompareMode;
    modelListEl.appendChild(compareBtn);

    currentRuns.forEach(run => {
        const isSelected = !isCompareMode && !isStatsMode && run.folderName === activeFolder;

        const tab = document.createElement('div');
        tab.className = `model-tab ${isSelected ? 'active' : ''}`;
        tab.onclick = () => {
            isCompareMode = false;
            isStatsMode = false;
            activeFolder = run.folderName;
            renderSidebar();

            // UI Switch
            document.getElementById('comparison-view').classList.remove('active');
            document.getElementById('statistics-view').classList.remove('active');
            document.getElementById('main-content').classList.remove('hidden');

            renderMainContent();
        };

        let displayName = getModelDisplayName(run.modelName);

        tab.innerHTML = `
            <span class="status-dot status-${run.status || 'pending'}"></span>
            <span class="model-name-text">${displayName}</span>
        `;

        modelListEl.appendChild(tab);
    });
}

function toggleStatsMode() {
    isStatsMode = !isStatsMode;
    isCompareMode = false; // Mutually exclusive

    renderSidebar();

    const statsView = document.getElementById('statistics-view');
    const comparisonView = document.getElementById('comparison-view');
    const mainContent = document.getElementById('main-content');

    if (isStatsMode) {
        statsView.classList.add('active');
        comparisonView.classList.remove('active');
        mainContent.classList.add('hidden');
        renderStatisticsView();
    } else {
        statsView.classList.remove('active');
        mainContent.classList.remove('hidden');
        renderMainContent();
    }
}

function toggleCompareMode() {
    isCompareMode = !isCompareMode;
    isStatsMode = false; // Mutually exclusive

    renderSidebar();

    const statsView = document.getElementById('statistics-view');
    const comparisonView = document.getElementById('comparison-view');
    const mainContent = document.getElementById('main-content');

    if (isCompareMode) {
        comparisonView.classList.add('active');
        statsView.classList.remove('active');
        mainContent.classList.add('hidden');
        renderComparisonView();
    } else {
        comparisonView.classList.remove('active');
        mainContent.classList.remove('hidden');
        renderMainContent();
    }
}

function calculateRunStats(run) {
    const stats = {
        modelName: getModelDisplayName(run.modelName),
        status: run.status || 'pending',
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

    if (!run.outputLog) return stats;

    const lines = run.outputLog.split(/\r\n|\n|\r/);
    let startTime = null;
    let endTime = null;

    lines.forEach(line => {
        if (!line.trim()) return;
        try {
            if (!line.trim().startsWith('{')) return;
            const obj = JSON.parse(line);

            // 1. Duration calculation
            if (obj.type === 'result') {
                if (obj.duration_ms) {
                    stats.duration = (obj.duration_ms / 1000).toFixed(1);
                } else if (obj.duration) {
                    stats.duration = (obj.duration / 1000).toFixed(1);
                }

                // Parse Total Usage from Result
                if (obj.usage) {
                    stats.inputTokens = obj.usage.input_tokens || 0;
                    stats.outputTokens = obj.usage.output_tokens || 0;
                    stats.cacheReadTokens = obj.usage.cache_read_input_tokens || 0;
                } else if (obj.tokenUsage) {
                    stats.inputTokens = obj.tokenUsage.input || obj.tokenUsage.input_tokens || 0;
                    stats.outputTokens = obj.tokenUsage.output || obj.tokenUsage.output_tokens || 0;
                    stats.cacheReadTokens = obj.tokenUsage.cacheRead || obj.tokenUsage.cache_read_input_tokens || 0;
                }
            }

            // 2. Turns (User messages count)
            if (obj.type === 'user') {
                stats.turns++;
            }

            // 3. Fallback: Accumulate Tokens from message_stop if result usage is missing/zero
            // Only if we haven't found a final result usage yet (simplification: just overwrite if > 0)
            if (obj.type === 'message_stop' && obj.usage) {
                const inputs = (obj.usage.input_tokens || 0);
                const outputs = (obj.usage.output_tokens || 0);
                const cache = (obj.usage.cache_read_input_tokens || 0);

                // If the result object at end has 0, we might want to manually sum these up?
                // But logs show result usage is explicitly 0. Let's trust result first, but if result not found, use sum.
                // We'll store a running sum and use it if final stats are 0.
            }

            // 4. Tool Counts
            // Look for tool_use type
            if (obj.type === 'tool_use') {
                const name = obj.name;
                if (stats.toolCounts.hasOwnProperty(name)) {
                    stats.toolCounts[name]++;
                } else if (name === 'Edit') { // Count Edit as Write maybe? Or keep separate
                    // User requested specifically: TodoWrite, Read, Write, Bash
                    // If 'Edit' is used, maybe map to key?
                    // stats.toolCounts.Write++; // Optional mapping
                }
            }
            // Also check assistant message blocks for tool_use
            if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
                obj.message.content.forEach(block => {
                    if (block.type === 'tool_use') {
                        const name = block.name;
                        if (stats.toolCounts.hasOwnProperty(name)) {
                            stats.toolCounts[name]++;
                        }
                    }
                });
            }

        } catch (e) { }
    });

    return stats;
}

function renderStatisticsView() {
    const tbody = document.getElementById('stats-table-body');
    tbody.innerHTML = '';

    currentRuns.forEach(run => {
        const stats = calculateRunStats(run);

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="font-weight:600">${stats.modelName}</td>
            <td><span class="status-badge status-${stats.status}">${stats.status}</span></td>
            <td>${stats.duration || '-'}</td>
            <td>${stats.turns}</td>
            <td>${stats.inputTokens || '-'}</td>
            <td>${stats.outputTokens || '-'}</td>
            <td>${stats.cacheReadTokens || '-'}</td>
            <td>${stats.toolCounts.TodoWrite}</td>
            <td>${stats.toolCounts.Read}</td>
            <td>${stats.toolCounts.Write}</td>
            <td>${stats.toolCounts.Bash}</td>
        `;
        tbody.appendChild(tr);
    });
}

function renderComparisonView() {
    const comparisonView = document.getElementById('comparison-view');

    // 1. Get current folder list to handle additions/removals
    const currentFolders = currentRuns.map(r => r.folderName);
    const existingCards = Array.from(comparisonView.querySelectorAll('.comparison-card'));

    // 2. Remove cards that no longer exist
    existingCards.forEach(card => {
        if (!currentFolders.includes(card.dataset.folder)) {
            card.remove();
        }
    });

    // 3. Update or Add cards
    currentRuns.forEach(run => {
        let card = comparisonView.querySelector(`.comparison-card[data-folder="${run.folderName}"]`);
        const htmlFile = (run.generatedFiles || []).find(f => f.endsWith('.html'));
        const targetSrc = htmlFile ? `/artifacts/${run.folderName}/${htmlFile}` : null;

        if (!card) {
            // CREATE NEW CARD
            card = document.createElement('div');
            card.className = 'comparison-card';
            card.dataset.folder = run.folderName;

            const header = document.createElement('div');
            header.className = 'comparison-card-header';
            header.innerHTML = `
                <span>${getModelDisplayName(run.modelName)}</span>
                <span class="status-badge status-${run.status || 'pending'}">${run.status || 'pending'}</span>
            `;
            card.appendChild(header);

            if (targetSrc) {
                const iframe = document.createElement('iframe');
                iframe.className = 'comparison-iframe';
                iframe.src = targetSrc; // No timestamp initially
                iframe.dataset.src = targetSrc;
                card.appendChild(iframe);
            } else {
                const placeholder = document.createElement('div');
                placeholder.className = 'empty-state';
                placeholder.innerHTML = '<p>No HTML preview available</p>';
                card.appendChild(placeholder);
            }
            comparisonView.appendChild(card);
        } else {
            // UPDATE EXISTING CARD
            const badge = card.querySelector('.status-badge');
            if (badge) {
                badge.textContent = run.status || 'pending';
                badge.className = `status-badge status-${run.status || 'pending'}`;
            }

            const iframe = card.querySelector('iframe');
            if (iframe) {
                if (targetSrc && iframe.dataset.src !== targetSrc) {
                    iframe.src = targetSrc;
                    iframe.dataset.src = targetSrc;
                }
            } else if (targetSrc) {
                // Case where run didn't have HTML before but has it now
                const placeholder = card.querySelector('.empty-state');
                if (placeholder) placeholder.remove();

                const newIframe = document.createElement('iframe');
                newIframe.className = 'comparison-iframe';
                newIframe.src = targetSrc;
                newIframe.dataset.src = targetSrc;
                card.appendChild(newIframe);
            }
        }
    });
}

function renderMainContent() {
    const activeRun = currentRuns.find(r => r.folderName === activeFolder);
    if (!activeRun) return;

    // 1. Render Log
    let logText = activeRun.outputLog || '';

    // A. Strip ANSI Codes
    logText = logText.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

    // B. Split and Filter Noise
    // Split by CRLF, LF, or CR (to handle progress bar overwrites as separate lines)
    let lines = logText.split(/\r\n|\n|\r/);

    const noiseKeywords = [
        //    'Press Ctrl-D', '[?25l', '[?2026',
        //    'Tips for getting started', 'Welcome back', 'API Usage Billing',
        //    '? for shortcuts', 'esc to interrupt', 'Cost:',
        //    '─'.repeat(10) // Long separators
    ];

    let filteredLines = lines.filter(line => {
        // Check for ASCII banner borders
        if (line.match(/^[│╭╰]/)) return false;

        // Check for noise keywords
        for (const keyword of noiseKeywords) {
            if (line.includes(keyword)) return false;
        }

        // Remove empty prompts strictly ">  "
        if (line.trim() === '>') return false;

        return true;
    });

    // C. Deduplicate consecutive identical lines
    // Also remove excessive empty lines (more than 1 in a row)
    // C. Deduplicate consecutive identical lines
    // Also remove excessive empty lines (more than 1 in a row)
    let cleanLines = [];
    filteredLines.forEach((line, index) => {
        const trimmed = line.trim();

        // Filter out specific artifacts requested by user
        if (trimmed.includes('^D')) return;
        if (trimmed.includes('[?25h')) return;

        const prevLine = cleanLines.length > 0 ? cleanLines[cleanLines.length - 1] : null;

        // 1. Skip if identical to previous line (ignoring whitespace for comparison)
        if (prevLine && prevLine.trim() === trimmed) return;

        // 2. Skip excessive empty lines
        if (trimmed === '' && prevLine && prevLine.trim() === '') return;

        cleanLines.push(line);
    });

    let cleanLog = cleanLines.join('\n');

    // 如果日志为空，显示 Empty State
    if (!cleanLog.trim()) {
        logDisplayEl.innerHTML = '<div class="empty-state"><p>Waiting for output...</p></div>';
    } else {
        // Detect if content looks like JSON stream (starts with {)
        const isJsonLog = cleanLog.trim().startsWith('{');

        if (isJsonLog) {
            logDisplayEl.classList.remove('markdown-view');

            // Incremental Rendering Logic
            const lastRenderedCount = parseInt(logDisplayEl.dataset.lineCount || '0', 10);
            const lastRenderedFolder = logDisplayEl.dataset.renderedFolder;
            const currentLineCount = cleanLines.length;

            // CRITICAL: If the active folder changed, we MUST reset the incremental state 
            // otherwise we'll show lines from the previous model.
            if (lastRenderedFolder !== activeFolder) {
                logDisplayEl.dataset.lineCount = '0';
                logDisplayEl.innerHTML = '';
                logDisplayEl.dataset.renderedFolder = activeFolder;
                // Re-calculate lastRenderedCount after reset
                renderMainContent();
                return;
            }

            if (currentLineCount > lastRenderedCount) {
                // If it's a fresh render, clear first
                if (lastRenderedCount === 0) {
                    logDisplayEl.innerHTML = '';
                }

                // 1. Parse ALL lines to build the map (needed for correct merging)
                const allObjects = cleanLines.map(line => {
                    try { return JSON.parse(line); } catch (e) { return null; }
                });

                // 2. Build Tool Result Map
                const toolResultsMap = {};
                allObjects.forEach(obj => {
                    if (!obj) return;

                    // Case A: Standard tool_result type
                    if (obj.type === 'tool_result' && obj.tool_use_id) {
                        toolResultsMap[obj.tool_use_id] = obj;
                    }
                    // Case B: User message with tool_result content block (Anthropic API style)
                    else if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
                        obj.message.content.forEach(block => {
                            if (block.type === 'tool_result' && block.tool_use_id) {
                                toolResultsMap[block.tool_use_id] = {
                                    ...obj, // keep parent context if needed, or just the block
                                    // Flatten important fields for easy access
                                    tool_use_id: block.tool_use_id,
                                    is_error: block.is_error,
                                    content: block.content
                                };
                            }
                        });
                    }
                });

                const fragment = document.createDocumentFragment();

                // 3. Render ONLY the new lines
                for (let i = lastRenderedCount; i < currentLineCount; i++) {
                    const line = cleanLines[i];
                    const obj = allObjects[i]; // Use pre-parsed object

                    if (!obj) {
                        // Fallback for non-JSON lines
                        const div = document.createElement('div');
                        div.textContent = line;
                        div.style.padding = '0.5rem';
                        div.style.color = '#ef4444';
                        fragment.appendChild(div);
                        continue;
                    }

                    // SKIP RULES:
                    // 1. Hide system messages
                    if (obj.type === 'system') continue;

                    // 2. Hide standalone tool_result messages (because they are merged into their parent tool_use)
                    if (obj.type === 'tool_result' && obj.tool_use_id) continue;
                    // 3. Hide user messages that are purely tool results matches
                    if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
                        // Check if ALL blocks in this user message are tool_results that we have mapped
                        // Simplification: If it contains tool_result, we hide it from main stream 
                        // because we attach it to the tool_use.
                        const hasToolResult = obj.message.content.some(b => b.type === 'tool_result' && b.tool_use_id);
                        if (hasToolResult) continue;
                    }

                    // Determine Type and Preview based on content
                    let type = 'INFO';
                    let typeClass = '';
                    let previewText = '';
                    let isDirectText = false;
                    let directTextContent = '';

                    // Tool Use Merge State
                    let mergedResultObj = null;
                    let resultTypeClass = '';

                    // Fallback preview
                    previewText = JSON.stringify(obj).slice(0, 100);

                    // 1. Check for standard 'assistant' message structure with content array
                    if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content) && obj.message.content.length > 0) {
                        const firstContent = obj.message.content[0];

                        if (firstContent.type === 'text') {
                            // Filter out "(no content)" noise
                            const textVal = (firstContent.text || '').replace(/\s+$/, '');
                            if (textVal.trim() === '(no content)') continue;

                            type = 'TXT';
                            isDirectText = true;
                            // Trim trailing whitespace/newlines from the text
                            directTextContent = textVal;
                        } else if (firstContent.type === 'tool_use') {
                            const toolName = firstContent.name || 'tool';
                            type = toolName;
                            typeClass = 'type-tool';

                            // CHECK FOR MATCHING RESULT
                            if (firstContent.id && toolResultsMap[firstContent.id]) {
                                mergedResultObj = toolResultsMap[firstContent.id];
                                // Determine success/error color based on RESULT content
                                let resultContentStr = '';
                                if (Array.isArray(mergedResultObj.content)) {
                                    // Try to get text from first block if it's text/json
                                    resultContentStr = JSON.stringify(mergedResultObj.content);
                                    if (mergedResultObj.content[0] && mergedResultObj.content[0].text) resultContentStr = mergedResultObj.content[0].text;
                                } else {
                                    resultContentStr = String(mergedResultObj.content || '');
                                }

                                if (mergedResultObj.is_error === false) {
                                    resultTypeClass = 'type-success';
                                } else if (mergedResultObj.is_error === true) {
                                    resultTypeClass = 'type-error';
                                } else if (resultContentStr.toLowerCase().includes('successfully') || resultContentStr.includes("has been updated. Here's the result")) {
                                    resultTypeClass = 'type-success';
                                } else {
                                    // Default if matched but no clear status (e.g. gray) -> keep we assume success-ish or neutral?
                                    // User said: "if above rules not met, keep gray". 
                                    // For tool name itself, we usually use blue. 
                                    // Wait, user said: "change the tool name background color ... to green/red"
                                    // So we override typeClass.
                                }

                                if (resultTypeClass) {
                                    typeClass = resultTypeClass;
                                }
                            }

                            // Specific check for Bash/Write description per user request
                            if (toolName === 'Bash' && firstContent.input && firstContent.input.description) {
                                previewText = firstContent.input.description;
                            } else if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'Read') && firstContent.input && firstContent.input.file_path) {
                                // Just show the filename for file tools
                                previewText = firstContent.input.file_path.split('/').pop();
                            } else if (toolName === 'TodoWrite' && firstContent.input && Array.isArray(firstContent.input.todos)) {
                                const todos = firstContent.input.todos;
                                const idx = todos.findIndex(t => t.status === 'in_progress');
                                const allCompleted = todos.every(t => t.status === 'completed');
                                const allPending = todos.every(t => t.status === 'pending');

                                if (idx !== -1) {
                                    previewText = `(${idx + 1}/${todos.length}) ${todos[idx].content}`;
                                } else if (allCompleted) {
                                    previewText = 'completed';
                                } else if (allPending) {
                                    previewText = `Assigned: ${todos.length} todos`;
                                } else {
                                    previewText = firstContent.input ? JSON.stringify(firstContent.input) : '{}';
                                }
                            } else {
                                previewText = firstContent.input ? JSON.stringify(firstContent.input) : '{}';
                            }
                        }
                    }
                    // 2. [SKIPPED] User blocks are handled in skip rules or below if not tool_result
                    else if (obj.type === 'user') {
                        // If we are here, it's a user message that DOES NOT contain tool results (or we failed to filter it)
                        // It might be a regular user chat message
                        type = 'USER';
                        typeClass = 'type-content';
                        if (obj.message && Array.isArray(obj.message.content) && obj.message.content[0]) {
                            const first = obj.message.content[0];
                            previewText = first.content || first.text || JSON.stringify(first);
                        }
                    }
                    // 3. [SKIPPED] Standalone tool_result handled in skip rules

                    // 4. Handle Error specifically
                    else if (obj.type === 'error' || obj.error) {
                        type = 'ERROR';
                        typeClass = 'type-error';
                        previewText = (obj.error && obj.error.message) ? obj.error.message : JSON.stringify(obj);
                    }
                    // 5. Standalone Top-Level Tool Use (if any engines output this format directly)
                    else if (obj.type === 'tool_use') {
                        const toolName = obj.name || 'tool';
                        type = toolName;
                        typeClass = 'type-tool';

                        // CHECK FOR MATCHING RESULT (Top level id)
                        if (obj.id && toolResultsMap[obj.id]) {
                            mergedResultObj = toolResultsMap[obj.id];
                            let resultContentStr = '';
                            if (Array.isArray(mergedResultObj.content)) {
                                resultContentStr = JSON.stringify(mergedResultObj.content);
                                if (mergedResultObj.content[0] && mergedResultObj.content[0].text) resultContentStr = mergedResultObj.content[0].text;
                            } else {
                                resultContentStr = String(mergedResultObj.content || '');
                            }

                            if (mergedResultObj.is_error === false) {
                                resultTypeClass = 'type-success';
                            } else if (mergedResultObj.is_error === true) {
                                resultTypeClass = 'type-error';
                            } else if (resultContentStr.toLowerCase().includes('successfully') || resultContentStr.includes("has been updated. Here's the result")) {
                                resultTypeClass = 'type-success';
                            }

                            if (resultTypeClass) {
                                typeClass = resultTypeClass;
                            }
                        }

                        if (toolName === 'Bash' && obj.input && obj.input.description) {
                            previewText = obj.input.description;
                        } else if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'Read') && obj.input && obj.input.file_path) {
                            previewText = obj.input.file_path.split('/').pop();
                        } else if (toolName === 'TodoWrite' && obj.input && Array.isArray(obj.input.todos)) {
                            const todos = obj.input.todos;
                            const idx = todos.findIndex(t => t.status === 'in_progress');
                            const allCompleted = todos.every(t => t.status === 'completed');
                            const allPending = todos.every(t => t.status === 'pending');

                            if (idx !== -1) {
                                previewText = `(${idx + 1}/${todos.length}) ${todos[idx].content}`;
                            } else if (allCompleted) {
                                previewText = 'completed';
                            } else if (allPending) {
                                previewText = `Assigned: ${todos.length} todos`;
                            } else {
                                previewText = obj.input ? JSON.stringify(obj.input) : '{}';
                            }
                        } else {
                            previewText = obj.input ? JSON.stringify(obj.input) : '{}';
                        }
                    } else if (obj.type === 'result') {
                        // Store the result object but don't render it in the stream (hidden by default logic for merged results? 
                        // Wait, previous logic was: if (obj.type === 'tool_result' && obj.tool_use_id) continue;
                        // This is type 'result', which usually comes at the very end.
                        // We should capture it.
                        lastTaskResult = obj;
                        // If we want to hide it from the log stream as per user saying "click to show":
                        continue;
                    }
                    // 6. Other types fallback
                    else {
                        if (obj.type === 'message_start') { type = 'START'; previewText = 'Message Start'; }
                        else if (obj.type === 'message_stop') { type = 'STOP'; previewText = 'Message Stop'; }
                        else if (obj.type === 'content_block_delta') { type = 'STREAM'; previewText = 'Streaming...'; }
                        else if (obj.type) { type = obj.type.toUpperCase(); }
                    }

                    // Render DIRECT TEXT if applicable
                    if (isDirectText) {
                        const div = document.createElement('div');
                        div.className = 'text-log-entry';
                        try {
                            div.innerHTML = marked.parse(directTextContent);
                            div.classList.add('markdown-body');
                        } catch (e) {
                            div.textContent = directTextContent;
                        }
                        fragment.appendChild(div);
                    } else {
                        // Render JSON Collapsible for others
                        const details = document.createElement('details');
                        details.className = 'json-log-entry';

                        let shouldAutoExpand = (type === 'ERROR');
                        if (shouldAutoExpand) details.open = true;

                        // Summary
                        const summary = document.createElement('summary');
                        summary.className = 'json-summary';

                        // Truncate preview text
                        const safePreviewText = previewText.length > 150 ? previewText.slice(0, 150) + '...' : previewText;

                        summary.innerHTML = `
                            <span class="json-type-badge ${typeClass}">${type}</span>
                            <span class="json-preview-text" title="${escapeHtml(previewText)}">${escapeHtml(safePreviewText)}</span>
                        `;

                        // Body
                        const body = document.createElement('div');
                        body.className = 'json-body';

                        // 1. Original Tool Call Usage JSON
                        const preCall = document.createElement('pre');
                        let callHtml = syntaxHighlight(obj);
                        // Clean up brackets for assistant messages if needed (legacy logic preserved)
                        if (obj.type === 'assistant' && obj.message && obj.message.content) {
                            // Optional: strip outer brackets? keeping existing logic
                            let highlighted = syntaxHighlight(obj.message.content);
                            highlighted = highlighted.replace(/^\s*\[/, '').replace(/\]\s*$/, '');
                            callHtml = highlighted.trim();
                        }
                        preCall.innerHTML = callHtml;
                        body.appendChild(preCall);

                        // 2. Merged Result JSON (if exists)
                        if (mergedResultObj) {
                            const separator = document.createElement('div');
                            separator.style.borderTop = '1px dashed #e2e8f0';
                            separator.style.margin = '1rem 0';
                            separator.style.paddingTop = '0.5rem';
                            separator.style.color = '#94a3b8';
                            separator.style.fontSize = '0.75rem';
                            separator.textContent = 'TOOL RESULT:';
                            body.appendChild(separator);

                            const preResult = document.createElement('pre');
                            // Extract content if it's a wrapper object, or just show the whole thing
                            // Showing the relevant content makes sense
                            let resultToShow = mergedResultObj;
                            // If it was extracted from a user block, we might want to show just the content block
                            if (mergedResultObj.type === 'user') {
                                // It's likely the full user message object, let's try to isolate the tool_result block
                                // Actually in our map we stored the full block properties merged.
                                // Let's just show the clean object we constructed in the map + any other props?
                                // For simplicity, show the constructed object which has { tool_use_id, content, is_error }
                                resultToShow = {
                                    type: 'tool_result',
                                    tool_use_id: mergedResultObj.tool_use_id,
                                    is_error: mergedResultObj.is_error,
                                    content: mergedResultObj.content
                                };
                            }
                            preResult.innerHTML = syntaxHighlight(resultToShow);
                            body.appendChild(preResult);
                        }

                        details.appendChild(summary);
                        details.appendChild(body);

                        fragment.appendChild(details);
                    }
                }

                logDisplayEl.appendChild(fragment);
                logDisplayEl.dataset.lineCount = currentLineCount;

                // Auto scroll if near bottom
                const isScrolledToBottom = logDisplayEl.scrollHeight - logDisplayEl.scrollTop <= logDisplayEl.clientHeight + 100;
                if (isScrolledToBottom) {
                    logDisplayEl.scrollTop = logDisplayEl.scrollHeight;
                }
            }

            // If log was cleared or reset (shorter than before), force re-render
            if (currentLineCount < lastRenderedCount) {
                logDisplayEl.dataset.lineCount = '0';
                logDisplayEl.innerHTML = '';
                renderMainContent(); // Recurse once to render from scratch
            }

        } else {
            // Clean up dataset if switching back to text mode
            logDisplayEl.dataset.lineCount = '0';
            // Existing Markdown Logic
            if (logDisplayEl.getAttribute('data-raw') !== cleanLog) {
                const isScrolledToBottom = logDisplayEl.scrollHeight - logDisplayEl.scrollTop <= logDisplayEl.clientHeight + 50;

                // Render Markdown
                try {
                    logDisplayEl.innerHTML = marked.parse(cleanLog);
                    logDisplayEl.classList.add('markdown-view');
                } catch (e) {
                    logDisplayEl.innerText = cleanLog; // Fallback
                    logDisplayEl.classList.remove('markdown-view');
                }

                logDisplayEl.setAttribute('data-raw', cleanLog);

                if (isScrolledToBottom) {
                    logDisplayEl.scrollTop = logDisplayEl.scrollHeight;
                }
            }
        }
    }

    // 2. Render Files
    const newFiles = activeRun.generatedFiles || [];

    // Check for HTML files to enable Preview capability
    const htmlFile = newFiles.find(f => f.endsWith('.html'));
    const previewTabBtn = document.querySelector('.tab[data-tab="preview"]');
    if (previewTabBtn) {
        if (htmlFile) {
            previewTabBtn.style.display = 'block';
            // Optional: Auto-switch to preview if it's the first time we see an HTML file? 
            // Let's stick to user manual switch for now, or auto-switch if user hasn't clicked anything.
        } else {
            // Hide preview tab if no HTML
            previewTabBtn.style.display = 'none';
            if (activeTab === 'preview') switchTab('files');
        }
    }

    // Update Iframe if active and html exists
    if (activeTab === 'preview' && htmlFile) {
        const iframe = document.getElementById('preview-iframe');
        // Construct static path: /artifacts/{folderName}/{htmlFile}
        const targetSrc = `/artifacts/${activeRun.folderName}/${htmlFile}`;

        // Only update if src changed (ignoring timestamp) 
        const currentSrc = iframe.getAttribute('data-src');
        if (currentSrc !== targetSrc) {
            // Add timestamp to prevent caching issues
            iframe.src = targetSrc + `?t=${Date.now()}`;
            iframe.setAttribute('data-src', targetSrc);

            // Force resize after load to fix Three.js/Canvas sizing issues in iframe
            iframe.onload = () => {
                setTimeout(() => {
                    if (iframe.contentWindow) {
                        iframe.contentWindow.dispatchEvent(new Event('resize'));
                    }
                }, 100);
                setTimeout(() => {
                    if (iframe.contentWindow) {
                        iframe.contentWindow.dispatchEvent(new Event('resize'));
                    }
                }, 500);
            };
        }
    }

    // 状态保持：记录当前展开的文件夹
    // 简单的全量对比，如果列表内容变了再重绘 DOM
    const newFilesHash = JSON.stringify(newFiles.sort());
    const oldFilesHash = fileListEl.dataset.filesHash;

    if (newFilesHash !== oldFilesHash) {
        fileListEl.dataset.filesHash = newFilesHash;

        // 保存当前的滚动位置
        const scrollPos = document.getElementById('file-list-container').scrollTop;

        fileListEl.innerHTML = '';
        if (newFiles.length === 0) {
            fileListEl.innerHTML = `
                <div class="empty-state" style="height:200px;">
                    <span style="font-size:2rem; opacity:0.2;">📂</span>
                    <p style="margin-top:0.5rem; font-size:0.9rem;">No files generated yet</p>
                </div>`;
        } else {
            // Build Tree Structure
            const tree = buildFileTree(newFiles);
            // Render Tree
            fileListEl.appendChild(renderFileTree(tree, activeRun.folderName));
        }

        // 恢复滚动位置
        document.getElementById('file-list-container').scrollTop = scrollPos;
    }
}

// 全局变量维护展开状态
const expandedPaths = new Set();

// Helper: Build Tree Object from flat paths
function buildFileTree(paths) {
    const root = {};
    paths.forEach(pathStr => {
        const parts = pathStr.split('/');
        let current = root;
        let currentPath = '';
        parts.forEach((part, index) => {
            // Build the full path for this level
            currentPath = currentPath ? `${currentPath}/${part}` : part;

            if (!current[part]) {
                const isFile = index === parts.length - 1;
                current[part] = isFile ? null : {}; // null means file

                // Auto-expand all folders by adding them to expandedPaths
                if (!isFile) {
                    expandedPaths.add(currentPath);
                }
            }
            current = current[part];
        });
    });
    return root;
}

// Helper: Render Tree DOM
function renderFileTree(tree, rootFolder, pathPrefix = '') {
    const ul = document.createElement('ul');
    ul.className = 'file-tree';

    // Sort: Folders first, then files
    const keys = Object.keys(tree).sort((a, b) => {
        const aIsFolder = tree[a] !== null;
        const bIsFolder = tree[b] !== null;
        if (aIsFolder && !bIsFolder) return -1;
        if (!aIsFolder && bIsFolder) return 1;
        return a.localeCompare(b);
    });

    keys.forEach(key => {
        const isFolder = tree[key] !== null;
        const fullPath = pathPrefix ? `${pathPrefix}/${key}` : key;
        const li = document.createElement('li');

        if (isFolder) {
            li.className = 'file-tree-item';

            // Checks if currently expanded
            const isExpanded = expandedPaths.has(fullPath);

            // Header
            const header = document.createElement('div');
            header.className = 'file-tree-header';
            header.innerHTML = `
                <span class="arrow-icon ${isExpanded ? 'expanded' : ''}">▶</span>
                <span class="icon">📁</span>
                <span>${key}</span>
            `;

            // Children Container
            const childrenContainer = document.createElement('div');
            childrenContainer.className = `file-tree-children ${isExpanded ? 'expanded' : ''}`;

            // Recursively render children
            const subTree = renderFileTree(tree[key], rootFolder, fullPath);
            // Move items from temp ul to container
            Array.from(subTree.children).forEach(child => childrenContainer.appendChild(child));

            // Toggle Logic
            header.onclick = (e) => {
                e.stopPropagation();
                const arrow = header.querySelector('.arrow-icon');
                const wasExpanded = childrenContainer.classList.contains('expanded');

                if (wasExpanded) {
                    childrenContainer.classList.remove('expanded');
                    arrow.classList.remove('expanded');
                    expandedPaths.delete(fullPath);
                } else {
                    childrenContainer.classList.add('expanded');
                    arrow.classList.add('expanded');
                    expandedPaths.add(fullPath);
                }
            };

            li.appendChild(header);
            li.appendChild(childrenContainer);

        } else {
            // File
            li.className = 'file-tree-file';
            li.innerHTML = `
                <span class="icon" style="margin-left:18px;">📄</span>
                <span>${key}</span>
            `;
            li.onclick = (e) => {
                e.stopPropagation();
                openPreview(rootFolder, fullPath);
                // Highlight active
                document.querySelectorAll('.file-tree-file').forEach(el => el.classList.remove('active'));
                li.classList.add('active');
            };
        }
        ul.appendChild(li);
    });

    return ul;
}


let activeTab = 'files';
function switchTab(tabName) {
    activeTab = tabName;

    // Update headers
    document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tabName);
    });

    // Update content visibility
    document.getElementById('tab-content-files').classList.toggle('active', tabName === 'files');
    document.getElementById('tab-content-preview').classList.toggle('active', tabName === 'preview');

    // Trigger content update
    renderMainContent();
}

async function openPreview(folder, file) {
    // If it's an HTML file, maybe ask user if they want to view source or preview?
    // For now, modal is "View Source". The tab is "Preview Render".
    previewFilename.textContent = file;
    previewBody.textContent = 'Loading...';
    previewModal.classList.add('show');

    try {
        const res = await fetch(`/api/file_content?folder=${encodeURIComponent(folder)}&file=${encodeURIComponent(file)}`);
        const data = await res.json();

        if (data.error) {
            previewBody.textContent = 'Error: ' + data.error;
        } else {
            previewBody.textContent = data.content;
        }
    } catch (err) {
        previewBody.textContent = 'Failed to load file content';
    }
}


// ... (existing code for preview)

function closePreview() {
    previewModal.classList.remove('show');
}

// Resizer Logic
document.addEventListener('DOMContentLoaded', () => {
    const resizer = document.getElementById('resizer');
    const leftPanel = document.getElementById('panel-left');
    const mainContent = document.querySelector('.main-content');
    let isResizing = false;

    if (resizer && leftPanel && mainContent) {
        resizer.addEventListener('mousedown', function (e) {
            isResizing = true;
            resizer.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            e.preventDefault(); // Prevent text selection
        });

        document.addEventListener('mousemove', function (e) {
            if (!isResizing) return;

            const containerRect = mainContent.getBoundingClientRect();
            // Calculate pointer position relative to container
            let newLeftWidth = e.clientX - containerRect.left;

            // Limits
            if (newLeftWidth < 200) newLeftWidth = 200;
            if (newLeftWidth > containerRect.width - 200) newLeftWidth = containerRect.width - 200;

            // Convert to percentage for responsiveness
            const newWidthPercent = (newLeftWidth / containerRect.width) * 100;
            leftPanel.style.width = `${newWidthPercent}% `;

            // Disable iframe pointer events during drag to prevent iframe stealing mouse events
            const iframe = document.getElementById('preview-iframe');
            if (iframe) iframe.style.pointerEvents = 'none';
        });

        document.addEventListener('mouseup', function (e) {
            if (isResizing) {
                isResizing = false;
                resizer.classList.remove('dragging');
                document.body.style.cursor = 'default';
                // Re-enable iframe events
                const iframe = document.getElementById('preview-iframe');
                if (iframe) iframe.style.pointerEvents = 'auto';
            }
        });
    }
});

// Helper Functions
function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function syntaxHighlight(json) {
    if (typeof json !== 'string') {
        json = JSON.stringify(json, null, 2);
    }
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
        let cls = 'json-number';
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'json-key';
            } else {
                cls = 'json-string';
            }
        } else if (/true|false/.test(match)) {
            cls = 'json-boolean';
        } else if (/null/.test(match)) {
            cls = 'json-null';
        }
        return '<span class="' + cls + '">' + match + '</span>';
    });
}

function showTaskResult() {
    if (!lastTaskResult) {
        alert('No result available yet.');
        return;
    }
    previewFilename.textContent = 'Task Result';
    previewBody.innerHTML = syntaxHighlight(lastTaskResult);
    previewModal.classList.add('show');
}

function downloadFiles() {
    if (!activeFolder) {
        alert('No active folder selected.');
        return;
    }
    // Trigger download
    window.location.href = `/api/download_zip?folderName=${encodeURIComponent(activeFolder)}`;
}
