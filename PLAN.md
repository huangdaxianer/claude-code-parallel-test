# 密码登录功能产品方案

## 一、需求概述

为系统增加密码认证机制，替代当前仅凭用户名即可登录的方式。同时修复 `x-username` 请求头可绕过认证的安全漏洞。

---

## 二、涉及的改动模块

| 模块 | 文件 | 改动内容 |
|------|------|----------|
| 数据库 | `db.js` | users 表新增 `password_hash` 字段 |
| 依赖 | `package.json` | 新增 `bcryptjs` 依赖 |
| 登录接口 | `routes/auth.js` | 登录接口增加密码校验逻辑、新增修改密码接口 |
| 认证中间件 | `middleware/auth.js` | 移除 `x-username` header，改用 session cookie 认证 |
| 管理后台接口 | `routes/admin.js` | 新增管理员重置用户密码接口 |
| 登录页面 | `public/login.html` | 增加密码输入框、新用户注册确认弹窗 |
| 前端认证 | `public/js/auth.js` | 适配新的登录/cookie 机制 |
| 前端 API | `public/js/api.js` | 移除 `x-username` header，新增修改密码 API |
| 管理后台 API | `public/js/modules/api.js` | 移除 `x-username` header，新增重置密码 API |
| 主页面 | `public/task.html` | 用户下拉菜单增加「修改密码」入口 |
| 主页面 JS | `public/js/app.js` | 增加修改密码弹窗逻辑 |
| 管理后台页面 | `public/task_manager.html` | 用户管理表格增加「重置密码」按钮 |
| 管理后台 JS | `public/js/modules/main.js` | 增加重置密码事件处理 |
| 管理后台 UI | `public/js/modules/ui.js` | 用户列表渲染增加重置密码按钮 |

---

## 三、详细方案

### 3.1 数据库变更

**文件：`db.js`**

- 用 migration 方式为 `users` 表新增 `password_hash TEXT` 字段
- 在 migration 逻辑中：对所有 `password_hash IS NULL` 的存量用户，统一设置密码为 `111111`（使用 bcryptjs 哈希后存入）

```
ALTER TABLE users ADD COLUMN password_hash TEXT
```

### 3.2 登录流程改造

**文件：`routes/auth.js` — `POST /login`**

改造后的登录流程：

1. 接收 `{ username, password }` 两个参数
2. 查询用户是否存在：
   - **用户存在**：用 bcryptjs 比对 `password` 和 `password_hash`
     - 密码正确 → 返回 `{ success: true, user }`
     - 密码错误 → 返回 `{ error: '密码错误' }`
   - **用户不存在**：
     - 如果 `allowNewRegistration === false` → 返回 `{ error: '用户不存在' }`
     - 如果允许注册 → 返回 `{ needRegister: true }`，前端弹窗询问用户是否要注册
3. 新增 `POST /register` 接口：
   - 接收 `{ username, password }`
   - 检查 `allowNewRegistration`，检查用户名是否已存在
   - 创建用户，密码用 bcryptjs 哈希后存入 `password_hash`
   - 返回 `{ success: true, user }`

**关于 Cookie 认证：**

- 登录/注册成功后，后端通过 `res.cookie('username', ...)` 设置 cookie（保持现有方式，httpOnly 暂不启用，因为前端 JS 需要读取用户名用于显示）
- 前端行为基本不变：localStorage 存 user 信息用于页面状态，cookie 中的 username 用于后端认证

### 3.3 认证中间件改造

**文件：`middleware/auth.js`**

`getCurrentUser` 函数改造：

```diff
 function getCurrentUser(req) {
-    const username = req.cookies?.username || req.headers['x-username'];
+    const username = req.cookies?.username;
     if (!username) return null;
     return db.prepare('SELECT id, username, role, group_id FROM users WHERE username = ?').get(username);
 }
```

- **移除** `req.headers['x-username']`，彻底堵住通过请求头伪造身份的漏洞
- 只信任 cookie 中的 username

### 3.4 修改密码功能（用户端）

**新增接口：`routes/auth.js` — `POST /change-password`**

- 需要 `requireLogin` 中间件保护
- 接收 `{ oldPassword, newPassword }`
- 验证旧密码正确后，更新 `password_hash`
- 密码格式要求：长度 >= 6

**前端 — `task.html` 用户下拉菜单**

在现有的用户下拉菜单（`#user-dropdown-menu`）中，在「退出登录」按钮前面插入「修改密码」入口：

```html
<button class="user-dropdown-item" onclick="openChangePasswordModal()">修改密码</button>
```

**前端 — 修改密码弹窗**

