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

// Body parser should skip multipart/form-data (handled by multer)
app.use((req, res, next) => {
    if (req.is('multipart/form-data')) {
        return next();
    }
    bodyParser.json({ limit: '100mb' })(req, res, next);
});

app.use((req, res, next) => {
    if (req.is('multipart/form-data')) {
        return next();
    }
    bodyParser.urlencoded({ limit: '100mb', extended: true, parameterLimit: 100000 })(req, res, next);
});

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
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                error: '文件过大。单个文件大小不能超过 500MB。',
                detail: err.message,
                code: err.code
            });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(413).json({
                error: '文件数量超过上限。最多只能上传 100,000 个文件。',
                detail: err.message,
                code: err.code
            });
        }
        if (err.code === 'LIMIT_FIELD_KEY') {
            return res.status(413).json({
                error: '字段名过长。',
                detail: err.message,
                code: err.code
            });
        }
        if (err.code === 'LIMIT_FIELD_VALUE') {
            return res.status(413).json({
                error: '字段值过大。',
                detail: err.message,
                code: err.code
            });
        }
        if (err.code === 'LIMIT_FIELD_COUNT') {
            return res.status(413).json({
                error: '字段数量超过上限。',
                detail: err.message,
                code: err.code
            });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({
                error: '文件数量超过上限或字段名错误。请检查上传的文件数量（当前上限 100,000）或联系管理员。',
                detail: err.message,
                code: err.code
            });
        }
        return res.status(400).json({
            error: `上传错误: ${err.message}`,
            code: err.code
        });
    }
    // 通用错误处理
    console.error('[ServerError]', err);
    if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
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
