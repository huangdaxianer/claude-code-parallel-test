# 服务器部署指南

本文档提供服务器连接和部署的命令模板。**所有敏感信息都存储在 `.env` 文件中**。

## 服务器信息总结

| 环境       | IP 地址        | SSH 端口 | 用户 | 项目路径                                | PM2 应用名 | 环境变量前缀 |
| ---------- | -------------- | -------- | ---- | --------------------------------------- | ---------- | ------------ |
| 测试服务器 | 101.47.158.114 | 2222     | root | /root/project/claude-code-parallel-test | server     | TEST_        |
| 正式服务器 | 101.47.156.188 | 2222     | root | /root/project/claude-code-parallel-test | server     | PROD_        |

**注意**：
- 测试服务器用于开发和测试，可以随意部署
- 正式服务器用于生产环境，部署前需要确认
- 默认命令使用 `SERVER_` 前缀，当前指向测试服务器
- 如需修改正式服务器密码，请在 `.env` 中更新 `PROD_SERVER_PASSWORD`

## 环境变量配置

在使用以下命令前，请确保 `.env` 文件中包含以下配置：

### 测试服务器配置（TEST_）
```bash
TEST_SERVER_HOST=101.47.158.114
TEST_SERVER_PORT=2222
TEST_SERVER_USER=root
TEST_SERVER_PASSWORD=<密码>
TEST_SERVER_PROJECT_PATH=/root/project/claude-code-parallel-test
TEST_SERVER_PM2_APP_NAME=server
```

### 正式服务器配置（PROD_）
```bash
PROD_SERVER_HOST=101.47.156.188
PROD_SERVER_PORT=2222
PROD_SERVER_USER=root
PROD_SERVER_PASSWORD=<密码>
PROD_SERVER_PROJECT_PATH=/root/project/claude-code-parallel-test
PROD_SERVER_PM2_APP_NAME=server
```

### 默认服务器配置（SERVER_）
```bash
# 默认使用测试服务器，可以通过修改这些变量切换到正式服务器
SERVER_HOST=${TEST_SERVER_HOST}
SERVER_PORT=${TEST_SERVER_PORT}
SERVER_USER=${TEST_SERVER_USER}
SERVER_PASSWORD=${TEST_SERVER_PASSWORD}
SERVER_PROJECT_PATH=${TEST_SERVER_PROJECT_PATH}
SERVER_PM2_APP_NAME=${TEST_SERVER_PM2_APP_NAME}
```

## SSH 连接

### 连接默认服务器（当前：测试服务器）
```bash
# 基本连接
ssh -p ${SERVER_PORT} ${SERVER_USER}@${SERVER_HOST}

# 使用 sshpass 自动登录
sshpass -p "${SERVER_PASSWORD}" ssh -p ${SERVER_PORT} ${SERVER_USER}@${SERVER_HOST}
```

### 连接测试服务器
```bash
# 基本连接
ssh -p ${TEST_SERVER_PORT} ${TEST_SERVER_USER}@${TEST_SERVER_HOST}

# 使用 sshpass 自动登录
sshpass -p "${TEST_SERVER_PASSWORD}" ssh -p ${TEST_SERVER_PORT} ${TEST_SERVER_USER}@${TEST_SERVER_HOST}
```

### 连接正式服务器
```bash
# 基本连接
ssh -p ${PROD_SERVER_PORT} ${PROD_SERVER_USER}@${PROD_SERVER_HOST}

# 使用 sshpass 自动登录
sshpass -p "${PROD_SERVER_PASSWORD}" ssh -p ${PROD_SERVER_PORT} ${PROD_SERVER_USER}@${PROD_SERVER_HOST}
```

## PM2 管理命令

连接到服务器后，使用以下命令管理应用：

```bash
# 查看运行状态
pm2 list

# 重启服务
pm2 restart ${SERVER_PM2_APP_NAME}

# 查看日志
pm2 logs ${SERVER_PM2_APP_NAME}

# 查看实时日志（最近100行）
pm2 logs ${SERVER_PM2_APP_NAME} --lines 100

# 停止服务
pm2 stop ${SERVER_PM2_APP_NAME}

# 删除服务
pm2 delete ${SERVER_PM2_APP_NAME}
```

## 部署更新流程

### 服务器上手动更新
```bash
cd ${SERVER_PROJECT_PATH} && git pull origin main && pm2 restart ${SERVER_PM2_APP_NAME}
```

### 本地一键部署

#### 部署到默认服务器（当前：测试服务器）
```bash
# 需要先 source .env 或在脚本中读取环境变量
sshpass -p "${SERVER_PASSWORD}" ssh -o StrictHostKeyChecking=no -p ${SERVER_PORT} ${SERVER_USER}@${SERVER_HOST} \
  "cd ${SERVER_PROJECT_PATH} && git pull origin main && pm2 restart ${SERVER_PM2_APP_NAME} && pm2 list"
```

