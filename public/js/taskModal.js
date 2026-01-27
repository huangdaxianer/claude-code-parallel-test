/**
 * 新建任务模态框模块
 * New task modal logic including folder upload and CSV batch
 */
(function () {
    'use strict';

    window.App = window.App || {};
    App.modal = {};

    /**
     * 打开新建任务模态框
     */
    App.modal.openNewTaskModal = function () {
        App.state.incrementalSrcTaskId = null;
        document.getElementById('browse-folder-btn').classList.remove('has-file');
        document.getElementById('browse-folder-btn').querySelector('.folder-name').textContent = '';
        App.state.selectedFolderPath = '';

        App.state.batchPrompts = [];
        document.getElementById('single-task-area').style.display = 'block';
        document.getElementById('batch-preview-area').style.display = 'none';

        const uploadButtonsRow = document.querySelector('.upload-buttons-row');
        if (uploadButtonsRow) uploadButtonsRow.style.display = 'flex';

        const csvBtn = document.getElementById('browse-csv-btn');
        if (csvBtn) csvBtn.style.display = 'flex';

        document.getElementById('csv-file-input').value = '';
        document.getElementById('browse-csv-btn').classList.remove('has-file');

        document.getElementById('task-prompt').value = '';
        App.modal.updateStartButtonStyle();

        document.getElementById('new-task-modal').classList.add('show');
        App.modal.loadModels();
    };

    /**
     * 加载并渲染模型
     */
    App.modal.loadModels = async function () {
        const container = document.getElementById('model-checkboxes');
        if (!container) return; // Should allow this to be absent on task_manager page

        try {
            const models = await App.api.getEnabledModels();

            if (models.length === 0) {
                container.innerHTML = '<div style="color: #64748b; font-size: 0.9rem;">没有可用的模型</div>';
                return;
            }

            container.innerHTML = models.map(model => `
                <label class="checkbox-item" title="${escapeHtml(model.description || '')}">
                    <input type="checkbox" name="model" value="${escapeHtml(model.name)}" 
                           ${model.is_default_checked ? 'checked' : ''}>
                    <span class="checkmark"></span>
                    ${escapeHtml(model.name)}
                </label>
            `).join('');

        } catch (e) {
            console.error('Failed to load models:', e);
            container.innerHTML = '<div style="color: #dc2626; font-size: 0.9rem;">加载模型失败</div>';
        }
    };

    /**
     * 打开增量开发模态框
     */
    App.modal.openIncrementalTaskModal = function () {
        if (!App.state.currentTaskId) return;

        App.state.incrementalSrcTaskId = App.state.currentTaskId;
        App.state.incrementalSrcModelName = App.state.activeFolder;
        App.state.selectedFolderPath = `INCREMENTAL_FROM_${App.state.currentTaskId}_${App.state.incrementalSrcModelName}`;

        const browseBtn = document.getElementById('browse-folder-btn');
        const csvBtn = document.getElementById('browse-csv-btn');
        browseBtn.classList.add('has-file');
        browseBtn.querySelector('.folder-name').textContent = `Base: ${App.state.incrementalSrcModelName || 'All'} (${App.state.currentTaskId})`;

        if (csvBtn) csvBtn.style.display = 'none';

        document.getElementById('task-prompt').value = '';
        App.modal.updateStartButtonStyle();

        document.getElementById('new-task-modal').classList.add('show');
    };

    /**
     * 关闭新建任务模态框
     */
    App.modal.closeNewTaskModal = function () {
        document.getElementById('new-task-modal').classList.remove('show');
    };

    /**
     * 触发文件夹选择
     */
    App.modal.triggerFolderBrowse = function () {
        const browseBtn = document.getElementById('browse-folder-btn');
        if (App.state.selectedFolderPath && browseBtn.classList.contains('has-file')) {
            App.state.selectedFolderPath = '';
            App.state.incrementalSrcTaskId = null;
            App.state.incrementalSrcModelName = null;
            browseBtn.classList.remove('has-file');
            browseBtn.querySelector('.folder-name').textContent = '';
            document.getElementById('folder-input').value = '';

            const csvBtn = document.getElementById('browse-csv-btn');
            if (csvBtn) csvBtn.style.display = 'flex';
            return;
        }
        document.getElementById('folder-input').click();
    };

    /**
     * 处理文件夹上传
     */
    App.modal.handleFolderUpload = async function (e) {
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

            const xhr = new XMLHttpRequest();
            const progressRing = document.getElementById('upload-progress-ring');
            const circle = progressRing.querySelector('.progress-ring__circle');
            const circumference = 10 * 2 * Math.PI;

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
                xhr.open('POST', '/api/tasks/upload');
                xhr.send(formData);
            });

            const data = await uploadPromise;

            if (data.path) {
                console.log(`[Upload] Upload successful! Target path: ${data.path}`);
                App.state.selectedFolderPath = data.path;
                browseBtn.classList.add('has-file');
                browseBtn.querySelector('.folder-name').textContent = folderName;
                iconSpan.textContent = '📁';

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
            if (!App.state.selectedFolderPath) iconSpan.textContent = '📁';
        }
    };

    /**
     * 触发 CSV 文件选择
     */
    App.modal.triggerCsvBrowse = function () {
        document.getElementById('csv-file-input').click();
    };

    /**
     * 处理 CSV 上传
     */
    App.modal.handleCsvUpload = function (e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function (event) {
            const content = event.target.result;
            const lines = App.modal.parseCSV(content);

            if (lines.length === 0) {
                alert('CSV 文件为空或格式不正确');
                return;
            }

            App.state.batchPrompts = lines;
            App.modal.showBatchPreview();
        };
        reader.onerror = function () {
            alert('读取文件失败');
        };
        reader.readAsText(file);
    };

    /**
     * 解析 CSV 文件
     */
    App.modal.parseCSV = function (text) {
        if (!text) return [];

        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

        const results = [];
        let currentField = '';
        let insideQuotes = false;
        let row = [];

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const nextChar = text[i + 1];

            if (char === '"') {
                if (insideQuotes && nextChar === '"') {
                    currentField += '"';
                    i++;
                } else {
                    insideQuotes = !insideQuotes;
                }
            } else if (char === ',' && !insideQuotes) {
                row.push(currentField);
                currentField = '';
            } else if ((char === '\r' || char === '\n') && !insideQuotes) {
                if (char === '\r' && nextChar === '\n') i++;

                row.push(currentField);
                if (row.length > 0 && row[0]) {
                    const prompt = row[0].trim();
                    if (prompt) results.push(prompt);
                }

                row = [];
                currentField = '';
            } else {
                currentField += char;
            }
        }

        if (currentField || row.length > 0) {
            row.push(currentField);
            if (row.length > 0 && row[0]) {
                const prompt = row[0].trim();
                if (prompt) results.push(prompt);
            }
        }

        return results;
    };

    /**
     * 显示批量预览
     */
    App.modal.showBatchPreview = function () {
        document.getElementById('single-task-area').style.display = 'none';
        document.getElementById('batch-preview-area').style.display = 'block';
        document.querySelector('.upload-buttons-row').style.display = 'none';

        document.getElementById('batch-task-count').textContent = `已加载 ${App.state.batchPrompts.length} 个任务`;

        const tbody = document.getElementById('batch-preview-tbody');
        tbody.innerHTML = '';
        App.state.batchPrompts.forEach((prompt, index) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${index + 1}</td>
                <td title="${prompt.replace(/"/g, '&quot;')}">${prompt}</td>
            `;
            tbody.appendChild(tr);
        });

        document.getElementById('browse-csv-btn').classList.add('has-file');
        App.modal.updateStartButtonForBatch();
    };

    /**
     * 清除批量任务
     */
    App.modal.clearBatchTasks = function () {
        App.state.batchPrompts = [];

        document.getElementById('single-task-area').style.display = 'block';
        document.getElementById('batch-preview-area').style.display = 'none';
        document.querySelector('.upload-buttons-row').style.display = 'flex';

        document.getElementById('csv-file-input').value = '';
        document.getElementById('browse-csv-btn').classList.remove('has-file');

        App.modal.updateStartButtonStyle();
    };

    /**
     * 更新批量任务按钮
     */
    App.modal.updateStartButtonForBatch = function () {
        const btn = document.getElementById('add-task-btn');
        btn.classList.remove('btn-empty-prompt');
        btn.textContent = `启动 ${App.state.batchPrompts.length} 个任务`;
    };

    /**
     * 获取随机 prompt
     */
    App.modal.getRandomPrompt = function () {
        const samplePrompts = [
            '生成一个可在浏览器运行的打砖块小游戏，包含关卡、分数、音效和重新开始按钮。',
            '生成一个 Minecraft 风格的 2D 沙盒小游戏，支持挖掘方块、放置方块和保存地图。',
            '生成一个网页版贪吃蛇游戏，支持难度选择和最高分记录到 LocalStorage。',
            '生成一个带登录注册的迷你博客网站（纯前端，假数据即可）。',
            '生成一个网页版五子棋小游戏，支持人机对战。',
            '生成一个网页斗地主发牌模拟器，支持洗牌、发牌动画和剩余牌统计。',
            '生成一个带物理碰撞的 Flappy Bird 网页版小游戏。',
            '生成一个在线记账小网站，支持分类、统计图表、数据持久化。',
            '生成一个浏览器运行的 2048 小游戏，支持撤销和胜负判定。',
            '生成一个网页版扫雷游戏，支持自定义行列和雷数。',
            '生成一个简单的 RPG 网页游戏，包含角色属性、装备、战斗和升级。',
            '生成一个在线番茄钟 + 待办事项整合网站。',
            '生成一个可上传图片并自动裁剪生成头像的网站。',
            '生成一个网页版拼图游戏（15 Puzzle），支持步数统计和动画。',
            '生成一个迷你股票行情看板网站（用模拟数据即可）。',
            '生成一个带地图标注的旅行路线规划网页（假地图即可）。',
            '生成一个多房间聊天室前端（用假 WebSocket 模拟即可）。',
            '生成一个可拖拽组件搭建页面的迷你低代码编辑器。',
            '生成一个网页版塔防小游戏，包含怪物波次、升级塔和金币系统。',
            '生成一个可编辑保存的个人主页生成器网站。'
        ];
        return samplePrompts[Math.floor(Math.random() * samplePrompts.length)];
    };

    /**
     * 填充随机 prompt
     */
    App.modal.fillRandomPrompt = function () {
        document.getElementById('task-prompt').value = App.modal.getRandomPrompt();
        App.modal.updateStartButtonStyle();
    };

    /**
     * 更新启动按钮样式
     */
    App.modal.updateStartButtonStyle = function () {
        const prompt = document.getElementById('task-prompt').value.trim();
        const btn = document.getElementById('add-task-btn');
        if (prompt) {
            btn.classList.remove('btn-empty-prompt');
        } else {
            btn.classList.add('btn-empty-prompt');
        }
    };

    /**
     * 启动新任务
     */
    App.modal.startNewTask = async function () {
        const selectedModels = Array.from(document.querySelectorAll('input[name="model"]:checked')).map(cb => cb.value);
        if (selectedModels.length === 0) return alert('请至少选择一个模型');

        const btn = document.getElementById('add-task-btn');
        btn.disabled = true;

        // 批量任务模式
        if (App.state.batchPrompts.length > 0) {
            btn.textContent = `启动中 (0/${App.state.batchPrompts.length})...`;

            try {
                let successCount = 0;
                let firstTaskId = null;

                for (let i = 0; i < App.state.batchPrompts.length; i++) {
                    const prompt = App.state.batchPrompts[i];
                    const newTaskId = Math.random().toString(36).substring(2, 8).toUpperCase();

                    if (i === 0) firstTaskId = newTaskId;

                    const newTask = {
                        baseDir: App.state.selectedFolderPath,
                        title: 'Initializing...',
                        prompt,
                        taskId: newTaskId,
                        models: selectedModels,
                        srcTaskId: App.state.incrementalSrcTaskId,
                        srcModelName: App.state.incrementalSrcModelName,
                        userId: App.state.currentUser.id
                    };

                    const data = await App.api.createTask(newTask);

                    if (data.success) {
                        successCount++;
                        btn.textContent = `启动中 (${successCount}/${App.state.batchPrompts.length})...`;
                    }
                }

                alert(`成功启动 ${successCount} 个任务`);
                App.modal.closeNewTaskModal();
                App.modal.clearBatchTasks();
                App.fetchTaskHistory();
                if (firstTaskId) {
                    App.loadTask(firstTaskId);
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

        if (!prompt) {
            prompt = App.modal.getRandomPrompt();
            document.getElementById('task-prompt').value = prompt;
        }

        btn.textContent = '启动中...';

        try {
            const newTaskId = Math.random().toString(36).substring(2, 8).toUpperCase();
            const newTask = {
                baseDir: App.state.selectedFolderPath,
                title: 'Initializing...',
                prompt,
                taskId: newTaskId,
                models: selectedModels,
                srcTaskId: App.state.incrementalSrcTaskId,
                srcModelName: App.state.incrementalSrcModelName,
                userId: App.state.currentUser.id
            };

            console.log('[StartTask] Creating task with:', newTask);

            const data = await App.api.createTask(newTask);

            console.log('[StartTask] Response:', data);

            if (data.success) {
                App.modal.closeNewTaskModal();
                App.loadTask(newTaskId);
            } else {
                alert('Failed to start task: ' + (data.error || 'Unknown error'));
            }
        } catch (e) {
            console.error('[StartTask] Exception:', e);
            alert('Error starting task: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = '启动任务';
            App.modal.updateStartButtonStyle();
        }
    };

    // 全局快捷方式
    window.openIncrementalTaskModal = App.modal.openIncrementalTaskModal;
    window.closeNewTaskModal = App.modal.closeNewTaskModal;
    window.fillRandomPrompt = App.modal.fillRandomPrompt;

})();
