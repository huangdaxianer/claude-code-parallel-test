# 服务器部署指南

本文档提供服务器连接和部署的命令模板。**所有敏感信息都存储在 `.env` 文件中**。

## 环境变量配置

在使用以下命令前，请确保 `.env` 文件中包含以下配置：

```bash
SERVER_HOST=<服务器IP>
SERVER_PORT=<SSH端口>
SERVER_USER=<用户名>
SERVER_PASSWORD=<密码>
SERVER_PROJECT_PATH=<项目路径>
SERVER_PM2_APP_NAME=<PM2应用名称>
```

## SSH 连接

### 基本连接
```bash
ssh -p ${SERVER_PORT} ${SERVER_USER}@${SERVER_HOST}
```

### 使用 sshpass 自动登录
```bash
sshpass -p "${SERVER_PASSWORD}" ssh -p ${SERVER_PORT} ${SERVER_USER}@${SERVER_HOST}
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

**方式一：使用环境变量**
```bash
# 需要先 source .env 或在脚本中读取环境变量
sshpass -p "${SERVER_PASSWORD}" ssh -o StrictHostKeyChecking=no -p ${SERVER_PORT} ${SERVER_USER}@${SERVER_HOST} \
  "cd ${SERVER_PROJECT_PATH} && git pull origin main && pm2 restart ${SERVER_PM2_APP_NAME} && pm2 list"
```

**方式二：创建部署脚本**

创建 `deploy.sh` 文件：

```bash
#!/bin/bash

# 加载环境变量
source .env

# 执行部署
sshpass -p "${SERVER_PASSWORD}" ssh -o StrictHostKeyChecking=no -p ${SERVER_PORT} ${SERVER_USER}@${SERVER_HOST} \
  "cd ${SERVER_PROJECT_PATH} && git pull origin main && pm2 restart ${SERVER_PM2_APP_NAME} && pm2 list"
```

然后执行：
```bash
chmod +x deploy.sh
./deploy.sh
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
