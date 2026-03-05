#!/bin/bash

# 新服务器 101.47.11.111 部署脚本
# SSH 端口: 22

source .env

NEW_SERVER_HOST=101.47.11.111
NEW_SERVER_PORT=22
NEW_SERVER_USER=root
NEW_SERVER_PASSWORD="${TEST_SERVER_PASSWORD}"
NEW_SERVER_PROJECT_PATH=/root/project/claude-code-parallel-test
NEW_SERVER_PM2_APP_NAME=server

echo "🚀 开始部署到新服务器 (${NEW_SERVER_HOST})..."

sshpass -p "${NEW_SERVER_PASSWORD}" ssh -o StrictHostKeyChecking=no -p ${NEW_SERVER_PORT} ${NEW_SERVER_USER}@${NEW_SERVER_HOST} \
  "cd ${NEW_SERVER_PROJECT_PATH} && git pull origin main && npm install --production && pm2 restart ${NEW_SERVER_PM2_APP_NAME} && pm2 list"

echo "✅ 新服务器部署完成！"
echo "   访问地址: http://${NEW_SERVER_HOST}:3001"
