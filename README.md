
OpenClawd 是一个多功能代理。下面的聊天演示仅展示了最基础的功能。
<img width="1324" height="1000" alt="image" src="https://github.com/user-attachments/assets/00b0f347-be84-4fe0-94f2-456679d84f45" />
<img width="1687" height="1043" alt="PixPin_2026-01-29_16-09-58" src="https://github.com/user-attachments/assets/998a1d42-9566-4d20-8467-39dd1752a035" />
<img width="1380" height="710" alt="image" src="https://github.com/user-attachments/assets/9900b779-732a-4b3e-88a1-b10fe7d555c0" />

# OpenClaw QQ 插件 (OneBot v11)

本插件通过 OneBot v11 协议（WebSocket）为 [OpenClaw](https://github.com/openclaw/openclaw) 添加 QQ 频道支持。具备生产级别的稳定性和丰富的功能特性，完全符合 OpenClaw 官方插件标准。

## ✨ 功能特性

### 🧠 智能对话与上下文
*   **历史回溯**：群聊自动获取最近 5 条历史消息，帮助 AI 理解前文。
*   **转发识别**：支持解析“合并转发”的聊天记录，AI 可以“读懂”转发的内容。
*   **系统提示词**：支持注入自定义 System Prompt 增强角色扮演。
*   **关键词触发**：支持配置关键词触发，无需 @ 即可唤醒 AI。

### 🛠 管理与安全
*   **群管指令**：管理员可通过 `/mute @用户 [分钟]`、`/kick @用户` 等指令直接管理群聊。
*   **黑白名单**：支持群组白名单 (`allowedGroups`) 和用户黑名单 (`blockedUsers`) 过滤。
*   **自动请求处理**：支持配置自动通过好友申请和群邀请。
*   **智能重连**：采用指数退避算法，避免异常时的连接风暴。
*   **消息去重**：防止网络抖动导致的重复回复。

### 🎭 深度交互体验
*   **戳一戳 (Poke)**：响应用户的“戳一戳”动作，支持 AI 趣味互动。
*   **自动 @回复**：群聊回复自动 @原发送者（仅分片首条），符合社交习惯。
*   **@昵称解析**：将消息中的 `[CQ:at]` 转换为真实昵称，让 AI 回复更拟人。
*   **语音输出 (TTS)**：可选开启 TTS，将 AI 的简短文字回复转换为语音发送（实验性）。
*   **多媒体感知**：全面支持图片（含 Base64 自动转换）、语音（含 STT 转文字）、视频、卡片消息。

### 🎨 格式与分片
*   **Markdown 优化**：自动将 Markdown 表格、列表转换为易读的 ASCII 排版。
*   **智能分片**：超长消息自动切分发送，且仅在首段保留回复引用。
*   **风控规避**：可选 URL 处理模式，降低被封概率。

---

## 📋 前置条件
你需要一个运行中的 OneBot v11 服务端（推荐 NapCat 或 Lagrange）。
**重要**：请确保 OneBot 配置中的 `message_post_format` 设置为 `array`。

## 🚀 安装与配置

### 1. 安装插件
```bash
cd openclaw/extensions
git clone https://github.com/constansino/openclaw_qq.git qq
cd ../..
pnpm install && pnpm build
```

### 2. 标准化配置 (推荐)
使用 OpenClaw 标准 CLI 命令进行交互式配置：
```bash
openclaw setup qq
```
按提示输入 WebSocket 地址（如 `ws://localhost:3001`）和 Token 即可。

### 3. 运行与监控
启动 OpenClaw 后，你可以使用以下标准命令：
*   **检查状态**：`openclaw status` (查看 Bot 在线状态、延迟)
*   **列出群组**：`openclaw list-groups --channel qq`
*   **发送消息**：`openclaw send qq <群号> "你好"`

### (备选) 手动配置 (`openclaw.json`)
```json
{
  "channels": {
    "qq": {
      "wsUrl": "ws://localhost:3001",
      "accessToken": "your_token",
      "admins": [123456],
      "allowedGroups": [888888],
      "blockedUsers": [444444],
      "historyLimit": 5,
      "keywordTriggers": ["小助手"],
      "systemPrompt": "你是一个有用的助手。",
      "enableTTS": false,
      "formatMarkdown": true,
      "antiRiskMode": false,
      "maxMessageLength": 4000
    }
  }
}
```

### 关键配置说明
| 字段 | 说明 |
| :--- | :--- |
| `historyLimit` | 注入 AI 上下文的历史消息条数（默认 5） |
| `keywordTriggers` | 触发机器人的关键词列表（群聊有效） |
| `enableTTS` | 是否将 AI 回复转为语音（需要服务端支持） |
| `autoApproveRequests` | 是否自动通过好友/群请求 |
| `allowedGroups` | 白名单群组 ID 列表（为空则全开） |

## 🛠 常见问题排除
- **指令无效**：请确保发送者在 `admins` 列表中。
- **获取历史失败**：部分 OneBot 服务端可能未开启历史记录接口。
- **本地图片发送失败**：插件会自动尝试将本地 `file://` 路径转换为 Base64 发送，确保 OneBot 能接收。
