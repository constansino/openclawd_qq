# NapCat Docker for OpenClaw QQ

## 启动

```bash
cd openclaw_qq/deploy/napcat
docker compose up -d
```

## 首次登录

1. 打开 `http://127.0.0.1:6099/webui`。
2. 扫码登录 QQ。
3. 在 OneBot WebSocket 配置中确认：
   - 正向 WS 端口：`3001`
   - Access Token：与 `.env` 里的 `NAPCAT_WS_TOKEN` 一致
   - `message_post_format`: `array`

## 与 OpenClaw 对齐

OpenClaw 已写入：

- `channels.qq.wsUrl = ws://127.0.0.1:3001`
- `channels.qq.accessToken = NAPCAT_WS_TOKEN`

如果你改了 Token，记得同步修改 `~/.openclaw/openclaw.json` 中的 `channels.qq.accessToken`。
