#!/bin/bash

# 加载环境变量
source .env

echo "🚀 开始部署到正式服务器 (${PROD_SERVER_HOST})..."
echo "⚠️  警告：即将部署到生产环境！"
read -p "确认继续？(yes/no): " confirm

if [ "$confirm" != "yes" ]; then
  echo "❌ 部署已取消"
  exit 1
fi

# 执行部署
sshpass -p "${PROD_SERVER_PASSWORD}" ssh -o StrictHostKeyChecking=no -p ${PROD_SERVER_PORT} ${PROD_SERVER_USER}@${PROD_SERVER_HOST} \
  "cd ${PROD_SERVER_PROJECT_PATH} && git pull origin main && pm2 restart ${PROD_SERVER_PM2_APP_NAME} && pm2 list"

echo "✅ 正式服务器部署完成！"
