/**
 * FileTailer - 基于轮询的文件 tail 工具
 * 替代 readline.createInterface(child.stdout)，通过轮询文件来消费 Claude CLI 的输出
 * 当父进程重启后，可以从 DB 保存的 offset 续读
 */
const fs = require('fs');

class FileTailer {
    /**
     * @param {string} filePath - stdout 文件的绝对路径
     * @param {number} startOffset - 起始字节偏移量（从 DB 恢复时使用）
     * @param {function(string)} onLine - 每读到一个完整行时的回调
     * @param {object} [opts] - 可选配置
     * @param {number} [opts.pollInterval=200] - 轮询间隔（ms）
     */
    constructor(filePath, startOffset, onLine, opts = {}) {
        this.filePath = filePath;
        this.offset = startOffset || 0;
        this.onLine = onLine;
        this.pollInterval = opts.pollInterval || 200;

        this.fd = null;
        this.timer = null;
        this.buffer = '';       // 未完成行的缓冲（跨 poll 周期）
        this.stopped = false;
    }

    /**
     * 开启轮询
     */
    start() {
        if (this.stopped) return;
        try {
            this.fd = fs.openSync(this.filePath, 'r');
        } catch (e) {
            // 文件可能还不存在（进程刚启动），延迟重试
            console.warn(`[FileTailer] File not ready: ${this.filePath}, retrying in 500ms`);
            this.timer = setTimeout(() => this.start(), 500);
            return;
        }
        this.timer = setInterval(() => this._poll(), this.pollInterval);
    }

    /**
     * 内部轮询：读取文件新增内容，按 \n 分行，回调完整行
     */
    _poll() {
        if (this.stopped || this.fd === null) return;

        try {
            const stat = fs.fstatSync(this.fd);
            const fileSize = stat.size;

            if (fileSize <= this.offset) return; // 没有新数据

            const bytesToRead = fileSize - this.offset;
            const buf = Buffer.alloc(bytesToRead);
            const bytesRead = fs.readSync(this.fd, buf, 0, bytesToRead, this.offset);

            if (bytesRead === 0) return;

            this.offset += bytesRead;
            const chunk = buf.toString('utf8', 0, bytesRead);

            // 拼接 buffer 处理跨 poll 的不完整行
            const data = this.buffer + chunk;
            const lines = data.split('\n');

            // 最后一个元素可能是不完整行，保留在 buffer 中
            this.buffer = lines.pop() || '';

            for (const line of lines) {
                if (line) {
                    try {
                        this.onLine(line);
                    } catch (e) {
                        console.error('[FileTailer] onLine callback error:', e.message);
                    }
                }
            }
        } catch (e) {
            // EBADF = fd 已关闭，静默忽略
            if (e.code !== 'EBADF') {
                console.error(`[FileTailer] Poll error for ${this.filePath}:`, e.message);
            }
        }
    }

    /**
     * 手动触发一次 poll（用于进程结束后的最终刷新）
     * 同时将 buffer 中的未完成行也作为最后一行回调
     */
    pollOnce() {
        this._poll();
        // 刷新 buffer 中可能残余的最后一行（无换行结尾的尾部数据）
        if (this.buffer) {
            try {
                this.onLine(this.buffer);
            } catch (e) {
                console.error('[FileTailer] onLine callback error (final flush):', e.message);
            }
            this.buffer = '';
        }
    }

    /**
     * 获取当前安全偏移量（不含 buffer 中未完成行的部分）
     * 用于保存到 DB，重启后从此处续读
     */
    getOffset() {
        // 安全偏移 = 当前文件偏移 - buffer 中未消费的字节数
        const bufferBytes = Buffer.byteLength(this.buffer, 'utf8');
        return Math.max(0, this.offset - bufferBytes);
    }

    /**
     * 停止轮询、关闭 fd
     */
    stop() {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.fd !== null) {
            try {
                fs.closeSync(this.fd);
            } catch (e) {
                // ignore - fd may already be closed
            }
            this.fd = null;
        }
    }
}

module.exports = { FileTailer };
