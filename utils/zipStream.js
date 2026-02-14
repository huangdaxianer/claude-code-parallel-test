/**
 * ZIP 流式下载工具函数
 * 将指定目录打包为 ZIP 并以流式方式发送给客户端
 */
const archiver = require('archiver');

/**
 * 流式下载目录为 ZIP
 * @param {string} dirPath - 要打包的目录绝对路径
 * @param {string} downloadName - 下载文件名（如 "task_ABC123.zip"）
 * @param {object} req - Express request 对象
 * @param {object} res - Express response 对象
 */
function streamZip(dirPath, downloadName, req, res) {
    req.setTimeout(0);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`);

    const archive = archiver('zip', {
        zlib: { level: 1 }
    });

    archive.on('warning', (err) => {
        if (err.code === 'ENOENT') {
            console.warn('[ZIP Warning]', err);
        } else {
            console.error('[ZIP Error]', err);
        }
    });

    archive.on('error', (err) => {
        console.error('[ZIP Error]', err);
        if (!res.headersSent) {
            res.status(500).send({ error: err.message });
        } else {
            res.destroy();
        }
    });

    archive.pipe(res);

    console.log(`[ZIP] Streaming archive for directory: ${dirPath}`);

    archive.glob('**/*', {
        cwd: dirPath,
        ignore: ['**/.DS_Store'],
        dot: true,
        follow: false
    });

    archive.finalize();
}

module.exports = { streamZip };
