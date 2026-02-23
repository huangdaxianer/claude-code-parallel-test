#!/bin/bash

# 加载环境变量
source .env

echo "🚀 开始部署到测试服务器 (${TEST_SERVER_HOST})..."

# 执行部署
sshpass -p "${TEST_SERVER_PASSWORD}" ssh -o StrictHostKeyChecking=no -p ${TEST_SERVER_PORT} ${TEST_SERVER_USER}@${TEST_SERVER_HOST} \
  "cd ${TEST_SERVER_PROJECT_PATH} && git pull origin main && npm install --production && pm2 restart ${TEST_SERVER_PM2_APP_NAME} && pm2 list"

echo "✅ 测试服务器部署完成！"
