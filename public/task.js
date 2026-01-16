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
let isStatsMode = true;
let compareLeftRun = null;
let compareRightRun = null;
let activeMenuTaskId = null; // Track which task's menu is open

// 获取 Task ID
// 获取 Task ID (Initial)
const urlParams = new URLSearchParams(window.location.search);
let currentTaskId = urlParams.get('id');

// Global Interval ID for clearing
let refreshIntervalId = null;

// Utility to get human-readable model names
function getModelDisplayName(modelName) {
    return modelName;
}

// Initial Load
init();

function init() {
    // Initialize Sidebar History
    fetchTaskHistory();

    // Setup Sidebar Toggle
    // Setup Sidebar Toggle
    document.getElementById('sidebar-toggle').addEventListener('click', () => {
        document.getElementById('app-layout').classList.toggle('collapsed');
    });

    // Setup New Task Modal
    document.getElementById('new-task-btn').addEventListener('click', openNewTaskModal);
    document.getElementById('add-task-btn').addEventListener('click', startNewTask);
    document.getElementById('folder-input').addEventListener('change', handleFolderUpload);
    document.getElementById('browse-folder-btn').addEventListener('click', triggerFolderBrowse);
    document.getElementById('random-prompt-btn').addEventListener('click', fillRandomPrompt);

    // Initial Task Load
    if (currentTaskId) {
        loadTask(currentTaskId, false); // false = don't push state
    }

    // Close modal on click outside
    previewModal.addEventListener('click', (e) => {
        if (e.target === previewModal) closePreview();
    });

    // ESC to close modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closePreview();
            closeNewTaskModal();
        }
    });

    // Close dropdown menu on click outside
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('item-dropdown-menu');
        const isMenuBtn = e.target.closest('.item-menu-btn');
        if (!isMenuBtn) {
            menu.classList.remove('show');
            activeMenuTaskId = null;
        }
    });

    // Setup Delete Menu Action
    document.getElementById('delete-task-menu-item').addEventListener('click', () => {
        if (activeMenuTaskId) {
            deleteTask(activeMenuTaskId);
        }
    });

    // Handle Browser Back/Forward
    window.addEventListener('popstate', (event) => {
        const params = new URLSearchParams(window.location.search);
        const id = params.get('id');
        if (id) {
            loadTask(id, false);
        } else {
            currentTaskId = null;
            // Reset UI to empty state could go here
        }
    });
}

// Function to Switch Tasks without Reload
function loadTask(id, pushState = true) {
    if (pushState) {
        const newUrl = `?id=${id}`;
        window.history.pushState({ path: newUrl }, '', newUrl);
    }

    currentTaskId = id;

    // Reset State
    currentRuns = [];
    activeFolder = null;
    isCompareMode = false;
    isStatsMode = true; // Default back to Stats or stay? Usually reset is cleaner.

    // Clear Interval
    if (refreshIntervalId) clearInterval(refreshIntervalId);

    // UI Reset
    document.querySelector('.top-bar').style.display = 'flex';
    document.getElementById('model-list').innerHTML = '<div style="padding: 1rem;">Loading...</div>';
    document.getElementById('task-prompt-display').textContent = 'Loading...';
    document.getElementById('log-display').innerHTML = '';
    document.getElementById('stats-table-body').innerHTML = '';

    // Re-fetch
    fetchTaskDetails();
    fetchTaskHistory(); // To update active highlighting

    // Restart Interval
    refreshIntervalId = setInterval(fetchTaskDetails, 3000);
}


