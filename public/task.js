const modelListEl = document.getElementById('model-list');
const logDisplayEl = document.getElementById('log-display');
const fileListEl = document.getElementById('file-list');
const previewModal = document.getElementById('preview-modal');
const previewFilename = document.getElementById('preview-filename');
const previewBody = document.getElementById('preview-body');

// ========== User Authentication ==========
// Check if user is logged in
const savedUserStr = localStorage.getItem('claude_user');
let currentUser = null;

console.log('[Auth] savedUserStr:', savedUserStr);

if (!savedUserStr) {
    // Not logged in, redirect to login page
    window.location.href = '/login.html';
} else {
    try {
        currentUser = JSON.parse(savedUserStr);
        console.log('[Auth] Parsed currentUser:', currentUser);
        if (!currentUser || !currentUser.id) {
            throw new Error('Invalid user data');
        }
    } catch (e) {
        console.error('[Auth] Parse error:', e);
        localStorage.removeItem('claude_user');
        window.location.href = '/login.html';
    }
}

// Logout function
window.logout = function() {
    localStorage.removeItem('claude_user');
    window.location.href = '/login.html';
};

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
let batchPrompts = []; // 批量任务的 prompts 数组

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
    // Display current user
    const usernameDisplay = document.getElementById('username-display');
    if (usernameDisplay && currentUser) {
        usernameDisplay.textContent = currentUser.username;
    }

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
    document.getElementById('csv-file-input').addEventListener('change', handleCsvUpload);
    document.getElementById('browse-csv-btn').addEventListener('click', triggerCsvBrowse);
    document.getElementById('clear-batch-btn').addEventListener('click', clearBatchTasks);
    
    // 监听 prompt 输入框变化，更新按钮样式
    document.getElementById('task-prompt').addEventListener('input', updateStartButtonStyle);

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

    // Setup Download Menu Action
    document.getElementById('download-task-menu-item').addEventListener('click', () => {
        if (activeMenuTaskId) {
            window.location.href = `/api/tasks/${activeMenuTaskId}/download`;
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
        // Pass userId to filter tasks by current user
        const res = await fetch(`/api/tasks?userId=${currentUser.id}`);
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
let incrementalSrcTaskId = null; // Track if we are branching from an existing task
let incrementalSrcModelName = null; // Track specific model subfolder

function openNewTaskModal() {
    // Standard open: Reset incremental state
    incrementalSrcTaskId = null;
    document.getElementById('browse-folder-btn').classList.remove('has-file');
    document.getElementById('browse-folder-btn').querySelector('.folder-name').textContent = '';
    selectedFolderPath = '';
    
    // 重置批量任务状态
    batchPrompts = [];
    document.getElementById('single-task-area').style.display = 'block';
    document.getElementById('batch-preview-area').style.display = 'none';
    
    // 显示上传按钮区域
    const uploadButtonsRow = document.querySelector('.upload-buttons-row');
    if (uploadButtonsRow) uploadButtonsRow.style.display = 'flex';
    
    // 确保 CSV 按钮也显示
    const csvBtn = document.getElementById('browse-csv-btn');
    if (csvBtn) csvBtn.style.display = 'flex';
    
    document.getElementById('csv-file-input').value = '';
    document.getElementById('browse-csv-btn').classList.remove('has-file');
    
    // 重置 prompt 并更新按钮样式
    document.getElementById('task-prompt').value = '';
    updateStartButtonStyle();

    document.getElementById('new-task-modal').classList.add('show');
}

function openIncrementalTaskModal() {
    if (!currentTaskId) return;

    // Incremental open: Set state
    incrementalSrcTaskId = currentTaskId;
    incrementalSrcModelName = activeFolder; // e.g. 'banana'
    selectedFolderPath = `INCREMENTAL_FROM_${currentTaskId}_${incrementalSrcModelName}`;

    // Update UI pre-fill
    const browseBtn = document.getElementById('browse-folder-btn');
    const csvBtn = document.getElementById('browse-csv-btn');
    browseBtn.classList.add('has-file');
    browseBtn.querySelector('.folder-name').textContent = `Base: ${incrementalSrcModelName || 'All'} (${currentTaskId})`;

    // 隐藏批量上传按钮
    if (csvBtn) csvBtn.style.display = 'none';

    // Clear prompt and update button style
    document.getElementById('task-prompt').value = '';
    updateStartButtonStyle();

    document.getElementById('new-task-modal').classList.add('show');
}

function closeNewTaskModal() {
    document.getElementById('new-task-modal').classList.remove('show');
}

function triggerFolderBrowse() {
    const browseBtn = document.getElementById('browse-folder-btn');
    if (selectedFolderPath && browseBtn.classList.contains('has-file')) {
        // 直接删除，不再确认
        selectedFolderPath = '';
        incrementalSrcTaskId = null; // Reset incremental state on clear
        incrementalSrcModelName = null;
        browseBtn.classList.remove('has-file');
        browseBtn.querySelector('.folder-name').textContent = '';
        document.getElementById('folder-input').value = '';
        
        // 恢复上传批量任务按钮显示
        const csvBtn = document.getElementById('browse-csv-btn');
        if (csvBtn) csvBtn.style.display = 'flex';
        
        return;
    }
    document.getElementById('folder-input').click();
}

async function handleFolderUpload(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const browseBtn = document.getElementById('browse-folder-btn');
    const csvBtn = document.getElementById('browse-csv-btn');
    const iconSpan = browseBtn.querySelector('.upload-folder-icon');

    const totalFiles = files.length;
    let totalSize = 0;
    for (let i = 0; i < files.length; i++) {
        totalSize += files[i].size;
    }
    const sizeInMB = (totalSize / (1024 * 1024)).toFixed(2);

    console.log(`[Upload] Starting folder upload: ${totalFiles} files, ${sizeInMB} MB`);

    try {
        browseBtn.disabled = true;
        browseBtn.classList.add('uploading');
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
        const circumference = 10 * 2 * Math.PI; // r=10 (updated)

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
            
            // 隐藏批量上传按钮
            if (csvBtn) csvBtn.style.display = 'none';
        } else {
            console.error(`[Upload] Upload failed according to data payload:`, data);
            alert('Upload failed: ' + (data.error || 'Unknown error'));
        }
    } catch (err) {
        console.error(`[Upload] Catch block caught an error:`, err);
        alert('Upload error: ' + err.message);
    } finally {
        browseBtn.disabled = false;
        browseBtn.classList.remove('uploading');
        if (!selectedFolderPath) iconSpan.textContent = '📁';
    }
}

// ========== CSV Batch Upload ==========
function triggerCsvBrowse() {
    document.getElementById('csv-file-input').click();
}

function handleCsvUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(event) {
        const content = event.target.result;
        // 按行分割，过滤空行
        const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        
        if (lines.length === 0) {
            alert('CSV 文件为空或格式不正确');
            return;
        }

        // 保存批量任务
        batchPrompts = lines;
        
        // 显示批量预览区域
        showBatchPreview();
    };
    reader.onerror = function() {
        alert('读取文件失败');
    };
    reader.readAsText(file);
}

function showBatchPreview() {
    // 隐藏单任务区域，显示批量预览区域
    document.getElementById('single-task-area').style.display = 'none';
    document.getElementById('batch-preview-area').style.display = 'block';
    
    // 隐藏上传按钮区域
    document.querySelector('.upload-buttons-row').style.display = 'none';
    
    // 更新任务数量
    document.getElementById('batch-task-count').textContent = `已加载 ${batchPrompts.length} 个任务`;
    
    // 渲染表格
    const tbody = document.getElementById('batch-preview-tbody');
    tbody.innerHTML = '';
    batchPrompts.forEach((prompt, index) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${index + 1}</td>
            <td title="${prompt.replace(/"/g, '&quot;')}">${prompt.length > 80 ? prompt.substring(0, 80) + '...' : prompt}</td>
        `;
        tbody.appendChild(tr);
    });
    
    // 更新按钮样式
    document.getElementById('browse-csv-btn').classList.add('has-file');
    updateStartButtonForBatch();
}

function clearBatchTasks() {
    batchPrompts = [];
    
    // 显示单任务区域，隐藏批量预览区域
    document.getElementById('single-task-area').style.display = 'block';
    document.getElementById('batch-preview-area').style.display = 'none';
    
    // 显示上传按钮区域
    document.querySelector('.upload-buttons-row').style.display = 'flex';
    
    // 重置 CSV 输入
    document.getElementById('csv-file-input').value = '';
    document.getElementById('browse-csv-btn').classList.remove('has-file');
    
    // 恢复按钮样式
    updateStartButtonStyle();
}

function updateStartButtonForBatch() {
    const btn = document.getElementById('add-task-btn');
    btn.classList.remove('btn-empty-prompt');
    btn.textContent = `启动 ${batchPrompts.length} 个任务`;
}

function getRandomPrompt() {
    const samplePrompts = [
        '生成一个可在浏览器运行的打砖块小游戏，包含关卡、分数、音效和重新开始按钮。',
        '生成一个 Minecraft 风格的 2D 沙盒小游戏，支持挖掘方块、放置方块和保存地图。',
        '生成一个网页版贪吃蛇游戏，支持难度选择和最高分记录到 LocalStorage。',
        '生成一个带登录注册的迷你博客网站（纯前端，假数据即可）。',
        '生成一个网页版五子棋小游戏，支持人机对战。'
    ];
    return samplePrompts[Math.floor(Math.random() * samplePrompts.length)];
}

function fillRandomPrompt() {
    document.getElementById('task-prompt').value = getRandomPrompt();
    updateStartButtonStyle();
}

function updateStartButtonStyle() {
    const prompt = document.getElementById('task-prompt').value.trim();
    const btn = document.getElementById('add-task-btn');
    if (prompt) {
        btn.classList.remove('btn-empty-prompt');
    } else {
        btn.classList.add('btn-empty-prompt');
    }
}

async function startNewTask() {
    const selectedModels = Array.from(document.querySelectorAll('input[name="model"]:checked')).map(cb => cb.value);
    if (selectedModels.length === 0) return alert('请至少选择一个模型');

    const btn = document.getElementById('add-task-btn');
    btn.disabled = true;
    
    // 批量任务模式
    if (batchPrompts.length > 0) {
        btn.textContent = `启动中 (0/${batchPrompts.length})...`;
        
        try {
            let successCount = 0;
            let firstTaskId = null;
            
            for (let i = 0; i < batchPrompts.length; i++) {
                const prompt = batchPrompts[i];
                const newTaskId = Math.random().toString(36).substring(2, 8).toUpperCase();
                
                if (i === 0) firstTaskId = newTaskId;
                
                const newTask = {
                    baseDir: selectedFolderPath,
                    title: 'Initializing...',
                    prompt,
                    taskId: newTaskId,
                    models: selectedModels,
                    srcTaskId: incrementalSrcTaskId,
                    srcModelName: incrementalSrcModelName,
                    userId: currentUser.id
                };

                const res = await fetch('/api/tasks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ task: newTask })
                });
                const data = await res.json();

                if (data.success) {
                    successCount++;
                    btn.textContent = `启动中 (${successCount}/${batchPrompts.length})...`;
                }
            }
            
            alert(`成功启动 ${successCount} 个任务`);
            closeNewTaskModal();
            clearBatchTasks();
            loadTasks(); // 刷新任务列表
            if (firstTaskId) {
                loadTask(firstTaskId);
            }
        } catch (e) {
            console.error('[BatchStart] Exception:', e);
            alert('批量启动任务失败: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = '启动任务';
        }
        return;
    }
    
    // 单任务模式
    let prompt = document.getElementById('task-prompt').value.trim();
    
    // 如果没有输入 prompt，自动选择一个随机 prompt
    if (!prompt) {
        prompt = getRandomPrompt();
        document.getElementById('task-prompt').value = prompt;
    }

    btn.textContent = '启动中...';

    try {
        const newTaskId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const newTask = {
            baseDir: selectedFolderPath,
            title: 'Initializing...',
            prompt,
            taskId: newTaskId,
            models: selectedModels,
            srcTaskId: incrementalSrcTaskId, // Send source task ID to server
            srcModelName: incrementalSrcModelName, // Send source model name
            userId: currentUser.id // Associate task with current user
        };

        console.log('[StartTask] Creating task with:', newTask);
        console.log('[StartTask] currentUser:', currentUser);

        const res = await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task: newTask })
        });
        const data = await res.json();

        console.log('[StartTask] Response:', data);

        if (data.success) {
            closeNewTaskModal();
            loadTask(newTaskId); // No reload, just SPA transition
        } else {
            alert('Failed to start task: ' + (data.error || 'Unknown error'));
        }
    } catch (e) {
        console.error('[StartTask] Exception:', e);
        console.error('[StartTask] Stack:', e.stack);
        alert('Error starting task: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '启动任务';
        updateStartButtonStyle();
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
    // Only show if at least one successful run is previewable
    const canCompare = currentRuns.some(r => r.previewable);

    if (canCompare) {
        const compareBtn = document.createElement('div');
        compareBtn.className = `compare-btn ${isCompareMode ? 'active' : ''}`;
        compareBtn.innerHTML = `<span>📊</span> 产物对比`;
        compareBtn.onclick = toggleCompareMode;
        modelListEl.appendChild(compareBtn);
    }

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

    // 状态翻译函数
    const translateStatus = (status) => {
        const map = {
            'pending': '等待',
            'running': '运行中',
            'completed': '完成',
            'stopped': '中止'
        };
        return map[status] || status;
    };

    currentRuns.forEach(run => {
        const stats = calculateRunStats(run);

        // Define Actions - 使用 data 属性代替 onclick，所有按钮都带 data-model
        let actionButtons = '';
        if (run.status === 'pending') {
            actionButtons = `<button class="btn-xs action-btn" data-action="start" data-model="${run.modelName}" style="background: #dcfce7; color: #166534; border:none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: 600;">启动</button>`;
        } else if (run.status === 'stopped') {
            // 中断状态：显示重启按钮
            actionButtons = `<button class="btn-xs action-btn" data-action="start" data-model="${run.modelName}" style="background: #dcfce7; color: #166534; border:none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: 600;">重启</button>`;
        } else if (run.status === 'running') {
            // 运行中：显示中止按钮
            actionButtons = `<button class="btn-xs action-btn" data-action="stop" data-model="${run.modelName}" style="background: #ffedd5; color: #9a3412; border:none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: 600;">中止</button>`;
        } else if (run.status === 'completed' && run.previewable) {
            actionButtons = `<button class="btn-xs action-btn" data-action="preview" data-model="${run.modelName}" style="background: #dbeafe; color: #1e40af; border:none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: 600;">预览</button>`;
        }

        const tr = document.createElement('tr');
        const isPending = run.status === 'pending';
        
        const formatVal = (val, fallback = '-') => {
            if (isPending) return '';
            if (val === null || val === undefined) return fallback;
            return val;
        };

        tr.innerHTML = `
            <td style="font-weight:600">${stats.modelName}</td>
            <td><span class="status-badge status-${stats.status}">${translateStatus(stats.status)}</span></td>
            <td>${formatVal(stats.duration)}</td>
            <td>${formatVal(stats.turns, '0')}</td>
            <td>${formatVal(stats.inputTokens)}</td>
            <td>${formatVal(stats.outputTokens)}</td>
            <td>${formatVal(stats.cacheReadTokens)}</td>
            <td>${actionButtons}</td>
            <td>${formatVal(stats.toolCounts.TodoWrite, '0')}</td>
            <td>${formatVal(stats.toolCounts.Read, '0')}</td>
            <td>${formatVal(stats.toolCounts.Write, '0')}</td>
            <td>${formatVal(stats.toolCounts.Bash, '0')}</td>
        `;
        tbody.appendChild(tr);
    });
}

// 事件委托：在表格上监听按钮点击
(function setupStatsTableEventDelegation() {
    // 等待 DOM 加载完成
    document.addEventListener('DOMContentLoaded', () => {
        const tbody = document.getElementById('stats-table-body');
        if (tbody) {
            tbody.addEventListener('click', (e) => {
                const btn = e.target.closest('.action-btn');
                if (!btn) return;
                
                e.preventDefault();
                e.stopPropagation();
                
                const action = btn.dataset.action;
                const model = btn.dataset.model;
                console.log('[StatsTable] Button clicked, action:', action, 'model:', model);
                
                if (action === 'preview') {
                    if (model) window.previewFromStats(model);
                } else if (action === 'start' || action === 'stop') {
                    window.controlTask(action, model);
                }
            });
            console.log('[StatsTable] Event delegation setup complete');
        }
    });
})();

// Control Handlers
window.controlTask = async function (action, modelName) {
    if (!currentTaskId) {
        console.log('[controlTask] No currentTaskId');
        return;
    }
    
    console.log(`[controlTask] Action: ${action}, TaskId: ${currentTaskId}, Model: ${modelName}`);

    try {
        const res = await fetch(`/api/tasks/${currentTaskId}/${action}`, { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelName })
        });
        const data = await res.json();
        console.log(`[controlTask] Response:`, data);
        if (data.error) {
            alert(data.error);
        } else {
            // Refresh
            fetchTaskDetails(currentTaskId);
        }
    } catch (e) {
        console.error(`[controlTask] Error:`, e);
        alert(`操作失败: ${e.message}`);
    }
};

window.previewFromStats = function (modelName) {
    // Exit stats mode
    isStatsMode = false;
    // Load specific model
    loadTask(activeTaskId, modelName);
};

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
    const packageJson = (run.generatedFiles || []).find(f => f === 'package.json');
    const hasPreview = htmlFile || packageJson;

    if (hasPreview) {
        iframe.style.display = 'block';
        emptyState.style.display = 'none';

        const runId = run.folderName;
        if (iframe.dataset.runId !== runId) {
            iframe.dataset.runId = runId;
            const parts = runId.split('/');
            // Use container (parent of iframe) for overlay
            loadPreview(parts[0], parts[1], iframe, iframe.parentElement);
        }
    } else {
        iframe.style.display = 'none';
        iframe.dataset.src = '';
        emptyState.style.display = 'flex';
        const statusMap = { 'pending': '等待中', 'running': '运行中', 'completed': '已完成', 'stopped': '已中止' };
        emptyState.innerHTML = `<p>暂无预览<br><span style="font-size:0.8em;color:#cbd5e1;">${statusMap[run.status] || run.status}</span></p>`;
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
        let statusSymbol = '⏳'; // pending
        if (run.status === 'running') statusSymbol = '🔄';
        else if (run.status === 'completed') statusSymbol = '✅';
        else if (run.status === 'stopped') statusSymbol = '⏹️';

        option.textContent = `${getModelDisplayName(run.modelName)
            } (${statusSymbol})`;
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

    // 1. Render Trajectory (Log)
    if (activeRun.runId) {
        logDisplayEl.classList.remove('markdown-view');

        const lastRenderedCount = parseInt(logDisplayEl.dataset.lineCount || '0', 10);
        const lastRenderedFolder = logDisplayEl.dataset.renderedFolder;

        if (lastRenderedFolder !== activeFolder) {
            logDisplayEl.dataset.lineCount = '0';
            logDisplayEl.innerHTML = '<div class="empty-state"><div class="loading-spinner"></div><p style="margin-top: 1rem;">Loading events...</p></div>';
            logDisplayEl.dataset.renderedFolder = activeFolder;
        }

        fetch(`/api/task_events/${activeRun.runId}`)
            .then(res => res.json())
            .then(data => {
                const events = data.events || [];
                const currentCount = events.length;

                if (currentCount > lastRenderedCount || lastRenderedFolder !== activeFolder) {
                    if (lastRenderedCount === 0 || lastRenderedFolder !== activeFolder) {
                        logDisplayEl.innerHTML = '';
                    }

                    const fragment = document.createDocumentFragment();
                    const startIndex = (lastRenderedFolder === activeFolder) ? lastRenderedCount : 0;

                    for (let i = startIndex; i < currentCount; i++) {
                        const event = events[i];
                        if (event.type === 'TXT') {
                            const div = document.createElement('div');
                            div.className = 'text-log-entry markdown-body';
                            try {
                                div.innerHTML = marked.parse(event.preview_text);
                            } catch (e) {
                                div.textContent = event.preview_text;
                            }
                            fragment.appendChild(div);
                        } else {
                            const details = document.createElement('details');
                            details.className = 'json-log-entry';
                            details.dataset.eventId = event.id;

                            const summary = document.createElement('summary');
                            summary.className = 'json-summary';
                            const safePreview = event.preview_text.length > 200 ? event.preview_text.slice(0, 200) + '...' : event.preview_text;

                            summary.innerHTML = `
        <span class="json-type-badge ${event.status_class || 'type-tool'}">${event.type}</span>
        <span class="json-preview-text" title="${escapeHtml(event.preview_text)}">${escapeHtml(safePreview)}</span>
    `;

                            const body = document.createElement('div');
                            body.className = 'json-body';
                            body.innerHTML = '<div class="loading-spinner" style="margin: 1rem;"></div>';

                            details.appendChild(summary);
                            details.appendChild(body);

                            details.ontoggle = () => {
                                if (details.open && !details.dataset.loaded) {
                                    fetch(`/api/log_event_content/${event.id}`)
                                        .then(r => r.json())
                                        .then(d => {
                                            body.innerHTML = '';
                                            const contents = d.contents || [d.content];
                                            contents.forEach((content, idx) => {
                                                if (contents.length > 1) {
                                                    const header = document.createElement('div');
                                                    header.className = 'json-block-header';
                                                    header.textContent = idx === 0 ? 'Tool Call' : `Tool Result`;
                                                    header.style.fontSize = '0.75rem';
                                                    header.style.fontWeight = 'bold';
                                                    header.style.opacity = '0.6';
                                                    header.style.marginTop = idx === 0 ? '0' : '1rem';
                                                    header.style.marginBottom = '0.25rem';
                                                    header.style.textTransform = 'uppercase';
                                                    body.appendChild(header);
                                                }
                                                const pre = document.createElement('pre');
                                                try {
                                                    const obj = JSON.parse(content);
                                                    pre.innerHTML = syntaxHighlight(obj);
                                                } catch (e) {
                                                    pre.textContent = content;
                                                }
                                                body.appendChild(pre);
                                            });
                                            details.dataset.loaded = 'true';
                                        });
                                }
                            };
                            fragment.appendChild(details);
                        }
                    }

                    logDisplayEl.appendChild(fragment);
                    logDisplayEl.dataset.lineCount = currentCount;
                    logDisplayEl.dataset.renderedFolder = activeFolder;

                    const isScrolled = logDisplayEl.scrollHeight - logDisplayEl.scrollTop <= logDisplayEl.clientHeight + 200;
                    if (isScrolled) logDisplayEl.scrollTop = logDisplayEl.scrollHeight;
                }
            })
            .catch(err => {
                console.error('Failed to fetch events:', err);
                logDisplayEl.innerHTML = `<div style="color:red;padding:2rem;">Failed to load events: ${err.message}</div>`;
            });
    } else {
        // Fallback for Legacy Tasks without runId (Markdown logs)
        if (activeRun.outputLog === undefined || activeRun.outputLog === null) {
            logDisplayEl.innerHTML = '<div style="padding:2rem;">Loading legacy logs...</div>';
            fetch(`/api/task_logs/${currentTaskId}/${activeRun.modelName}`)
                .then(res => res.json())
                .then(data => {
                    activeRun.outputLog = data.outputLog || '';
                    renderMainContent();
                });
            return;
        }

        const logText = (activeRun.outputLog || '')
            .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
            .replace(/}\s*{/g, '}\n{');

        if (!logText.trim()) {
            logDisplayEl.innerHTML = '<div class="empty-state"><p>Waiting for output...</p></div>';
        } else {
            const isScrolled = logDisplayEl.scrollHeight - logDisplayEl.scrollTop <= logDisplayEl.clientHeight + 100;
            try {
                logDisplayEl.innerHTML = marked.parse(logText);
                logDisplayEl.classList.add('markdown-view');
            } catch (e) {
                logDisplayEl.textContent = logText;
            }
            if (isScrolled) logDisplayEl.scrollTop = logDisplayEl.scrollHeight;
        }
    }

    // 2. Render Files
    const newFiles = activeRun.generatedFiles || [];
    // const htmlFile = newFiles.find(f => f.endsWith('.html'));
    // const packageJson = newFiles.find(f => f === 'package.json');
    // const hasPreview = htmlFile || packageJson;

    const previewTabBtn = document.querySelector('.tab[data-tab="preview"]');
    if (previewTabBtn) {
        if (activeRun.previewable) {
            previewTabBtn.style.display = 'block';
        } else {
            previewTabBtn.style.display = 'none';
            // If we were viewing preview, switch back to files
            if (activeTab === 'preview') switchTab('files');
        }
    }

    // 3. Update Preview Iframe if active
    if (activeTab === 'preview') { // Removed hasPreview check for debugging
        console.log(`[Debug] Checking Preview state for ${activeFolder}`);
        const iframe = document.getElementById('preview-iframe');
        const container = document.getElementById('tab-content-preview');

        // Always try to load preview to trigger UI updates even if no runId logic yet
        // Fallback runId
        // Use global currentTaskId because activeRun might not have it populated
        const runId = currentTaskId + '/' + activeRun.modelName;

        // Avoid reloading if we are already showing this run's preview
        if (iframe.getAttribute('data-run-id') !== runId) {
            console.log(`[Debug] Loading preview for ${runId}`);
            iframe.setAttribute('data-run-id', runId);
            loadPreview(currentTaskId, activeRun.modelName, iframe, container);
        } else {
            // Force UI update anyway
            console.log(`[Debug] Preview already loaded. Force UI check.`);
            // Manually ensure status bar is visible
            const sb = document.getElementById('preview-status-bar');
            if (sb) sb.style.display = 'flex';
        }
    }

    // 4. Update File Tree
    const newFilesHash = JSON.stringify(newFiles.sort());
    if (newFilesHash !== fileListEl.dataset.filesHash) {
        const scrollPos = document.getElementById('file-list-container')?.scrollTop || 0;
        fileListEl.dataset.filesHash = newFilesHash;
        fileListEl.innerHTML = '';
        if (newFiles.length === 0) {
            fileListEl.innerHTML = '<div class="empty-state" style="height:200px;"><p>No files generated</p></div>';
        } else {
            const tree = buildFileTree(newFiles);
            fileListEl.appendChild(renderFileTree(tree, activeRun.folderName));
        }
        const container = document.getElementById('file-list-container');
        if (container) container.scrollTop = scrollPos;
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

// --- Preview Logic ---
async function loadPreview(taskId, modelName, iframe, container) {
    if (!taskId || !modelName) return;

    // Remove existing overlay
    const existingOverlay = container.querySelector('.preview-loading-overlay');
    if (existingOverlay) existingOverlay.remove();

    // Status Bar Elements
    const statusBar = document.getElementById('preview-status-bar');
    const statusDot = document.getElementById('preview-status-dot');
    const statusText = document.getElementById('preview-status-text');
    const urlDisplay = document.getElementById('preview-url-display');
    const progressDiv = document.getElementById('preview-progress');

    if (statusBar) {
        statusBar.style.display = 'flex';
        statusDot.className = 'status-dot status-pending';
        statusText.textContent = 'Initializing...';
        urlDisplay.textContent = '-';
    }

    if (progressDiv) {
        progressDiv.style.display = 'block';
        progressDiv.innerHTML = '<div style="color:#aaa">Waiting for server...</div>';
    }

    // Create new overlay
    const overlay = document.createElement('div');
    overlay.className = 'preview-loading-overlay';
    // Fix lint: border-radius
    overlay.style.cssText = 'position:absolute; inset:0; background:white; display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:10; top:187px;'; // Adusted top: 37 + 150
    overlay.innerHTML = '<div class="loading-spinner"></div><p style="margin-top:1rem; color:#64748b; font-size:0.9rem">Starting environment...</p>';

    // Ensure container is relative
    if (getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
    }
    container.appendChild(overlay);

    let pollInterval;

    // Poller function
    const startPolling = () => {
        pollInterval = setInterval(async () => {
            try {
                const res = await fetch(`/api/preview/status/${taskId}/${modelName}`);
                if (res.ok) {
                    const info = await res.json();
                    if (info.logs && progressDiv) {
                        progressDiv.innerHTML = info.logs.map(l =>
                            `<div style="margin-bottom:4px"><span style="color:#999; margin-right:8px">[${new Date(l.ts).toLocaleTimeString()}]</span>${l.msg}</div>`
                        ).join('');
                        progressDiv.scrollTop = progressDiv.scrollHeight;
                    }
                    if (info.status === 'ready' && info.url) {
                        // Double check if main request handler might handle this too. 
                        // But polling is faster visually.
                        if (urlDisplay) urlDisplay.textContent = info.url;
                    }
                }
            } catch (e) {
                console.warn('Preview status poll failed', e);
            }
        }, 500);
    };

    startPolling();

    try {
        const res = await fetch('/api/preview/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId, modelName })
        });
        const data = await res.json();

        clearInterval(pollInterval);

        if (data.url) {
            const currentSrc = iframe.getAttribute('data-src');
            // Update Iframe
            if (currentSrc !== data.url) {
                iframe.src = data.url;
                iframe.setAttribute('data-src', data.url);
                iframe.style.display = 'block';
            }
            overlay.remove();
            if (progressDiv) progressDiv.style.display = 'none'; // Hide progress on success

            // Update Status Bar Success
            if (statusBar) {
                statusDot.className = 'status-dot status-completed';
                statusText.textContent = '预览运行中';
                urlDisplay.textContent = data.url;
            }

        } else {
            throw new Error(data.error || 'Unknown response');
        }
    } catch (e) {
        clearInterval(pollInterval);
        overlay.innerHTML = `<p style="color:#ef4444; padding:1rem; text-align:center">预览加载失败:<br>${e.message}</p>`;

        // Update Status Bar Error
        if (statusBar) {
            statusDot.className = 'status-dot status-failed';
            statusText.textContent = 'Connection Failed';
            urlDisplay.textContent = 'Error';
        }
    }
}

// Global Reload Helper
window.reloadPreview = function () {
    // Find active iframe and reload
    const iframe = document.getElementById('preview-iframe');
    const container = document.getElementById('tab-content-preview');
    // We used currentTaskId global + activeRun in previous context, but strictly we need params
    // Let's rely on data-run-id which is reliable
    const runId = iframe.getAttribute('data-run-id');
    if (runId) {
        const [taskId, modelName] = runId.split('/');
        loadPreview(taskId, modelName, iframe, container);
    }
};