在 `task.html` 末尾添加一个 modal：
- 包含「旧密码」、「新密码」、「确认新密码」三个输入框
- 提交后调用 `POST /api/change-password`
- 成功后提示「密码修改成功」

### 3.5 管理员重置密码功能

**新增接口：`routes/admin.js` — `PUT /users/:id/password`**

- 需要 `requireAdmin` 中间件保护（通过路由挂载已有保护）
- 接收 `{ password }`
- 管理员直接设置目标用户的新密码（无需旧密码）
- 密码用 bcryptjs 哈希后存入

**前端 — `task_manager.html` 用户管理**

在每个用户行的「操作」列中，增加一个「重置密码」按钮：

```html
<button class="action-btn" data-action="reset-password" data-id="用户ID" data-name="用户名">重置密码</button>
```

点击后弹出一个简单的 prompt（`window.prompt`），输入新密码后调用 `PUT /api/admin/users/:id/password`。

### 3.6 登录页面改造

**文件：`public/login.html`**

- 在用户名输入框下方增加**密码输入框** `<input type="password">`
- 登录按钮文案从「开始」改为「登录」
- 登录流程改为：
  1. 提交 `{ username, password }` 到 `/api/login`
  2. 如果返回 `{ needRegister: true }`，弹出 `confirm('该用户名不存在，是否注册新账号？')`
     - 用户确认 → 调用 `POST /api/register`
     - 用户取消 → 不做任何操作
  3. 如果返回 `{ success: true }` → 存储用户信息，跳转
  4. 如果返回错误 → 显示错误信息

### 3.7 前端 API 层改造

**文件：`public/js/api.js` 和 `public/js/modules/api.js`**

- 移除 `getAuthHeaders` 中的 `x-username` header
- 由于后端已改为纯 cookie 认证，前端 API 请求无需手动携带认证信息（浏览器会自动带 cookie）
- `getAuthHeaders()` 改为返回空对象 `{}`

**新增 API：**

```js
// public/js/api.js
App.api.changePassword = async function(oldPassword, newPassword) {
    const res = await fetch('/api/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword })
    });
    return res.json();
};
```

```js
// public/js/modules/api.js
async resetUserPassword(userId, password) {
    const res = await fetch(`/api/admin/users/${userId}/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || '未知错误');
    }
    return await res.json();
}
```

---

## 四、存量用户迁移策略

- 在 `db.js` 的 migration 区域中执行一次性迁移
- 对所有 `password_hash IS NULL` 的用户，设置 `password_hash` 为 `bcrypt.hashSync('111111', 10)`
- 这样所有老用户的默认密码是 `111111`
- 管理员可在后台逐个重置，用户也可自行修改

---

## 五、安全注意事项

1. **密码哈希**：使用 bcryptjs（纯 JS 实现，无需编译），salt rounds = 10
2. **移除 x-username**：彻底移除 `req.headers['x-username']` 的信任，堵住身份伪造漏洞
3. **密码长度**：最小 6 位，不做过于复杂的强度要求（适合内部工具场景）
4. **前端存储**：localStorage 继续存放用户基本信息（id, username, role 等）用于 UI 显示，认证依赖 cookie

---

## 六、不在本次范围内的事项

- **Session/JWT 机制**：本次不引入 session store 或 JWT。cookie 中仍存 username 明文，安全性在内网使用场景下可接受。如需进一步加固，后续可引入 signed cookie 或 JWT
- **密码强度校验**：仅做最小长度校验（>= 6 位）
- **忘记密码/邮件重置**：不做，管理员可直接在后台重置
- **路径穿越修复**（Issue #3）：不在本次需求范围

---

## 七、实施步骤

1. 安装 `bcryptjs` 依赖
2. 修改 `db.js` — 新增字段 + 存量用户密码初始化
3. 修改 `middleware/auth.js` — 移除 x-username
4. 修改 `routes/auth.js` — 登录接口增加密码校验 + 新增注册/修改密码接口
5. 修改 `routes/admin.js` — 新增管理员重置密码接口
6. 修改 `routes/index.js` — 挂载新增的修改密码路由
7. 修改 `public/login.html` — 增加密码输入框和注册弹窗逻辑
8. 修改 `public/js/api.js` — 移除 x-username，新增修改密码 API
9. 修改 `public/js/modules/api.js` — 移除 x-username，新增重置密码 API
10. 修改 `public/task.html` — 用户菜单增加修改密码入口 + 弹窗
11. 修改 `public/js/app.js` — 增加修改密码弹窗逻辑
12. 修改 `public/js/modules/ui.js` — 用户列表增加重置密码按钮
13. 修改 `public/js/modules/main.js` — 增加重置密码事件处理
14. 修改 `public/js/auth.js` — 适配（移除 x-username 相关逻辑）
