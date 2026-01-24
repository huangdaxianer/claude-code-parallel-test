/**
 * 主入口文件 (重构后)
 * 职责：Express 应用初始化、中间件配置、路由挂载、服务器启动
 */
require('dotenv').config();
console.log("Starting server at " + new Date().toISOString());

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');

const config = require('./config');
const routes = require('./routes');
const { processQueue } = require('./services/queueService');

const app = express();
const PORT = 3001;

// 中间件配置
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));
app.use('/artifacts', express.static(config.TASKS_DIR));

// 根路由重定向
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// 挂载 API 路由
app.use('/api', routes);

// Multer 错误处理中间件
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        console.error('[MulterError]', err);
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({
                error: '文件数量超过上限或字段名错误。请检查上传的文件数量（当前上限 100,000）或联系管理员。',
                detail: err.message
            });
        }
        return res.status(400).json({ error: `上传错误: ${err.message}`, code: err.code });
    }
    // 通用错误处理
    console.error('[ServerError]', err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// 启动队列处理
processQueue();

// 错误处理 - 确保队列恢复
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    setTimeout(processQueue, 1000);
});

// 启动服务器
const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
server.timeout = 300000; // 5 分钟超时 (大文件上传)