// Sidebar & History Logic
async function fetchTaskHistory() {
    try {
        const res = await fetch('/api/tasks');
        const tasks = await res.json();
        const listEl = document.getElementById('task-history-list');
        listEl.innerHTML = '';

        tasks.forEach(task => {
            const item = document.createElement('div');
            item.className = `history-item ${task.taskId === currentTaskId ? 'active' : ''}`;
            item.innerHTML = `
                <div style="flex:1; overflow:hidden;">
                    <div style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding-right: 20px;">${task.title || 'Untitled'}</div>
                    <div style="font-size:0.75rem; color:#94a3b8;">${task.taskId}</div>
                </div>
                <button class="item-menu-btn" data-task-id="${task.taskId}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="1"></circle>
                        <circle cx="12" cy="5" r="1"></circle>
                        <circle cx="12" cy="19" r="1"></circle>
                    </svg>
                </button>
            `;
            item.onclick = (e) => {
                if (e.target.closest('.item-menu-btn')) return; // Prevent navigation when clicking menu
                e.preventDefault();
                if (currentTaskId !== task.taskId) {
                    loadTask(task.taskId);
                }
            };

            // Setup Menu Trigger
            const menuBtn = item.querySelector('.item-menu-btn');
            menuBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();

                const menu = document.getElementById('item-dropdown-menu');
                const rect = menuBtn.getBoundingClientRect();

                // Toggle same menu
                if (activeMenuTaskId === task.taskId && menu.classList.contains('show')) {
                    menu.classList.remove('show');
                    activeMenuTaskId = null;
                    return;
                }

                activeMenuTaskId = task.taskId;

                // Position menu
                menu.style.top = `${rect.bottom + 5}px`;
                menu.style.left = `${rect.right - 120}px`;
                menu.classList.add('show');
            };

            listEl.appendChild(item);
        });

        // Auto-load first task if none is active
        if (!currentTaskId && tasks.length > 0) {
            loadTask(tasks[0].taskId, true);
        } else if (tasks.length === 0) {
            // If no tasks at all, hide top bar and show a simple empty message
            document.querySelector('.top-bar').style.display = 'none';
            document.getElementById('main-content-wrapper').innerHTML = `
                <div class="empty-state" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: #64748b;">
                    <p>No tasks found. Click "New Task" to start.</p>
                </div>
            `;
        }
    } catch (e) {
        console.error("Failed to fetch history:", e);
    }
}

async function deleteTask(taskId) {
    try {
        const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
        const data = await res.json();

        if (data.success) {
            // If deleting current task, go back to home
            if (taskId === currentTaskId) {
                window.history.pushState({}, '', window.location.pathname);
                location.reload(); // Simple reload to clear state
            } else {
                fetchTaskHistory(); // Just refresh list
            }
        } else {
            alert('删除失败: ' + (data.error || '未知错误'));
        }
    } catch (e) {
        console.error('Delete error:', e);
        alert('删除请求失败');
    }
}

// New Task Modal Logic
let selectedFolderPath = '';

function openNewTaskModal() {
    document.getElementById('new-task-modal').classList.add('show');
}

function closeNewTaskModal() {
    document.getElementById('new-task-modal').classList.remove('show');
}

function triggerFolderBrowse() {
    const browseBtn = document.getElementById('browse-folder-btn');
    if (selectedFolderPath && browseBtn.classList.contains('has-file')) {
        if (confirm('Clear selected folder?')) {
            selectedFolderPath = '';
            browseBtn.classList.remove('has-file');
            browseBtn.querySelector('.folder-name').textContent = '';
            document.getElementById('folder-input').value = '';
        }
        return;
    }
    document.getElementById('folder-input').click();
}

async function handleFolderUpload(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const browseBtn = document.getElementById('browse-folder-btn');
    const iconSpan = browseBtn.querySelector('.icon');

    const totalFiles = files.length;
    let totalSize = 0;
    for (let i = 0; i < files.length; i++) {
        totalSize += files[i].size;
    }
    const sizeInMB = (totalSize / (1024 * 1024)).toFixed(2);

    console.log(`[Upload] Starting folder upload: ${totalFiles} files, ${sizeInMB} MB`);

    try {
        browseBtn.disabled = true;
        iconSpan.textContent = '⏳';

        const formData = new FormData();
        const relativePath = files[0].webkitRelativePath;
        const folderName = relativePath.split('/')[0];

        formData.append('folderName', folderName);
        for (let i = 0; i < files.length; i++) {
            formData.append('files', files[i]);
            formData.append('filePaths', files[i].webkitRelativePath);
        }

        console.log(`[Upload] FormData prepared. Sending request to server...`);
        const startTime = Date.now();

        // Use XHR for progress tracking
        const xhr = new XMLHttpRequest();
        const progressRing = document.getElementById('upload-progress-ring');
        const circle = progressRing.querySelector('.progress-ring__circle');
        const circumference = 14 * 2 * Math.PI; // r=14

        progressRing.classList.add('show');
        circle.style.strokeDashoffset = circumference;

        const uploadPromise = new Promise((resolve, reject) => {
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    const percent = event.loaded / event.total;
                    const offset = circumference - (percent * circumference);
                    circle.style.strokeDashoffset = offset;
                }
            };

            xhr.onload = () => {
                const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                console.log(`[Upload] Server responded in ${duration}s. Status: ${xhr.status}`);
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        resolve(JSON.parse(xhr.responseText));
                    } catch (e) {
                        reject(new Error('Invalid JSON response from server'));
                    }
                } else {
                    reject(new Error(xhr.responseText || `Server returned ${xhr.status}`));
                }
            };

            xhr.onerror = () => reject(new Error('Network error during upload'));
            xhr.open('POST', '/api/upload');
            xhr.send(formData);
        });

        const data = await uploadPromise;

        if (data.path) {
            console.log(`[Upload] Upload successful! Target path: ${data.path}`);
            selectedFolderPath = data.path;
            browseBtn.classList.add('has-file');
            browseBtn.querySelector('.folder-name').textContent = folderName;
            iconSpan.textContent = '📁';
        } else {
            console.error(`[Upload] Upload failed according to data payload:`, data);
            alert('Upload failed: ' + (data.error || 'Unknown error'));
        }
    } catch (err) {
        console.error(`[Upload] Catch block caught an error:`, err);
        alert('Upload error: ' + err.message);
    } finally {
        browseBtn.disabled = false;
        document.getElementById('upload-progress-ring').classList.remove('show');
        if (!selectedFolderPath) iconSpan.textContent = '📁';
    }
}

