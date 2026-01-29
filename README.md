# Moltbot QQ Plugin (OneBot v11)

This is a standalone QQ channel extension for [Moltbot](https://github.com/moltbot/moltbot) using the OneBot v11 protocol.

---

<details>
<summary><b>English Description</b></summary>

## Overview
This plugin enables Moltbot to communicate via QQ. It uses the OneBot v11 protocol, making it compatible with popular implementations like NapCat, Lagrange, or Go-CQHTTP.

## Features
- Receive and send text messages.
- Receive and send image messages (via CQ codes).
- Support for private and group chats.
- Integrated with Moltbot's auto-reply and agent systems.

## Installation
1. Navigate to your Moltbot repository's `extensions` directory.
2. Clone this repository:
   ```bash
   git clone https://github.com/constansino/moltbot_qq.git qq
   ```
3. Ensure the folder is named `qq` inside `extensions/`.

## Configuration
Add the following to your `clawdbot.json`:

```json
{
  "channels": {
    "qq": {
      "wsUrl": "ws://127.0.0.1:3001",
      "accessToken": "your_secure_token"
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
*Note: Set `wsUrl` to your OneBot WebSocket server address.*

</details>

---

<details>
<summary><b>中文说明</b></summary>

## 概览
这是一个为 [Moltbot](https://github.com/moltbot/moltbot) 开发的独立 QQ 频道扩展。它使用 OneBot v11 协议，兼容 NapCat、Lagrange 或 Go-CQHTTP 等主流实现。

## 功能
- 接收和发送文本消息。
- 接收和发送图片消息（通过 CQ 码）。
- 支持私聊和群聊。
- 深度集成 Moltbot 的自动回复和 Agent 系统。

## 安装步骤
1. 进入您的 Moltbot 仓库的 `extensions` 目录。
2. 克隆此仓库：
   ```bash
   git clone https://github.com/constansino/moltbot_qq.git qq
   ```
3. 确保 `extensions/` 目录下的文件夹名称为 `qq`。

## 配置
在您的 `clawdbot.json` 中添加以下配置：

```json
{
  "channels": {
    "qq": {
      "wsUrl": "ws://127.0.0.1:3001",
      "accessToken": "你的安全Token"
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
*注意：请将 `wsUrl` 设置为您的 OneBot WebSocket 服务器地址。*

</details>
