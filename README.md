
OpenClawd 是一个多功能代理。下面的聊天演示仅展示了最基础的功能。
# OpenClaw QQ 插件 (OneBot v11)

本插件通过 OneBot v11 协议（WebSocket）为 [OpenClaw](https://github.com/openclaw/openclaw) 添加全功能的 QQ 频道支持。它不仅支持基础聊天，还集成了群管、频道、多模态交互和生产级风控能力。

## ✨ 核心特性

### 🧠 深度智能与上下文
*   **历史回溯 (Context)**：可选在群聊中获取最近 N 条历史消息（默认 0，不额外注入），用于需要“强制保留上下文原文”的场景。
*   **系统提示词 (System Prompt)**：支持注入自定义提示词，让 Bot 扮演特定角色（如“猫娘”、“严厉的管理员”）。
*   **转发消息理解**：AI 能够解析并读取用户发送的合并转发聊天记录，处理复杂信息。
*   **关键词唤醒**：除了 @机器人，支持配置特定的关键词（如“小助手”）来触发对话。

### 🛡️ 强大的管理与风控
*   **连接自愈**：内置心跳检测与重连指数退避机制，能自动识别并修复“僵尸连接”，确保 7x24 小时在线。
*   **群管指令**：管理员可直接在 QQ 中使用指令管理群成员（禁言/踢出）。
*   **黑白名单**：
    *   **群组白名单**：只在指定的群组中响应，避免被拉入广告群。
    *   **用户黑名单**：屏蔽恶意用户的骚扰。
*   **自动请求处理**：可配置自动通过好友申请和入群邀请，实现无人值守运营。
*   **生产级风控**：
    *   **默认 @ 触发**：默认开启 `requireMention`，仅在被 @ 时回复，保护 Token 并不打扰他人。
    *   **速率限制**：发送多条消息时自动插入随机延迟，防止被 QQ 风控禁言。
    *   **URL 规避**：自动对链接进行处理（如加空格），降低被系统吞消息的概率。
    *   **系统号屏蔽**：自动过滤 QQ 管家等系统账号的干扰。

### 🎭 丰富的交互体验
*   **戳一戳 (Poke)**：当用户“戳一戳”机器人时，AI 会感知到并做出有趣的回应。
*   **拟人化回复**：
    *   **自动 @**：在群聊回复时，自动 @原发送者（仅在第一段消息），符合人类社交礼仪。
    *   **昵称解析**：将消息中的 `[CQ:at]` 代码转换为真实昵称（如 `@张三`），AI 回复更自然。
*   **多模态支持**：
    *   **图片**：支持收发图片。优化了对 `base64://` 格式的支持，即使 Bot 与 OneBot 服务端不在同一局域网也可正常交互。
    *   **语音**：接收语音消息（需服务端支持 STT）并可选开启 TTS 语音回复。
    *   **文件**：支持群文件和私聊文件的收发。
*   **QQ 频道 (Guild)**：原生支持 QQ 频道消息收发。

---

## 📋 前置条件

1.  **OpenClaw**：已安装并运行 OpenClaw 主程序。
2.  **OneBot v11 服务端**：你需要一个运行中的 OneBot v11 实现。
    *   推荐：**[NapCat (Docker)](https://github.com/NapCatQQ/NapCat-Docker)** 或 **Lagrange**。
    *   **重要配置**：请务必在 OneBot 配置中将 `message_post_format` 设置为 `array`（数组格式），否则无法解析多媒体消息。
    *   网络：确保开启了正向 WebSocket 服务（通常端口为 3001）。

---

## 🚀 安装指南

### 方法 1: 使用 OpenClaw CLI (推荐)
如果你的 OpenClaw 版本支持插件市场或 CLI 安装：
```bash
# 进入插件目录
cd openclaw/extensions
# 克隆仓库
git clone https://github.com/constansino/openclaw_qq.git qq
# 安装依赖并构建
cd ../..
pnpm install && pnpm build
```

### 方法 2: Docker 集成
在你的 `docker-compose.yml` 或 `Dockerfile` 中，将本插件代码复制到 `/app/extensions/qq` 目录，然后重新构建镜像。

---

## ⚙️ 配置说明

### 1. 快速配置 (CLI 向导)
插件内置了交互式配置脚本，助你快速生成配置文件。
在插件目录 (`openclaw/extensions/qq`) 下运行：

```bash
node bin/onboard.js
```
按照提示输入 WebSocket 地址（如 `ws://localhost:3001`）、Token 和管理员 QQ 号即可。

### 2. 标准化配置 (OpenClaw Setup)
如果已集成到 OpenClaw CLI，可运行：
```bash
openclaw setup qq
```

### 3. 手动配置详解 (`openclaw.json`)
你也可以直接编辑配置文件。以下是完整配置清单：

```json
{
  "channels": {
    "qq": {
      "wsUrl": "ws://127.0.0.1:3001",
      "accessToken": "你的Token",
      "admins": "12345678,87654321",
      "adminOnlyChat": false,
      "notifyNonAdminBlocked": false,
      "nonAdminBlockedMessage": "当前仅管理员可触发机器人。\n如需使用请联系管理员。",
      "blockedNotifyCooldownMs": 10000,
      "allowedGroups": "10001,10002",
      "blockedUsers": "999999",
      "systemPrompt": "你是一个名为“人工智障”的QQ机器人，说话风格要风趣幽默。",
      "historyLimit": 0,
      "keywordTriggers": ["小助手", "帮助"],
      "autoApproveRequests": true,
      "enableGuilds": true,
      "enableTTS": false,
      "rateLimitMs": 1000,
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

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `wsUrl` | string | **必填** | OneBot v11 WebSocket 地址 |
| `accessToken` | string | - | 连接鉴权 Token |
| `admins` | string | `""` | **管理员 QQ 号列表**（逗号/空格/换行分隔）。用于 `/status`, `/kick` 等管理员指令权限。 |
| `adminOnlyChat` | boolean | `false` | **仅管理员可触发聊天回复**。开启后，非管理员即使 @ 机器人也不会触发对话（适合防止 Token 被刷）。 |
| `notifyNonAdminBlocked` | boolean | `false` | 当 `adminOnlyChat=true` 且被非管理员触发时，是否发送提示消息。 |
| `nonAdminBlockedMessage` | string | `当前仅管理员可触发机器人。\n如需使用请联系管理员。` | 非管理员被拦截时的提示文案。 |
| `blockedNotifyCooldownMs` | number | `10000` | 非管理员提示防抖（毫秒）。同一用户在同一会话内重复触发时，冷却期内不重复提示。 |
| `requireMention` | boolean | `true` | **是否需要 @ 触发**。设为 `true` 仅在被 @ 或回复机器人时响应。 |
| `allowedGroups` | string | `""` | **群组白名单**（逗号/空格/换行分隔）。若设置，Bot 仅在这些群组响应。 |
| `blockedUsers` | string | `""` | **用户黑名单**（逗号/空格/换行分隔）。Bot 将忽略这些用户的消息。 |
| `systemPrompt` | string | - | **人设设定**。注入到 AI 上下文的系统提示词。 |
| `historyLimit` | number | `0` | **历史消息条数**。默认依赖 OpenClaw 会话系统管理上下文；仅在你需要强制携带群内最近原文时才建议设为 `>0`。 |

> 推荐：默认保持 `historyLimit = 0`。这与 Telegram 通道行为更一致，能减少重复上下文注入和日志噪音。
> 仅当你明确希望每轮都附带“群内原始近几条消息”时，再开启 `historyLimit`（例如设为 `3~5`）。
>
> 安全建议：若你担心群内高频 @ 导致 Token 消耗过快，建议配置 `admins` 并开启 `adminOnlyChat = true`。
| `keywordTriggers` | string[] | `[]` | **关键词触发**。群聊中无需 @，包含这些词也会触发回复。 |
| `autoApproveRequests` | boolean | `false` | 是否自动通过好友申请和群邀请。 |
| `enableGuilds` | boolean | `true` | 是否开启 QQ 频道 (Guild) 支持。 |
| `enableTTS` | boolean | `false` | (实验性) 是否将 AI 回复转为语音发送 (需服务端支持 TTS)。 |
| `rateLimitMs` | number | `1000` | **发送限速**。多条消息间的延迟(毫秒)，建议设为 1000 以防风控。 |
| `formatMarkdown` | boolean | `false` | 是否将 Markdown 表格/列表转换为易读的纯文本排版。 |
| `antiRiskMode` | boolean | `false` | 是否开启风控规避（如给 URL 加空格）。 |
| `maxMessageLength` | number | `4000` | 单条消息最大长度，超过将自动分片发送。 |

---

## 🎮 使用指南

### 🗣️ 基础聊天
*   **私聊**：直接发送消息给机器人即可。
*   **群聊**：
    *   **@机器人** + 消息。
    *   回复机器人的消息。
    *   发送包含**关键词**（如配置中的“小助手”）的消息。
    *   **戳一戳**机器人头像。

### 👮‍♂️ 管理员指令
仅配置在 `admins` 列表中的用户可用：

*   `/status`
    *   查看机器人运行状态（内存占用、连接状态、Self ID）。
*   `/help`
    *   显示帮助菜单。
*   `/mute @用户 [分钟]` (仅群聊)
    *   禁言指定用户。不填时间默认 30 分钟。
    *   示例：`/mute @张三 10`
*   `/kick @用户` (仅群聊)
    *   将指定用户移出群聊。

### 💻 CLI 命令行使用
如果你在服务器终端操作 OpenClaw，可以使用以下标准命令：

1.  **查看状态**
    ```bash
    openclaw status
    ```
    显示 QQ 连接状态、延迟及当前 Bot 昵称。

2.  **列出群组/频道**
    ```bash
    openclaw list-groups --channel qq
    ```
    列出所有已加入的群聊和频道 ID。

3.  **主动发送消息**
    ```bash
    # 发送私聊
    openclaw send qq 12345678 "你好，这是测试消息"
    
    # 发送群聊 (使用 group: 前缀)
    openclaw send qq group:88888888 "大家好"
    
    # 发送频道消息
    openclaw send qq guild:GUILD_ID:CHANNEL_ID "频道消息"
    ```

---

## ❓ 常见问题 (FAQ)

**Q: 安装依赖时报错 `openclaw @workspace:*` 找不到？**
A: 这是因为主仓库的 workspace 协议导致的。我们已在最新版本中将其修复，请执行 `git pull` 后直接使用 `pnpm install` 或 `npm install` 即可，无需特殊环境。

**Q: 给机器人发图片它没反应？**
A: 
1. 确认你使用的 OneBot 实现（如 NapCat）开启了图片上报。
2. 建议在 OneBot 配置中开启“图片转 Base64”，这样即使你的 OpenClaw 在公网云服务器上，也能正常接收本地内网机器人的图片。
3. 插件现在会自动识别并提取图片，不再强制要求开启 `message_post_format: array`。

**Q: 机器人与 OneBot 不在同一个网络环境（非局域网）能用吗？**
A: **完全可以**。只要 `wsUrl` 能够通过内网穿透或公网 IP 访问到，且图片通过 Base64 传输，即可实现跨地域部署。

**Q: 为什么群聊不回话？**
A: 
1. 检查 `requireMention` 是否开启（默认开启），需要 @机器人。
2. 检查群组是否在 `allowedGroups` 白名单内（如果设置了的话）。
3. 检查 OneBot 日志，确认消息是否已上报。

**Q: QQ 日志里为什么会看到“带历史内容”的请求体？**
A: 这是 `historyLimit` 的行为。当前版本默认 `0`，即不额外拼接群历史，主要依赖 OpenClaw 会话系统管理上下文（更接近 Telegram 行为）。
如果你把 `historyLimit` 设为 `>0`，插件会在每次群聊请求里附加最近 N 条原文消息。

## 🆕 近期改进

*   修复 `admins` 逻辑：`admins` 现在仅控制管理员指令权限，不再拦截普通群消息。
*   优化会话路由：QQ 会话改为标准路由器管理，减少在控制台/WebUI中的会话错位与混淆。
*   降低上下文噪音：`historyLimit` 默认改为 `0`，默认依赖会话系统，不重复注入历史原文。

**Q: 如何让 Bot 说话（TTS）？**
A: 将 `enableTTS` 设为 `true`。注意：这取决于 OneBot 服务端是否支持 TTS 转换。通常 NapCat/Lagrange 对此支持有限，可能需要额外插件。

---

## 🆚 与 Telegram 插件的功能区别

如果您习惯使用 OpenClaw 的 Telegram 插件，以下是 `openclaw_qq` 在体验上的主要差异：

| 功能特性 | QQ 插件 (openclaw_qq) | Telegram 插件 | 体验差异说明 |
| :--- | :--- | :--- | :--- |
| **消息排版** | **纯文本** | **原生 Markdown** | QQ 不支持加粗、代码块高亮，插件会自动转换排版。 |
| **流式输出** | ❌ 不支持 | ✅ 支持 | TG 可实时看到 AI 打字；QQ 需等待 AI 生成完毕后整段发送。 |
| **消息编辑** | ❌ 不支持 | ✅ 支持 | TG 可修改已发内容；QQ 发送后无法修改，只能撤回。 |
| **交互按钮** | ❌ 暂不支持 | ✅ 支持 | TG 消息下方可带按钮；QQ 目前完全依靠文本指令。 |
| **风控等级** | 🔴 **极高** | 🟢 **极低** | QQ 极易因回复过快或敏感词封号，插件已内置分片限速。 |
| **戳一戳** | ✅ **特色支持** | ❌ 不支持 | QQ 特有的社交互动，AI 可感知并回应。 |
| **转发消息** | ✅ **深度支持** | ❌ 基础支持 | QQ 插件专门优化了对“合并转发”聊天记录的解析。 |
