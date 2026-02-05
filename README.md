
OpenClawd 是一个多功能代理。下面的聊天演示仅展示了最基础的功能。
<img width="1324" height="1000" alt="image" src="https://github.com/user-attachments/assets/00b0f347-be84-4fe0-94f2-456679d84f45" />
<img width="1687" height="1043" alt="PixPin_2026-01-29_16-09-58" src="https://github.com/user-attachments/assets/998a1d42-9566-4d20-8467-39dd1752a035" />
<img width="1380" height="710" alt="image" src="https://github.com/user-attachments/assets/9900b779-732a-4b3e-88a1-b10fe7d555c0" />

# OpenClaw QQ 插件 (OneBot v11)

本插件通过 OneBot v11 协议（WebSocket）为 [OpenClaw](https://github.com/openclaw/openclaw) 添加 QQ 频道支持。

## ✨ 功能特性

*   **多场景聊天**：完美支持私聊（C2C）和群聊（需 @机器人 或作为管理员）。
*   **多媒体支持**：
    *   **发送**：支持发送图片、文件。
    *   **接收**：支持接收图片（最多 3 张），自动识别语音、视频、卡片消息并转换为文本提示。
*   **智能消息处理**：
    *   **消息去重**：内置消息 ID 去重，防止网络波动导致的重复回复。
    *   **长消息分片**：自动将超长消息拆分为多条发送，防止被吞。
    *   **Markdown 优化**：可选将 Markdown 格式转换为适合 QQ 显示的纯文本。
    *   **风控规避**：可选对 URL 进行特殊处理（如加空格），降低被封概率。
*   **自动化管理**：
    *   **请求处理**：支持配置自动通过好友/群组邀请请求。
    *   **信息同步**：启动时自动同步 Bot 昵称和头像信息。
*   **交互体验**：
    *   **输入模拟**：模拟人类输入节奏。
    *   **错误反馈**：服务调用失败时自动提示用户。
    *   **消息撤回**：支持 AI 撤回发送的不当消息。
*   **上下文注入**：支持配置自定义系统提示词 (System Prompt)。
*   **管理员指令**：内置 `/status` 和 `/help` 指令。

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
| `autoApproveRequests` | boolean | `false` | 是否自动通过好友/入群请求 |
| `enableErrorNotify` | boolean | `true` | 出错时是否发送提示消息 |
| `formatMarkdown` | boolean | `false` | 是否去除 Markdown 格式符号 |
| `antiRiskMode` | boolean | `false` | 是否开启风控规避（如 URL 加空格） |
| `maxMessageLength` | number | `4000` | 单条消息最大长度，超过自动分片 |
| `enableDeduplication` | boolean | `true` | 是否启用消息去重 |

## 🛠 常见问题
- **无法收到群消息**：请检查 OneBot 是否开启了群消息上报，以及 `requireMention` 配置。
- **发送图片失败**：请检查 OneBot 服务端是否支持网络图片发送，或网络连接是否正常。
