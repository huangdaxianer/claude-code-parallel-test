module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/__tests__/**/*.test.js'],
    collectCoverageFrom: [
        'config.js',
        'services/**/*.js',
        'routes/**/*.js'
    ],
    coverageThreshold: {
        global: { statements: 50 }
    },
    testTimeout: 10000,
    // 避免测试时实际加载数据库
    modulePathIgnorePatterns: ['<rootDir>/node_modules/']
};
