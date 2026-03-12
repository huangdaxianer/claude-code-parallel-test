#!/bin/bash

# 加载环境变量
source .env

echo "🚀 开始部署到性能测试服务器 (${PERF_SERVER_HOST})..."

# 性能测试服务器的 PM2 运行在 appuser 用户下（非 root），
# 需要通过 su 切换用户来执行 git pull 和 pm2 restart。
sshpass -p "${PERF_SERVER_PASSWORD}" ssh -o StrictHostKeyChecking=no -p ${PERF_SERVER_PORT} ${PERF_SERVER_USER}@${PERF_SERVER_HOST} \
  "cd ${PERF_SERVER_PROJECT_PATH} && git pull origin main && npm install --production && su - appuser -c 'pm2 restart ${PERF_SERVER_PM2_APP_NAME} && pm2 list'"

echo "✅ 性能测试服务器部署完成！"
