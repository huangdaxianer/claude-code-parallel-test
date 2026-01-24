/**
 * previewService.js 单元测试
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('previewService module', () => {
    let previewService;
    let testDir;

    beforeAll(() => {
        previewService = require('../services/previewService');
        // 创建测试目录
        testDir = path.join(os.tmpdir(), 'preview-service-test-' + Date.now());
        fs.mkdirSync(testDir, { recursive: true });
    });

    afterAll(() => {
        // 清理测试目录
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    describe('detectProjectType', () => {
        test('returns "node" for package.json projects', async () => {
            const nodeDir = path.join(testDir, 'node-project');
            fs.mkdirSync(nodeDir, { recursive: true });
            fs.writeFileSync(path.join(nodeDir, 'package.json'), '{}');

            const result = await previewService.detectProjectType(nodeDir);
            expect(result).toBe('node');
        });

        test('returns "java" for pom.xml projects', async () => {
            const javaDir = path.join(testDir, 'java-project');
            fs.mkdirSync(javaDir, { recursive: true });
            fs.writeFileSync(path.join(javaDir, 'pom.xml'), '<project></project>');

            const result = await previewService.detectProjectType(javaDir);
            expect(result).toBe('java');
        });

        test('returns "html" for HTML-only projects', async () => {
            const htmlDir = path.join(testDir, 'html-project');
            fs.mkdirSync(htmlDir, { recursive: true });
            fs.writeFileSync(path.join(htmlDir, 'index.html'), '<html></html>');

            const result = await previewService.detectProjectType(htmlDir);
            expect(result).toBe('html');
        });

        test('returns "unknown" for empty directories', async () => {
            const emptyDir = path.join(testDir, 'empty-project');
            fs.mkdirSync(emptyDir, { recursive: true });

            const result = await previewService.detectProjectType(emptyDir);
            expect(result).toBe('unknown');
        });

        test('returns "node" for nested frontend folder with package.json', async () => {
            const nestedDir = path.join(testDir, 'nested-project');
            const frontendDir = path.join(nestedDir, 'frontend');
            fs.mkdirSync(frontendDir, { recursive: true });
            fs.writeFileSync(path.join(frontendDir, 'package.json'), '{}');

            const result = await previewService.detectProjectType(nestedDir);
            expect(result).toBe('node');
        });
    });

    describe('detectStartCommand', () => {
        test('returns npm start for projects with start script', async () => {
            const projDir = path.join(testDir, 'npm-start-project');
            fs.mkdirSync(projDir, { recursive: true });
            fs.writeFileSync(
                path.join(projDir, 'package.json'),
                JSON.stringify({ scripts: { start: 'node app.js' } })
            );

            const result = await previewService.detectStartCommand(projDir);
            expect(result.cmd).toBe('npm');
            expect(result.args).toContain('start');
        });

        test('returns npm run dev for projects with dev script only', async () => {
            const projDir = path.join(testDir, 'npm-dev-project');
            fs.mkdirSync(projDir, { recursive: true });
            fs.writeFileSync(
                path.join(projDir, 'package.json'),
                JSON.stringify({ scripts: { dev: 'vite' } })
            );

            const result = await previewService.detectStartCommand(projDir);
            expect(result.cmd).toBe('npm');
            expect(result.args).toEqual(['run', 'dev']);
        });

        test('returns node server.js for fallback entry', async () => {
            const projDir = path.join(testDir, 'node-fallback-project');
            fs.mkdirSync(projDir, { recursive: true });
            fs.writeFileSync(path.join(projDir, 'server.js'), 'console.log("server")');

            const result = await previewService.detectStartCommand(projDir);
            expect(result.cmd).toBe('node');
            expect(result.args).toContain('server.js');
        });

        test('throws error for undetectable projects', async () => {
            const projDir = path.join(testDir, 'unknown-project');
            fs.mkdirSync(projDir, { recursive: true });

            await expect(previewService.detectStartCommand(projDir)).rejects.toThrow(
                'Unable to determine start command'
            );
        });
    });

    describe('checkPort', () => {
        test('returns false for free port', async () => {
            // 使用一个很可能是空闲的高端口号
            const result = await previewService.checkPort(59999);
            expect(result).toBe(false);
        });

        // 注意: 测试占用端口需要实际占用一个端口，这里跳过
    });

    describe('findFreePort', () => {
        test('finds a free port in range', async () => {
            const port = await previewService.findFreePort(50000, 50100);
            expect(port).toBeGreaterThanOrEqual(50000);
            expect(port).toBeLessThanOrEqual(50100);
        });
    });
});
