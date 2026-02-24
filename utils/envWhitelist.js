/**
 * 子进程环境变量白名单工具
 *
 * 解决安全问题：防止 Claude CLI 子进程（及其执行的用户代码）
 * 通过 os.getenv() 等方式读取到服务器密码、API Key 等敏感信息。
 *
 * 策略：
 * 1. 只传递 Claude CLI 运行必需的环境变量（白名单）
 * 2. API 认证通过内部代理完成，子进程拿不到真实 token
 */

/**
 * 允许传给子进程的环境变量白名单
 * 这些都是系统运行所需的非敏感变量
 */
const ENV_WHITELIST = [
    // 系统基础
    'PATH', 'HOME', 'USER', 'SHELL', 'TERM',
    // 语言/编码
    'LANG', 'LC_ALL', 'LC_CTYPE',
    // 临时目录
    'TMPDIR', 'TEMP', 'TMP',
    // Node.js
    'NODE_PATH', 'NODE_ENV',
    // 网络代理（沙箱/企业内网环境需要通过代理访问外部网络）
    'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
    'NO_PROXY', 'no_proxy',
    'GLOBAL_AGENT_HTTP_PROXY', 'GLOBAL_AGENT_HTTPS_PROXY', 'GLOBAL_AGENT_NO_PROXY',
    // Claude CLI 模型默认值（非敏感，只是模型名称）
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
];

/** 主 Express 服务端口（代理路由在同一进程内） */
const PROXY_PORT = 3001;

/**
 * 构建安全的子进程环境变量
 * API 认证通过内部代理路由完成，子进程只拿到假 token 和代理地址
 *
 * @param {string} modelId - 模型 ID，用于代理路由识别（如 'A1B2C'，或 '__default__'）
 * @param {Object} [extra={}] - 额外的环境变量（如 { CI: 'true' }）
 * @returns {Object} 安全的环境变量对象
 */
function buildSafeEnv(modelId, extra = {}) {
    const env = {};

    // 只从 process.env 中提取白名单变量
    for (const key of ENV_WHITELIST) {
        if (process.env[key] !== undefined) {
            env[key] = process.env[key];
        }
    }

    // 语言设置（确保 UTF-8）
    env.LANG = 'en_US.UTF-8';
    env.LC_ALL = 'en_US.UTF-8';

    // API 认证：指向内部代理，使用假 token
    env.ANTHROPIC_AUTH_TOKEN = 'proxy-placeholder-token';
    env.ANTHROPIC_BASE_URL = `http://localhost:${PROXY_PORT}/internal-proxy/${modelId}`;

    // Claude CLI 配置
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
        process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || '1';

    return { ...env, ...extra };
}

module.exports = { buildSafeEnv, ENV_WHITELIST, PROXY_PORT };
