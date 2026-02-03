/**
 * config.js 单元测试
 */
const fs = require('fs');
const path = require('path');

// 在加载 config 模块之前，模拟环境
const TEST_CONFIG_FILE = path.join(__dirname, '../test_config.json');

describe('config module', () => {
    let config;

    beforeAll(() => {
        // 清理测试文件
        if (fs.existsSync(TEST_CONFIG_FILE)) {
            fs.unlinkSync(TEST_CONFIG_FILE);
        }
    });

    afterAll(() => {
        // 清理测试文件
        if (fs.existsSync(TEST_CONFIG_FILE)) {
            fs.unlinkSync(TEST_CONFIG_FILE);
        }
    });

    beforeEach(() => {
        // 重新加载 config 模块
        jest.resetModules();
        config = require('../config');
    });

    describe('loadConfig', () => {
        test('returns config with required properties', () => {
            const result = config.loadConfig();
            expect(result).toHaveProperty('maxParallelSubtasks');
            expect(typeof result.maxParallelSubtasks).toBe('number');
        });

        test('returns parsed config when file exists', () => {
            // 先写入测试配置
            fs.writeFileSync(
                config.CONFIG_FILE,
                JSON.stringify({ maxParallelSubtasks: 10, customKey: 'test' })
            );

            const result = config.loadConfig();
            expect(result.maxParallelSubtasks).toBe(10);
            expect(result.customKey).toBe('test');

            // 恢复
            fs.writeFileSync(config.CONFIG_FILE, JSON.stringify({ maxParallelSubtasks: 5 }));
        });
    });

    describe('saveConfig', () => {
        test('writes config to file', () => {
            const testConfig = { maxParallelSubtasks: 8, testKey: 'value' };
            config.saveConfig(testConfig);

            const fileContent = JSON.parse(fs.readFileSync(config.CONFIG_FILE, 'utf8'));
            expect(fileContent.maxParallelSubtasks).toBe(8);
            expect(fileContent.testKey).toBe('value');

            // 恢复
            config.saveConfig({ maxParallelSubtasks: 5 });
        });
    });

    describe('getAppConfig / setAppConfig', () => {
        test('getAppConfig returns current config', () => {
            const result = config.getAppConfig();
            expect(result).toBeDefined();
            expect(typeof result).toBe('object');
        });

        test('setAppConfig replaces config', () => {
            const newConfig = { maxParallelSubtasks: 3 };
            config.setAppConfig(newConfig);

            const result = config.getAppConfig();
            expect(result.maxParallelSubtasks).toBe(3);

            // 恢复
            config.setAppConfig({ maxParallelSubtasks: 5 });
        });
    });

    describe('updateAppConfig', () => {
        test('merges updates into config', () => {
            config.setAppConfig({ maxParallelSubtasks: 5 });
            const result = config.updateAppConfig({ newField: 'test' });

            expect(result.maxParallelSubtasks).toBe(5);
            expect(result.newField).toBe('test');

            // 恢复
            config.setAppConfig({ maxParallelSubtasks: 5 });
        });
    });

    describe('constants', () => {
        test('TASKS_DIR is defined', () => {
            expect(config.TASKS_DIR).toBeDefined();
            expect(typeof config.TASKS_DIR).toBe('string');
        });
    });
});