function fillRandomPrompt() {
    const samplePrompts = [
        '生成一个可在浏览器运行的打砖块小游戏，包含关卡、分数、音效和重新开始按钮。',
        '生成一个 Minecraft 风格的 2D 沙盒小游戏，支持挖掘方块、放置方块和保存地图。',
        '生成一个网页版贪吃蛇游戏，支持难度选择和最高分记录到 LocalStorage。',
        '生成一个带登录注册的迷你博客网站（纯前端，假数据即可）。',
        '生成一个网页版五子棋小游戏，支持人机对战。'
    ];
    document.getElementById('task-prompt').value = samplePrompts[Math.floor(Math.random() * samplePrompts.length)];
}

async function startNewTask() {
    const prompt = document.getElementById('task-prompt').value.trim();
    if (!prompt) return alert('Please enter a prompt');

    const selectedModels = Array.from(document.querySelectorAll('input[name="model"]:checked')).map(cb => cb.value);
    if (selectedModels.length === 0) return alert('Select at least one model');

    const btn = document.getElementById('add-task-btn');
    btn.disabled = true;
    btn.textContent = 'Starting...';

    try {
        const newTaskId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const newTask = {
            baseDir: selectedFolderPath,
            title: 'Initializing...',
            prompt,
            taskId: newTaskId,
            models: selectedModels
        };

        const res = await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task: newTask })
        });
        const data = await res.json();

        if (data.success) {
            closeNewTaskModal();
            loadTask(newTaskId); // No reload, just SPA transition
        } else {
            alert('Failed to start task');
        }
    } catch (e) {
        console.error(e);
        alert('Error starting task');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Start Task';
    }
}

async function fetchTaskDetails() {
    try {
        const res = await fetch(`/api/task_details/${currentTaskId}`);
        const data = await res.json();

        if (!data.runs || data.runs.length === 0) {
            modelListEl.innerHTML = '<div style="padding:1rem; color:#94a3b8; font-size:0.9rem;">Waiting for task execution...</div>';
            return;
        }

        // Merge new data with existing logs to prevent overwriting full logs with nulls
        if (currentRuns.length > 0) {
            const oldRunsMap = new Map(currentRuns.map(r => [r.folderName, r]));
            currentRuns = data.runs.map(newRun => {
                const oldRun = oldRunsMap.get(newRun.folderName);
                // If we have a local log and the new one is null (slim response), keep the local one
                // UNLESS the status changed to running/completed, implying update needed?
                // Actually, simply keeping it is fine. If we need fresh, we fetch.
                if (oldRun && oldRun.outputLog && !newRun.outputLog) {
                    newRun.outputLog = oldRun.outputLog;
                }
                return newRun;
            });
        } else {
            currentRuns = data.runs;
        }

        // Only auto-select if NOT in stats mode and no active folder
        if (!isStatsMode && !activeFolder && currentRuns.length > 0) {
            activeFolder = currentRuns[0].folderName;
        }

        // Update Prompt Display
        const promptEl = document.getElementById('task-prompt-display');
        if (promptEl && data.prompt && promptEl.textContent !== data.prompt) {
            promptEl.textContent = data.prompt;
        }

        // 确保 activeFolder 仍然存在于当前的 runs 中 (防止它被删除了?)
        const activeRunExists = currentRuns.find(r => r.folderName === activeFolder);
        if (!activeRunExists && currentRuns.length > 0 && !isStatsMode) {
            activeFolder = currentRuns[0].folderName;
        }

        // Rename renderSidebar to renderModelList to avoid confusion with new sidebar
        renderModelList();
        if (currentTaskId) {
            // ... visibility logic ...
            const statsView = document.getElementById('statistics-view');
            const comparisonView = document.getElementById('comparison-view');
            const mainContent = document.getElementById('main-content');

            if (isStatsMode) {
                statsView.classList.add('active');
                comparisonView.classList.remove('active');
                mainContent.classList.add('hidden');
                renderStatisticsView();
            } else if (isCompareMode) {
                comparisonView.classList.add('active');
                statsView.classList.remove('active');
                mainContent.classList.add('hidden');
                renderComparisonView();
            } else {
                statsView.classList.remove('active');
                comparisonView.classList.remove('active');
                mainContent.classList.remove('hidden');
                renderMainContent();
            }
        }
    } catch (err) {
        console.error('Failed to fetch details:', err);
    }
}

