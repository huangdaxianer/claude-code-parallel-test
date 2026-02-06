/**
 * 配置模块
 * 管理服务器配置、目录路径等常量
 */
const fs = require('fs');
const path = require('path');

// 目录常量
const TASKS_DIR = path.join(__dirname, '../tasks');
const UPLOAD_DIR = path.join(TASKS_DIR, 'temp_uploads');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// 默认配置
const defaultConfig = {
    maxParallelSubtasks: 5,  // 最大并行子任务数
    allowNewRegistration: true  // 是否允许新用户自动注册
};

// 确保目录存在
[TASKS_DIR, UPLOAD_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// 加载配置
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[Config] Error loading config:', e);
    }
    return { ...defaultConfig };
}

// 保存配置
function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('[Config] Error saving config:', e);
    }
}

// 标题生成 API 配置
const TITLE_GEN_API = process.env.TITLE_GEN_API || "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
const TITLE_GEN_MODEL = process.env.TITLE_GEN_MODEL || "doubao-seed-1-6-flash-250828";
const TITLE_GEN_KEY = process.env.TITLE_GEN_KEY || "";

// 预览服务配置
const PUBLIC_HOST = process.env.PUBLIC_HOST || 'localhost';
const PREVIEW_PORT_START = parseInt(process.env.PREVIEW_PORT_START || '4000', 10);
const PREVIEW_PORT_END = parseInt(process.env.PREVIEW_PORT_END || '10000', 10);

// 应用配置实例
let appConfig = loadConfig();

module.exports = {
    TASKS_DIR,
    UPLOAD_DIR,
    CONFIG_FILE,
    TITLE_GEN_API,
    TITLE_GEN_MODEL,
    TITLE_GEN_KEY,
    PUBLIC_HOST,
    PREVIEW_PORT_START,
    PREVIEW_PORT_END,
    loadConfig,
    saveConfig,
    getAppConfig: () => appConfig,
    setAppConfig: (newConfig) => { appConfig = newConfig; },
    updateAppConfig: (updates) => {
        appConfig = { ...appConfig, ...updates };
        return appConfig;
    }
};