#### 部署到测试服务器
```bash
sshpass -p "${TEST_SERVER_PASSWORD}" ssh -o StrictHostKeyChecking=no -p ${TEST_SERVER_PORT} ${TEST_SERVER_USER}@${TEST_SERVER_HOST} \
  "cd ${TEST_SERVER_PROJECT_PATH} && git pull origin main && pm2 restart ${TEST_SERVER_PM2_APP_NAME} && pm2 list"
```

#### 部署到正式服务器
```bash
sshpass -p "${PROD_SERVER_PASSWORD}" ssh -o StrictHostKeyChecking=no -p ${PROD_SERVER_PORT} ${PROD_SERVER_USER}@${PROD_SERVER_HOST} \
  "cd ${PROD_SERVER_PROJECT_PATH} && git pull origin main && pm2 restart ${PROD_SERVER_PM2_APP_NAME} && pm2 list"
```

### 创建部署脚本

#### 部署到测试服务器脚本
创建 `deploy-test.sh` 文件：

```bash
#!/bin/bash

# 加载环境变量
source .env

echo "🚀 开始部署到测试服务器 (${TEST_SERVER_HOST})..."

# 执行部署
sshpass -p "${TEST_SERVER_PASSWORD}" ssh -o StrictHostKeyChecking=no -p ${TEST_SERVER_PORT} ${TEST_SERVER_USER}@${TEST_SERVER_HOST} \
  "cd ${TEST_SERVER_PROJECT_PATH} && git pull origin main && pm2 restart ${TEST_SERVER_PM2_APP_NAME} && pm2 list"

echo "✅ 测试服务器部署完成！"
```

然后执行：
```bash
chmod +x deploy-test.sh
./deploy-test.sh
```

#### 部署到正式服务器脚本
创建 `deploy-prod.sh` 文件：

```bash
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
```

然后执行：
```bash
chmod +x deploy-prod.sh
./deploy-prod.sh
```

## 常用操作

### 查看服务器磁盘使用情况
```bash
sshpass -p "${SERVER_PASSWORD}" ssh -p ${SERVER_PORT} ${SERVER_USER}@${SERVER_HOST} "df -h"
```

### 查看项目目录大小
```bash
sshpass -p "${SERVER_PASSWORD}" ssh -p ${SERVER_PORT} ${SERVER_USER}@${SERVER_HOST} "du -sh ${SERVER_PROJECT_PATH}"
```

### 备份数据库
```bash
sshpass -p "${SERVER_PASSWORD}" ssh -p ${SERVER_PORT} ${SERVER_USER}@${SERVER_HOST} \
  "cd ${SERVER_PROJECT_PATH} && cp tasks.db tasks.db.backup-\$(date +%Y%m%d-%H%M%S)"
```

## 快速参考

### 最常用命令

```bash
# 部署到测试服务器（推荐使用脚本）
./deploy-test.sh

# 部署到正式服务器（推荐使用脚本）
./deploy-prod.sh

# 查看测试服务器状态
source .env && sshpass -p "${TEST_SERVER_PASSWORD}" ssh -p ${TEST_SERVER_PORT} ${TEST_SERVER_USER}@${TEST_SERVER_HOST} "pm2 list"

# 查看正式服务器状态
source .env && sshpass -p "${PROD_SERVER_PASSWORD}" ssh -p ${PROD_SERVER_PORT} ${PROD_SERVER_USER}@${PROD_SERVER_HOST} "pm2 list"

# 查看测试服务器日志
source .env && sshpass -p "${TEST_SERVER_PASSWORD}" ssh -p ${TEST_SERVER_PORT} ${TEST_SERVER_USER}@${TEST_SERVER_HOST} "pm2 logs server --lines 50"

# 查看正式服务器日志
source .env && sshpass -p "${PROD_SERVER_PASSWORD}" ssh -p ${PROD_SERVER_PORT} ${PROD_SERVER_USER}@${PROD_SERVER_HOST} "pm2 logs server --lines 50"
```

### 环境切换

如果想让默认命令（使用 `SERVER_` 前缀）指向正式服务器，修改 `.env` 文件：

```bash
# 将默认服务器改为正式服务器
SERVER_HOST=${PROD_SERVER_HOST}
SERVER_PORT=${PROD_SERVER_PORT}
SERVER_USER=${PROD_SERVER_USER}
SERVER_PASSWORD=${PROD_SERVER_PASSWORD}
SERVER_PROJECT_PATH=${PROD_SERVER_PROJECT_PATH}
SERVER_PM2_APP_NAME=${PROD_SERVER_PM2_APP_NAME}
```
