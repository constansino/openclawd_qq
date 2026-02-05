OpenClawd 是一个多功能代理。下面的聊天演示仅展示了最基础的功能。
<img width="1324" height="1000" alt="image" src="https://github.com/user-attachments/assets/00b0f347-be84-4fe0-94f2-456679d84f45" />
<img width="1687" height="1043" alt="PixPin_2026-01-29_16-09-58" src="https://github.com/user-attachments/assets/998a1d42-9566-4d20-8467-39dd1752a035" />
<img width="1380" height="710" alt="image" src="https://github.com/user-attachments/assets/9900b779-732a-4b3e-88a1-b10fe7d555c0" />

# OpenClaw QQ 插件 (OneBot v11)

本插件通过 OneBot v11 协议（WebSocket）为 [OpenClaw](https://github.com/openclaw/openclaw) 添加 QQ 频道支持。

## ✨ 功能特性

*   **智能上下文**：
    *   **历史回溯**：群聊自动获取最近 5 条历史消息，帮助 AI 理解前文。
    *   **系统提示词**：支持注入自定义 System Prompt。
*   **多场景交互**：
    *   **自动 @回复**：群聊回复自动 @原发送者（仅首条分片）。
    *   **多媒体感知**：接收图片、语音、视频、卡片消息。
    *   **表情理解**：将 QQ 表情代码转换为 `[表情]` 文本。
*   **稳定性与安全**：
    *   **黑白名单**：支持配置允许的群组 (`allowedGroups`) 和拉黑用户 (`blockedUsers`)。
    *   **智能重连**：采用指数退避算法，网络波动时优雅重连。
    *   **消息去重**：内置 ID 去重，防止重复回复。
    *   **风控规避**：可选 URL 处理模式。
*   **格式优化**：
    *   **Markdown 转纯文本**：自动将表格、列表转换为易读的文本格式。
    *   **长消息分片**：超长回复自动拆分。
*   **自动化管理**：
    *   **请求处理**：自动通过好友/群组邀请。
    *   **信息同步**：自动同步 Bot 昵称。
    *   **消息撤回**：支持 AI 撤回不当消息。
    *   **管理员指令**：内置 `/status`, `/help`。

---

## 📋 前置条件
你需要一个运行中的 OneBot v11 服务端，推荐：
- **[NapCat](https://github.com/NapCatQQ/NapCat-Docker)** (现代、对 Docker 友好)
- **Lagrange** 或 **Go-CQHTTP**

请确保在 OneBot 设置中开启了 **正向 WebSocket 服务**（通常端口为 3001）。

## 🚀 安装步骤

### 方案 A：源码 / 官方安装版
1. **进入扩展目录**：`cd openclaw/extensions`
2. **克隆此插件**：`git clone https://github.com/constansino/openclaw_qq.git qq`
3. **安装依赖并编译**：回到根目录执行 `pnpm install && pnpm build`
4. **重启 OpenClaw**。

### 方案 B：Docker 安装
将插件放入 `extensions/qq` 并重新构建镜像：`docker compose build openclaw-gateway`。

## ⚙️ 配置方法

### 方式一：使用配置向导（推荐）
在插件目录下运行：
```bash
node bin/onboard.js
```
按照提示输入 WebSocket 地址和 Token 即可生成配置文件。

### 方式二：手动配置
编辑 `openclaw.json`：

```json
{
  "channels": {
    "qq": {
      "wsUrl": "ws://<ONEBOT_IP>:3001",
      "accessToken": "你的Token",
      "admins": [123456],
      "allowedGroups": [888888, 999999],
      "blockedUsers": [444444],
      "systemPrompt": "你是一个QQ机器人。",
      "autoApproveRequests": false,
      "enableErrorNotify": true,
      "formatMarkdown": true,
      "antiRiskMode": false,
      "maxMessageLength": 4000
    }
  },
  "plugins": {
    "entries": {
      "qq": { "enabled": true }
    }
  }
}
```

### 配置项说明

| 字段 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `wsUrl` | string | - | OneBot v11 WebSocket 地址 |
| `accessToken` | string | - | 连接鉴权 Token |
| `admins` | number[] | `[]` | 管理员 QQ 号列表 |
| `allowedGroups` | number[] | `[]` | 允许互动的群组白名单（为空则允许所有） |
| `blockedUsers` | number[] | `[]` | 黑名单用户列表 |
| `autoApproveRequests` | boolean | `false` | 是否自动通过好友/入群请求 |
| `enableErrorNotify` | boolean | `true` | 出错时是否发送提示消息 |
| `formatMarkdown` | boolean | `false` | 是否去除 Markdown 格式符号 |
| `antiRiskMode` | boolean | `false` | 是否开启风控规避（如 URL 加空格） |
| `maxMessageLength` | number | `4000` | 单条消息最大长度，超过自动分片 |

## 🛠 常见问题
- **无法获取历史消息**：请确认使用的 OneBot 客户端（如 NapCat/Go-CQHTTP）支持 `get_group_msg_history` API。
- **发送图片失败**：请检查 OneBot 服务端是否支持网络图片发送，或网络连接是否正常。