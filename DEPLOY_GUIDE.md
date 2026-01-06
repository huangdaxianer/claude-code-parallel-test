# Claude Parallel Test 部署指南 (云服务器版)

本指南介绍如何将本项目部署到云服务器（Linux/Ubuntu/Debian）上，并配置安全隔离环境。

## 1. 基础环境安装

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装 Node.js (推荐 v18+)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装 Claude Code (全局)
sudo npm install -g @anthropic-ai/claude-code
```

## 2. 隔离用户配置 (必须)

为了安全运行生成的代码，必须创建一个专门的低权限用户 `claude-user`。

```bash
# 创建隔离用户
sudo useradd -m -s /bin/bash claude-user

# 设置家目录权限
sudo mkdir -p /Users/claude-user  # 如果脚本中使用的是这个路径，请保持一致，或者修改脚本
sudo chown -R claude-user /Users/claude-user
```

## 3. 免密 sudo 配置 (核心)

服务在后台运行脚本时，需要免密执行 `chown`、`chmod` 和身份切换操作。

1. 执行 `sudo visudo`。
2. 在文件末尾添加以下行（假设您的部署用户名是 `ubuntu`）：

```text
# 替换 ubuntu 为你的实际用户名
ubuntu ALL=(ALL) NOPASSWD: /usr/bin/mkdir, /usr/bin/cp, /usr/bin/chown, /usr/bin/chmod, /usr/bin/sudo, /usr/local/bin/claude
```
*注：请运行 `which claude` 确认二进制文件的实际物理路径并填入。*

## 4. 目录权限初始化

```bash
# 修正临时目录权限
sudo mkdir -p /tmp/claude
sudo chmod 777 /tmp/claude
```

## 5. 项目部署与启动

1. **同步代码**：将项目源码上传至服务器目录。
2. **安装依赖**：
   ```bash
   npm install
   ```
3. **完成登录 (必须)**：
   在服务器上，以您的主用户身份手动运行一次 `claude` 并完成认证：
   ```bash
   claude
   # 按照提示完成 OAuth 登录
   ```
   *即使是云主机，你也需要在终端完成一次授权，脚本会自动将 `~/.claude` 下的凭证同步给隔离用户。*

4. **配置环境变量 (新增)**：
   复制示例配置并填入你的 API Key（用于 AI 自动生成任务标题）：
   ```bash
   cp .env.example .env
   nano .env
   # 在文件中修改 TITLE_GEN_KEY=your_key_here
   ```

5. **启动服务**：
   ```bash
   # 推荐使用 pm2 运行
   sudo npm install -g pm2
   pm2 start server.js --name claude-parallel
   ```

## 6. 常见问题排查

*   **Waiting for output... 卡住**：通常是 `visudo` 配置中的命令路径不正确。确认服务器上的 `chown` 是在 `/usr/bin/` 还是 `/usr/sbin/`。
*   **Permission Denied (uv_cwd)**：确保隔离用户 `claude-user` 对项目所在的父级路径有 `+x` (搜索) 权限。
*   **Authentication Error**：确保主用户的 `~/.claude` 目录存在且包含有效的登录凭证。
