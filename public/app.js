let tasks = [];

const taskList = document.getElementById('task-list');
const taskCount = document.getElementById('task-count');
const addBtn = document.getElementById('add-task-btn');
const browseBtn = document.getElementById('browse-folder-btn');
const folderInput = document.getElementById('folder-input');


const promptInput = document.getElementById('task-prompt');
const toast = document.getElementById('toast');
const randomPromptBtn = document.getElementById('random-prompt-btn');

let selectedFolderPath = '';

// 示例 Prompt 列表
const samplePrompts = [
    '生成一个可在浏览器运行的打砖块小游戏，包含关卡、分数、音效和重新开始按钮。',
    '生成一个 Minecraft 风格的 2D 沙盒小游戏，支持挖掘方块、放置方块和保存地图。',
    '生成一个网页版贪吃蛇游戏，支持难度选择和最高分记录到 LocalStorage。',
    '生成一个带登录注册的迷你博客网站（纯前端，假数据即可）。',
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
    '生成一个网页版五子棋小游戏，支持人机对战。',
    '生成一个多房间聊天室前端（用假 WebSocket 模拟即可）。',
    '生成一个可拖拽组件搭建页面的迷你低代码编辑器。',
    '生成一个网页版塔防小游戏，包含怪物波次、升级塔和金币系统。',
    '生成一个可编辑保存的个人主页生成器网站。'
];

// 随机填充 Prompt
randomPromptBtn.addEventListener('click', () => {
    const randomIndex = Math.floor(Math.random() * samplePrompts.length);
    promptInput.value = samplePrompts[randomIndex];
    promptInput.focus();
});

// 初始化：获取任务列表
async function initialize() {
    await fetchTasks();
}

async function browseFolder() {
    // 如果已经有文件且用户正在点击，检查是否是想删除（配合 CSS hover 效果）
    if (selectedFolderPath && browseBtn.classList.contains('has-file')) {
        const confirmDelete = confirm('是否清除当前已上传的项目文件夹？');
        if (confirmDelete) {
            selectedFolderPath = '';
            browseBtn.classList.remove('has-file');
            browseBtn.querySelector('.icon').textContent = '📁';
            browseBtn.querySelector('.folder-name').textContent = '';
            folderInput.value = '';
            showToast('已清除上传记录');
            return;
        }
    }
    folderInput.click();
}

folderInput.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    try {
        browseBtn.disabled = true;
        const iconSpan = browseBtn.querySelector('.icon');
        const originalIcon = iconSpan.textContent;
        iconSpan.textContent = '⏳';

        const formData = new FormData();
        const firstFile = files[0];
        const relativePath = firstFile.webkitRelativePath;
        const folderName = relativePath.split('/')[0];

        formData.append('folderName', folderName);

        for (let i = 0; i < files.length; i++) {
            formData.append('files', files[i], files[i].webkitRelativePath);
        }

        const res = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });

        const data = await res.json();
        if (data.path) {
            selectedFolderPath = data.path;
            browseBtn.classList.add('has-file');
            browseBtn.querySelector('.folder-name').textContent = folderName;
            iconSpan.textContent = '✅';
            showToast('文件夹上传成功');
        } else {
            iconSpan.textContent = '❌';
            showToast('上传失败: ' + (data.error || '未知错误'));
            setTimeout(() => { iconSpan.textContent = '📁'; }, 2000);
        }
    } catch (err) {
        console.error(err);
        iconSpan.textContent = '❌';
        showToast(`上传出错: ${err.message}`);
        setTimeout(() => { iconSpan.textContent = '📁'; }, 2000);
    } finally {
        browseBtn.disabled = false;
        folderInput.value = '';
    }
});


function renderTasks() {
    taskList.innerHTML = '';
    taskCount.textContent = `${tasks.length} Tasks`;

    tasks.forEach((task, index) => {
        const card = document.createElement('div');
        card.className = 'task-card';
        // 添加点击跳转逻辑，但要排除删除按钮的点击
        card.onclick = (e) => {
            if (!e.target.closest('.delete-btn')) {
                window.location.href = `/task.html?id=${task.taskId}`;
            }
        };

        // Prevent delete button click from propagating (just in case)
        const deleteHandler = (e) => {
            e.stopPropagation();
            deleteTask(task.taskId);
        };

        // 格式化路径，只显示文件夹名称
        const displayBase = task.baseDir ? task.baseDir.split(/[/\\]/).pop() : '';

        card.innerHTML = `
            <button class="delete-btn" title="Delete Task">×</button>
            <div class="task-info">
                <span class="task-title">${task.title || '(No Title)'}</span>
                <span class="task-id">ID: ${task.taskId}</span>
            </div>
            <p class="task-prompt">${task.prompt}</p>
        `;



        // Add event listener to delete button
        card.querySelector('.delete-btn').addEventListener('click', deleteHandler);

        taskList.appendChild(card);
    });
}

async function fetchTasks() {
    try {
        const res = await fetch('/api/tasks');
        const data = await res.json();
        tasks = data;
        renderTasks();
    } catch (err) {
        showToast('Error fetching tasks');
        console.error(err);
    }
}

async function addTask() {
    const baseDir = selectedFolderPath;
    const prompt = promptInput.value.trim();
    const taskId = Math.random().toString(36).substring(2, 8).toUpperCase();

    // Get selected models
    const selectedModels = Array.from(document.querySelectorAll('input[name="model"]:checked')).map(cb => cb.value);

    if (!prompt) {
        showToast('请编写需求描述');
        return;
    }

    if (selectedModels.length === 0) {
        showToast('请至少选择一个执行模型');
        return;
    }

    addBtn.disabled = true;
    addBtn.textContent = '启动中...';

    const newTask = { baseDir, title: '正在生成描述...', prompt, taskId, models: selectedModels };
    tasks.unshift(newTask);
    renderTasks();

    try {
        // 请求后端创建任务并立即开始执行 (并行)
        const res = await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task: newTask })
        });
        const data = await res.json();

        if (data.success) {
            showToast('🚀 任务已进入后台并行执行');
            promptInput.value = '';
            selectedFolderPath = '';
            browseBtn.classList.remove('has-file');
            browseBtn.querySelector('.icon').textContent = '📁';
            browseBtn.querySelector('.folder-name').textContent = '';



        } else {
            showToast('任务启动失败');
            tasks.shift();
        }
        renderTasks();
    } catch (err) {
        showToast('网络请求失败');
        tasks.shift();
        renderTasks();
    } finally {
        addBtn.disabled = false;
        addBtn.textContent = '启动任务';
    }
}

async function deleteTask(taskId) {
    try {
        const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast('Task deleted successfully');
            // Remove from local array
            tasks = tasks.filter(t => t.taskId !== taskId);
            renderTasks();
        } else {
            showToast('Failed to delete task');
        }
    } catch (err) {
        console.error(err);
        showToast('Error deleting task');
    }
}

function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// 绑定事件
addBtn.addEventListener('click', addTask);
browseBtn.addEventListener('click', browseFolder);

// 快捷键支持 (Enter 提交)
promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) addTask();
});

// 初始化加载
initialize();
