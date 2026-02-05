OpenClawd 是一个多功能代理。下面的聊天演示仅展示了最基础的功能。
<img width="1324" height="1000" alt="image" src="https://github.com/user-attachments/assets/00b0f347-be84-4fe0-94f2-456679d84f45" />
<img width="1687" height="1043" alt="PixPin_2026-01-29_16-09-58" src="https://github.com/user-attachments/assets/998a1d42-9566-4d20-8467-39dd1752a035" />
<img width="1380" height="710" alt="image" src="https://github.com/user-attachments/assets/9900b779-732a-4b3e-88a1-b10fe7d555c0" />

# OpenClaw QQ 插件 (OneBot v11)

本插件通过 OneBot v11 协议（WebSocket）为 [OpenClaw](https://github.com/openclaw/openclaw) 添加 QQ 频道支持。

## ✨ 功能特性

*   **多场景聊天**：完美支持私聊（C2C）和群聊（需 @机器人 或作为管理员）。
*   **多媒体支持**：支持发送图片、接收图片（最多 3 张），以及自动识别非图片文件链接并发送。
*   **消息去重**：内置消息去重机制，有效防止因网络波动导致的重复回复。
*   **输入状态模拟**：在 AI 处理回复时，通过智能延迟模拟人类输入节奏。
*   **交互式配置**：提供 `onboard` 脚本，引导完成配置生成。
*   **上下文注入**：支持配置自定义系统提示词 (System Prompt)，增强 AI 的角色扮演能力。
*   **管理员指令**：内置 `/status` (查看状态) 和 `/help` (帮助) 等管理指令。
*   **引用回复优化**：智能提取引用消息的内容，为 AI 提供完整的对话上下文。
*   **提及检测**：群聊中智能检测 @提及，支持配置是否强制要求提及。

---

## 📋 前置条件
你需要一个运行中的 OneBot v11 服务端，推荐：
- **[NapCat](https://github.com/NapCatQQ/NapCat-Docker)** (现代、对 Docker 友好)
- **Lagrange** 或 **Go-CQHTTP**

请确保在 OneBot 设置中开启了 **正向 WebSocket 服务**（通常端口为 3001）。

## 🚀 安装步骤

### 方案 A：源码 / 官方安装版
如果你是通过克隆仓库安装的 OpenClaw：

1. **进入扩展目录**：
   ```bash
   cd openclaw/extensions
   ```
2. **克隆此插件**：
   ```bash
   git clone https://github.com/constansino/openclaw_qq.git qq
   ```
3. **安装依赖并编译**：
   回到 OpenClaw 根目录执行：
   ```bash
   cd ..
   pnpm install
   pnpm build
   ```
4. **重启 OpenClaw**。

### 方案 B：Docker 安装（自定义构建）
如果你使用 Docker 且通过 `docker-compose.yml` 中的 `build` 指令运行：

1. 将 `openclaw_qq` 的文件放入构建上下文中的 `extensions/qq` 目录。
2. **重新构建镜像**：
   ```bash
   docker compose build openclaw-gateway
   ```
3. **重新启动容器**：
   ```bash
   docker compose up -d openclaw-gateway
   ```

## ⚙️ 配置方法

### 方式一：使用配置向导（推荐）
在插件目录下运行：
```bash
node bin/onboard.js
```
按照提示输入 WebSocket 地址和 Token 即可生成配置文件。

### 方式二：手动配置
编辑您的 `openclaw.json` 配置文件（通常位于 `~/.openclaw/openclaw.json`）：

```json
{
  "channels": {
    "qq": {
      "wsUrl": "ws://<ONEBOT_服务器_IP>:3001",
      "accessToken": "你的安全Token",
      "admins": [12345678, 87654321],
      "systemPrompt": "你现在是一个乐于助人的 QQ 机器人。",
      "requireMention": false,
      "enableDeduplication": true
    }
  },
  "plugins": {
    "entries": {
      "qq": {
        "enabled": true
      }
    }
  }
}
```

### 配置项说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `wsUrl` | string | 是 | - | OneBot v11 WebSocket 地址 (如 `ws://localhost:3001`) |
| `accessToken` | string | 否 | - | 连接 OneBot 的鉴权 Token |
| `admins` | number[] | 否 | `[]` | 管理员 QQ 号列表，配置后可使用 `/status` 等指令 |
| `requireMention` | boolean | 否 | `false` | 群聊是否必须 @机器人 才会回复 |
| `systemPrompt` | string | 否 | - | 注入到 AI 对话上下文的系统提示词 |
| `enableDeduplication` | boolean | 否 | `true` | 是否启用消息 ID 去重，防止重复回复 |

## 🛠 常见问题排除
- **502 Gateway Error**：通常表示 OpenClaw 崩溃了。请检查日志：`docker logs -f openclaw-gateway`。
- **Session Locked (会话锁死)**：如果机器人非正常退出，请删除配置目录下的锁文件：`find . -name "*.lock" -delete`。