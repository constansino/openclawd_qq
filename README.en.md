OpenClawd is a multi-purpose agent. The chat demo below only shows the most basic capabilities.
# OpenClaw QQ Plugin (OneBot v11)

This plugin adds full-featured QQ channel support to [OpenClaw](https://github.com/openclaw/openclaw) via the OneBot v11 protocol (WebSocket). It supports not only basic chat, but also group administration, QQ Guild channels, multimodal interaction, and production-grade risk controls.

## ✨ Core Features

### 🧠 Deep Intelligence & Context
* **History Backtracking (Context)**: Optionally fetch the latest N messages in group chats (default: `0`, no extra injection), for scenarios where you need to forcibly preserve raw historical context.
* **System Prompt**: Inject custom prompts so the bot can play specific roles (for example, a “catgirl” or a “strict admin”).
* **Forwarded Message Understanding**: The AI can parse and read merged-forwarded chat records sent by users, handling complex information.
* **Keyword Wake-up**: In addition to @mentions, you can configure specific keywords (for example, “assistant”) to trigger conversation.

### 🛡️ Powerful Management & Risk Control
* **Self-healing Connection**: Built-in heartbeat detection plus exponential backoff reconnection can auto-detect and recover “zombie connections” for 24/7 uptime.
* **Group Moderation Commands**: Admins can use commands directly in QQ to manage members (mute/kick).
* **Allow/Block Lists**:
  * **Group Allowlist**: Reply only in specified groups to avoid spam/ad groups.
  * **User Blocklist**: Block harassment from malicious users.
* **Automatic Request Handling**: Optionally auto-approve friend requests and group invites for unattended operation.
* **Production-grade Risk Control**:
  * **@mention Trigger by Default**: `requireMention` is enabled by default; the bot only replies when mentioned, reducing token spend and noise.
  * **Rate Limiting**: Automatically inserts random delays when sending multiple messages to reduce QQ anti-spam risk.
  * **URL Evasion**: Automatically processes links (for example, inserting spaces) to reduce the chance of message suppression.
  * **System Account Filtering**: Automatically ignores interference from QQ system accounts (for example, QQ Butler).

### 🎭 Rich Interaction Experience
* **Poke**: When a user pokes the bot, the AI can detect it and respond in a fun way.
* **Human-like Replies**:
  * **Auto @mention**: In group replies, automatically @mentions the original sender (first segment only), matching human social norms.
  * **Nickname Resolution**: Converts `[CQ:at]` codes to real nicknames (for example, `@ZhangSan`) so replies feel more natural.
* **Multimodal Support**:
  * **Images**: Supports sending and receiving images. Optimized for `base64://` so it works even when the bot and OneBot server are not in the same LAN.
  * **Voice**: Receives voice messages (requires server-side STT support) and can optionally send TTS voice replies.
  * **Files**: Supports file send/receive in groups and private chats.
* **QQ Guild Channels**: Native support for QQ Guild message send/receive.

---

## 📋 Prerequisites

1. **OpenClaw**: OpenClaw main program is installed and running.
2. **OneBot v11 Server**: You need a running OneBot v11 implementation.
   * Recommended: **[NapCat (Docker)](https://github.com/NapCatQQ/NapCat-Docker)** or **Lagrange**.
   * **Important**: In OneBot config, set `message_post_format` to `array`, otherwise multimedia parsing will fail.
   * Network: make sure forward WebSocket service is enabled (usually port `3001`).

---

## 🚀 Installation

### Method 1: OpenClaw CLI (Recommended)
If your OpenClaw version supports plugin marketplace or CLI install:
```bash
# Enter extension directory
cd openclaw/extensions
# Clone repository
git clone https://github.com/constansino/openclaw_qq.git qq
# Install deps and build
cd ../..
pnpm install && pnpm build
```

### Method 2: Docker Integration
In your `docker-compose.yml` or `Dockerfile`, copy this plugin code into `/app/extensions/qq`, then rebuild the image.

---

## ⚙️ Configuration

### 1. Quick Setup (CLI Onboarding)
The plugin includes an interactive setup script to quickly generate config.
Run in plugin directory (`openclaw/extensions/qq`):

```bash
node bin/onboard.js
```
Follow prompts to enter WebSocket URL (for example, `ws://localhost:3001`), token, and admin QQ IDs.

### 2. Standard Setup (OpenClaw Setup)
If integrated into OpenClaw CLI, run:
```bash
openclaw setup qq
```

### 3. Manual Configuration (`openclaw.json`)
You can also edit config directly. Full config example:

```json
{
  "channels": {
    "qq": {
      "wsUrl": "ws://127.0.0.1:3001",
      "accessToken": "YourToken",
      "admins": "12345678,87654321",
      "adminOnlyChat": false,
      "notifyNonAdminBlocked": false,
      "nonAdminBlockedMessage": "Only admins can trigger this bot currently.\nPlease contact an administrator if you need access.",
      "blockedNotifyCooldownMs": 10000,
      "allowedGroups": "10001,10002",
      "blockedUsers": "999999",
      "systemPrompt": "You are a QQ bot named 'Artificial Dummy', with a witty and humorous speaking style.",
      "historyLimit": 0,
      "keywordTriggers": "assistant, help",
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

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `wsUrl` | string | **Required** | OneBot v11 WebSocket URL |
| `accessToken` | string | - | Connection auth token |
| `admins` | string | `""` | **Admin QQ ID list (string)**. In Web form: `1838552185,123456789`; in Raw JSON: `"1838552185,123456789"`. Used for admin command permissions like `/status`, `/kick`. |
| `adminOnlyChat` | boolean | `false` | **Only admins can trigger chat replies**. When enabled, non-admins cannot trigger conversations even if they @mention the bot (useful to prevent token abuse). |
| `notifyNonAdminBlocked` | boolean | `false` | When `adminOnlyChat=true` and a non-admin triggers, whether to send a rejection notice. |
| `nonAdminBlockedMessage` | string | `Only admins can trigger this bot currently.\nPlease contact an administrator if you need access.` | Rejection message shown to blocked non-admin users. |
| `blockedNotifyCooldownMs` | number | `10000` | Cooldown (ms) for non-admin rejection notices. Prevents repeated notices within the same session/user target. |
| `requireMention` | boolean | `true` | **Group trigger gate**. `true` = trigger only on @mention / reply-to-bot / keyword hit; `false` = normal group messages may also trigger (not recommended for long-term use). |
| `allowedGroups` | string | `""` | **Group allowlist (string)**. In Web form: `883766069 123456789`; in Raw JSON: `"883766069 123456789"`. If set, bot only replies in listed groups. |
| `blockedUsers` | string | `""` | **User blocklist (string)**. In Web form: `342571216` or `342571216,10002`; in Raw JSON: `"342571216"`. Bot ignores messages from these users. |
| `systemPrompt` | string | - | **Persona/system role prompt** injected into AI context. |
| `historyLimit` | number | `0` | **Number of historical messages to inject**. Default relies on OpenClaw session system; set `>0` only when you explicitly need to force raw group history into each turn. |

> Recommendation: keep `historyLimit = 0` by default. This aligns better with Telegram channel behavior and reduces redundant context injection and log noise.
> Only enable `historyLimit` (for example `3~5`) when you explicitly want to append recent raw group messages on every turn.
>
> Security recommendation: if you worry about heavy token usage from frequent group @mentions, configure `admins` and enable `adminOnlyChat = true`.

| `keywordTriggers` | string | `""` | **Keyword trigger list (string)**. In Web form: `assistant, help me`; in Raw JSON: `"assistant, help me"`. When `requireMention=true`, keyword hits can trigger without @mention; when `requireMention=false`, keywords are not required to trigger. |
| `autoApproveRequests` | boolean | `false` | Whether to auto-approve friend requests and group invites. |
| `enableGuilds` | boolean | `true` | Whether to enable QQ Guild support. |
| `enableTTS` | boolean | `false` | (Experimental) Whether to convert AI replies into voice (requires server-side TTS support). |
| `rateLimitMs` | number | `1000` | **Send rate limit**. Delay in ms between multiple segments; `1000` is recommended for anti-risk control. |
| `formatMarkdown` | boolean | `false` | Whether to convert Markdown tables/lists to readable plain-text formatting for QQ. |
| `antiRiskMode` | boolean | `false` | Whether to enable anti-risk formatting (for example, adding spaces in URLs). |
| `maxMessageLength` | number | `4000` | Max length per message. Longer output is auto-split. |

---

## 🎮 Usage Guide

### 🗣️ Basic Chat
* **Private Chat**: Just send messages directly to the bot.
* **Group Chat**:
  * `@bot` + message.
  * Reply to a bot message.
  * Send messages containing configured **keywords** (for example, `assistant`).
  * **Poke** the bot avatar.

### 🧭 Trigger Rules Quick Reference (Important)

Pay close attention to the combination of `requireMention` and `keywordTriggers`:

- `requireMention=true` + empty `keywordTriggers`:
  - Trigger only on **@mention** or **reply-to-bot**.
- `requireMention=true` + non-empty `keywordTriggers`:
  - Trigger on **@mention / reply-to-bot / keyword hit** (any one).
- `requireMention=false` (with or without keywords):
  - Normal group messages may trigger; keywords are no longer a required condition.

> If you want "no @mention needed, but wake-word required", use:
>
> - `requireMention=true`
> - `keywordTriggers="yezi"` (or multiple keywords)

### 👮‍♂️ Admin Commands
Only users listed in `admins` can use:

* `/status`
  * View bot runtime status (memory usage, connection status, self ID).
* `/help`
  * Show help menu.
* `/mute @user [minutes]` (group only)
  * Mute the specified user. Defaults to 30 minutes if omitted.
  * Example: `/mute @ZhangSan 10`
* `/kick @user` (group only)
  * Remove the specified user from the group.

### 💻 CLI Usage
If you operate OpenClaw from a server terminal, use these standard commands:

1. **Check status**
   ```bash
   openclaw status
   ```
   Shows QQ connection status, latency, and current bot nickname.

2. **List groups/channels**
   ```bash
   openclaw list-groups --channel qq
   ```
   Lists all joined groups and channel IDs.

3. **Send messages proactively**
   ```bash
   # Send private message
   openclaw send qq 12345678 "Hello, this is a test message"

   # Send group message (use group: prefix)
   openclaw send qq group:88888888 "Hello everyone"

   # Send guild channel message
   openclaw send qq guild:GUILD_ID:CHANNEL_ID "Channel message"
   ```

### 🔐 Recommended Admin/Blocklist Setup (Anti-abuse)

If you want only specific QQ IDs to trigger the bot (especially in groups), use this setup:

1. **Set admins (allowed to trigger chat)**
   ```bash
   openclaw config set channels.qq.admins '"1838552185,123456789"' --json
   ```

2. **Enable admin-only chat triggering**
   ```bash
   openclaw config set channels.qq.adminOnlyChat true --json
   ```

3. **(Optional) Notify blocked non-admins + debounce**
   ```bash
   openclaw config set channels.qq.notifyNonAdminBlocked true --json
   openclaw config set channels.qq.nonAdminBlockedMessage '"Only admins can trigger this bot currently."' --json
   openclaw config set channels.qq.blockedNotifyCooldownMs 10000 --json
   ```

4. **Set blocklist (silently ignore, no reply)**
   ```bash
   openclaw config set channels.qq.blockedUsers '"342571216,10002"' --json
   ```

5. **Restart gateway to apply**
   ```bash
   openclaw gateway restart
   ```

> Note: `admins` / `blockedUsers` are stored as **string lists** in this plugin. For CLI, always use the `--json` form above.
>
> In Web config form, you can directly enter: `1838552185,123456789` (no manual quotes required). In Raw JSON mode, enter: `"1838552185,123456789"`.

### ⚠️ About `invalid config` errors on `/config`

If you edit QQ settings in OpenClaw Web UI and see errors pointing to `models.providers.*.models[].maxTokens`, that is an **OpenClaw Core full-payload validation path issue**, not QQ plugin business logic.

Related tracking (English):

- Issue: https://github.com/openclaw/openclaw/issues/13959
- PR: https://github.com/openclaw/openclaw/pull/13960

Before upstream merges the fix, prefer the CLI commands above for `channels.qq.*` updates to avoid most Web form serialization/validation noise.

---

## ❓ FAQ

**Q: Why does installation fail with `openclaw @workspace:* not found`?**
A: This was caused by workspace protocol settings in the parent environment. It is fixed in the latest version. Run `git pull`, then use `pnpm install` or `npm install` directly.

**Q: Why doesn’t the bot respond to images?**
A:
1. Confirm your OneBot implementation (for example NapCat) has image reporting enabled.
2. It is recommended to enable “image to Base64” in OneBot config, so even if OpenClaw runs on a public cloud server, it can still receive images from local/private networks.
3. The plugin now auto-detects and extracts images; `message_post_format: array` is no longer strictly required for image extraction.

**Q: Can this work when bot and OneBot are not in the same network (not LAN)?**
A: **Yes.** As long as `wsUrl` is reachable via tunnel/public IP and images are transmitted via Base64, cross-region deployment works.

**Q: Why no replies in group chat?**
A:
1. Check whether `requireMention` is enabled (enabled by default): you must @mention the bot.
2. Check whether the group is included in `allowedGroups` (if set).
3. Check OneBot logs to confirm events are being delivered.

**Q: Why did the bot reply even without @mention and without wake word?**
A: Most likely `requireMention` is set to `false`. In that mode, normal group messages may trigger. If you want "non-@mention must include wake word", set:

1. `requireMention=true`
2. Put your wake word in `keywordTriggers` (for example, `yezi`)

**Q: Why do QQ request logs include prior chat text/history?**
A: That is controlled by `historyLimit`. Current default is `0`, meaning no extra group-history injection; context is mainly managed by OpenClaw session system (closer to Telegram behavior).
If you set `historyLimit > 0`, the plugin appends recent raw group messages on each group request.

## 🆕 Recent Improvements

* Fixed `admins` logic: `admins` now controls admin-command permissions only and no longer blocks normal group messages.
* Optimized session routing: QQ sessions now use the standard router, reducing session misalignment/confusion in Console/WebUI.
* Reduced context noise: `historyLimit` default changed to `0`, relying on session system by default instead of repeatedly injecting raw history.

**Q: How to enable bot voice (TTS)?**
A: Set `enableTTS` to `true`. Note this depends on OneBot server-side TTS support. NapCat/Lagrange support may be limited and could require extra plugin support.

---

## 🆚 Feature Differences vs Telegram Plugin

If you are used to OpenClaw Telegram plugin, here are the major experience differences in `openclaw_qq`:

| Feature | QQ Plugin (openclaw_qq) | Telegram Plugin | Difference Notes |
| :--- | :--- | :--- | :--- |
| **Message Formatting** | **Plain text** | **Native Markdown** | QQ does not support rich markdown formatting; plugin auto-converts output format. |
| **Streaming Output** | ❌ Not supported | ✅ Supported | TG can show live typing/streaming; QQ waits and sends full output after completion. |
| **Message Editing** | ❌ Not supported | ✅ Supported | TG can edit sent content; QQ cannot edit after send (only recall). |
| **Interactive Buttons** | ❌ Not yet | ✅ Supported | TG supports inline buttons; QQ currently relies on text commands. |
| **Risk Control Level** | 🔴 **Very high** | 🟢 **Very low** | QQ is much easier to rate-limit/flag; plugin includes built-in segmented send throttling. |
| **Poke Interaction** | ✅ **Supported** | ❌ Not supported | QQ-specific social interaction that AI can detect/respond to. |
| **Forwarded Message Parsing** | ✅ **Deep support** | ❌ Basic support | QQ plugin has dedicated optimization for merged-forwarded chat parsing. |