function renderModelList() {
    modelListEl.innerHTML = '';


    // 1. Stats Button
    // 1. Stats Button
    const statsBtn = document.createElement('div');
    statsBtn.className = `stats-btn ${isStatsMode ? 'active' : ''}`;
    statsBtn.innerHTML = `<span>📈</span> 数据统计`;
    statsBtn.onclick = toggleStatsMode;
    modelListEl.appendChild(statsBtn);

    // 2. Compare Button
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

            // Re-render ONLY tabs immediately to show active state
            renderModelList();

            // UI Switch (Immediate)
            document.getElementById('comparison-view').classList.remove('active');
            document.getElementById('statistics-view').classList.remove('active');
            document.getElementById('main-content').classList.remove('hidden');

            // Show loading immediately
            logDisplayEl.innerHTML = '<div class="empty-state"><div class="loading-spinner"></div><p style="margin-top: 1rem; font-size: 0.9rem;">Loading logs...</p></div>';

            // Pre-set state to avoid double-clear/recursion in renderMainContent
            logDisplayEl.dataset.lineCount = '0';
            logDisplayEl.dataset.renderedFolder = activeFolder;

            // Defer potentially heavy log parsing/rendering
            setTimeout(() => {
                renderMainContent();
            }, 10);
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

    renderModelList();

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

    renderModelList();

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

    // Use backend pre-calculated stats if available
    if (run.stats) {
        return { ...stats, ...run.stats };
    }

    if (!run.outputLog) return stats;

    // Fix: Handle multiple JSON objects on the same line (e.g. "}{")
    const rawContent = run.outputLog || '';
    const formattedContent = rawContent.replace(/}\s*{/g, '}\n{');

    const lines = formattedContent.split(/\r\n|\n|\r/);
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
    console.log('[Debug] Rendering Stats View for runs:', currentRuns.length);

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

function renderComparisonView() { // Revised for Split View
    const runs = currentRuns || [];
    if (runs.length === 0) return;

    // 1. Initialize Defaults if needed
    if (!compareLeftRun && runs.length > 0) compareLeftRun = runs[0].folderName;
    if (!compareRightRun && runs.length > 0) compareRightRun = runs.length > 1 ? runs[1].folderName : runs[0].folderName;

    // 2. Update Both Sides
    updateComparisonSide('left');
    updateComparisonSide('right');
}

// Global function for onchange event
window.updateComparisonPanel = function (side) {
    const select = document.getElementById(`select-${side}`);
    if (side === 'left') compareLeftRun = select.value;
    else compareRightRun = select.value;
    renderComparisonView();
};

function updateComparisonSide(side) {
    const select = document.getElementById(`select-${side}`);
    const statusBadge = document.getElementById(`status-${side}`);
    const iframe = document.getElementById(`iframe-${side}`);
    const emptyState = document.getElementById(`empty-${side}`);

    // a. Sync Options (Preserve selection if list hasn't effectively changed)
    syncSelectOptions(select, currentRuns);

    // b. Enforce Selection from State
    const currentTarget = (side === 'left') ? compareLeftRun : compareRightRun;

    // Validate target exists
    if (currentTarget && currentRuns.find(r => r.folderName === currentTarget)) {
        select.value = currentTarget;
    } else {
        // Fallback
        if (currentRuns.length > 0) {
            const fallback = currentRuns[0].folderName;
            select.value = fallback;
            if (side === 'left') compareLeftRun = fallback;
            else compareRightRun = fallback;
        }
    }

    // c. Update Content
    const run = currentRuns.find(r => r.folderName === select.value);
    if (!run) return;

    // Status
    statusBadge.textContent = run.status;
    statusBadge.className = `status-badge status-${run.status || 'pending'}`;
    statusBadge.style.display = 'inline-block';

    // Iframe Logic
    const htmlFile = (run.generatedFiles || []).find(f => f.endsWith('.html'));

    if (htmlFile) {
        const targetSrc = `/artifacts/${run.folderName}/${htmlFile}`;
        // Only update src if changed to avoid reload flickering
        if (iframe.dataset.src !== targetSrc) {
            iframe.src = targetSrc;
            iframe.dataset.src = targetSrc;
        }
        iframe.style.display = 'block';
        emptyState.style.display = 'none';
    } else {
        iframe.style.display = 'none';
        iframe.dataset.src = '';
        emptyState.style.display = 'flex';
        emptyState.innerHTML = `<p>No HTML preview available<br><span style="font-size:0.8em;color:#cbd5e1;text-transform:uppercase">${run.status}</span></p>`;
    }
}

function syncSelectOptions(select, runs) {
    // Check if options need update
    const currentOptionValues = Array.from(select.options).map(o => o.value).join(',');
    const newOptionValues = runs.map(r => r.folderName).join(',');

    if (currentOptionValues === newOptionValues) return; // No change needed

    const savedValue = select.value;
    select.innerHTML = '';

    runs.forEach(run => {
        const option = document.createElement('option');
        option.value = run.folderName;
        // Display Model Name + Status
        let statusSymbol = '⏳';
        if (run.status === 'running') statusSymbol = '🔄';
        else if (run.status === 'completed') statusSymbol = '✅';

        option.textContent = `${getModelDisplayName(run.modelName)} (${statusSymbol})`;
        select.appendChild(option);
    });

    if (savedValue) {
        // Try to restore selection
        const exists = runs.find(r => r.folderName === savedValue);
        if (exists) select.value = savedValue;
    }
}

function renderMainContent() {
    if (!activeFolder) return;
    const activeRun = currentRuns.find(r => r.folderName === activeFolder);
    if (!activeRun) return;

    // Check if log is missing (lazy load)
    if (activeRun.outputLog === undefined || activeRun.outputLog === null) {
        logDisplayEl.innerHTML = '<div style="padding:2rem;">Loading logs...</div>';

        // Fetch specific log
        fetch(`/api/task_logs/${currentTaskId}/${activeRun.modelName}`)
            .then(res => res.json())
            .then(data => {
                activeRun.outputLog = data.outputLog || '';
                renderMainContent(); // Re-render with log
            })
            .catch(err => {
                logDisplayEl.innerHTML = `<div style="color:red;padding:2rem;">Failed to load logs: ${err.message}</div>`;
            });
        return;
    }

    const content = activeRun.outputLog || '';

    // 1. Render Log
    let logText = content;

    // A. Strip ANSI Codes
    logText = logText.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

    // Fix: Handle multiple JSON objects on the same line (e.g. "}{")
    logText = logText.replace(/}\s*{/g, '}\n{');

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

    console.log('[Debug] Log Processing:', {
        rawLength: activeRun.outputLog ? activeRun.outputLog.length : 0,
        cleanLinesLength: cleanLines.length,
        isJsonLogRaw: cleanLog.trim().startsWith('{')
    });

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
                const allObjects = cleanLines.map((line, idx) => {
                    if (!line.trim()) return null; // Skip empty lines
                    try {
                        return JSON.parse(line);
                    } catch (e) {
                        // Only log if it really looks like JSON (starts with {) but failed
                        if (line.trim().startsWith('{')) {
                            console.error(`[Error] JSON Parse failed at line ${idx}:`, line.substring(0, 100), e);
                        }
                        return null;
                    }
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
                            // Set Read tool to green by default as per user request
                            typeClass = (toolName === 'Read') ? 'type-success' : 'type-tool';

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
                        // Set Read tool to green by default as per user request
                        typeClass = (toolName === 'Read') ? 'type-success' : 'type-tool';

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



function downloadFiles() {
    if (!activeFolder) {
        alert('No active folder selected.');
        return;
    }
    // Trigger download
    window.location.href = `/api/download_zip?folderName=${encodeURIComponent(activeFolder)}`;
}

function copyPrompt() {
    const promptEl = document.getElementById('task-prompt-display');
    if (!promptEl) return;

    const text = promptEl.textContent;
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('copy-prompt-btn');
        const originalHtml = btn.innerHTML;
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#10b981"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
        setTimeout(() => {
            btn.innerHTML = originalHtml;
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy content: ', err);
    });
}
