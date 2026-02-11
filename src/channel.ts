import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChannelPlugin,
  type ChannelAccountSnapshot,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type ReplyPayload,
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "openclaw/plugin-sdk";
import { OneBotClient } from "./client.js";
import { QQConfigSchema, type QQConfig } from "./config.js";
import { getQQRuntime } from "./runtime.js";
import type { OneBotMessage, OneBotMessageSegment } from "./types.js";

export type ResolvedQQAccount = ChannelAccountSnapshot & {
  config: QQConfig;
  client?: OneBotClient;
};

const memberCache = new Map<string, { name: string, time: number }>();

function getCachedMemberName(groupId: string, userId: string): string | null {
    const key = `${groupId}:${userId}`;
    const cached = memberCache.get(key);
    if (cached && Date.now() - cached.time < 3600000) { // 1 hour cache
        return cached.name;
    }
    return null;
}

function setCachedMemberName(groupId: string, userId: string, name: string) {
    memberCache.set(`${groupId}:${userId}`, { name, time: Date.now() });
}

function extractImageUrls(message: OneBotMessage | string | undefined, maxImages = 3): string[] {
  const urls: string[] = [];
  
  if (Array.isArray(message)) {
    for (const segment of message) {
      if (segment.type === "image") {
        const url = segment.data?.url || (typeof segment.data?.file === 'string' && (segment.data.file.startsWith('http') || segment.data.file.startsWith('base64://')) ? segment.data.file : undefined);
        if (url) {
          urls.push(url);
          if (urls.length >= maxImages) break;
        }
      }
    }
  } else if (typeof message === "string") {
    const imageRegex = /\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)[^\]]*\]/g;
    let match;
    while ((match = imageRegex.exec(message)) !== null) {
      const val = match[1].replace(/&amp;/g, "&");
      if (val.startsWith("http") || val.startsWith("base64://")) {
        urls.push(val);
        if (urls.length >= maxImages) break;
      }
    }
  }
  
  return urls;
}

function cleanCQCodes(text: string | undefined): string {
  if (!text) return "";
  
  let result = text;
  const imageUrls: string[] = [];
  
  // Match both url= and file= if they look like URLs
  const imageRegex = /\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)[^\]]*\]/g;
  let match;
  while ((match = imageRegex.exec(text)) !== null) {
    const val = match[1].replace(/&amp;/g, "&");
    if (val.startsWith("http")) {
      imageUrls.push(val);
    }
  }

  result = result.replace(/\[CQ:face,id=(\d+)\]/g, "[表情]");
  
  result = result.replace(/\[CQ:[^\]]+\]/g, (match) => {
    if (match.startsWith("[CQ:image")) {
      return "[图片]";
    }
    return "";
  });
  
  result = result.replace(/\s+/g, " ").trim();
  
  if (imageUrls.length > 0) {
    result = result ? `${result} [图片: ${imageUrls.join(", ")}]` : `[图片: ${imageUrls.join(", ")}]`;
  }
  
  return result;
}

function getReplyMessageId(message: OneBotMessage | string | undefined, rawMessage?: string): string | null {
  if (message && typeof message !== "string") {
    for (const segment of message) {
      if (segment.type === "reply" && segment.data?.id) {
        const id = String(segment.data.id).trim();
        if (id && /^-?\d+$/.test(id)) {
          return id;
        }
      }
    }
  }
  if (rawMessage) {
    const match = rawMessage.match(/\[CQ:reply,id=(\d+)\]/);
    if (match) return match[1];
  }
  return null;
}

function normalizeTarget(raw: string): string {
  return raw.replace(/^(qq:)/i, "");
}

const clients = new Map<string, OneBotClient>();
const accountConfigs = new Map<string, QQConfig>();
const blockedNotifyCache = new Map<string, number>();

function normalizeNumericId(value: string | number | undefined | null): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === "string") {
        const trimmed = value.trim().replace(/^"|"$|^'|'$/g, "");
        if (!/^\d+$/.test(trimmed)) return null;
        const parsed = Number.parseInt(trimmed, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function normalizeNumericIdList(values: Array<string | number> | undefined): number[] {
    if (!Array.isArray(values)) return [];
    const out: number[] = [];
    for (const value of values) {
        const parsed = normalizeNumericId(value);
        if (parsed !== null) out.push(parsed);
    }
    return out;
}

function parseIdListInput(values: string | number | Array<string | number> | undefined): number[] {
    if (typeof values === "number") {
        const parsed = normalizeNumericId(values);
        return parsed === null ? [] : [parsed];
    }
    if (typeof values === "string") {
        const parts = values
            .split(/[\n,，;；\s]+/)
            .map((part) => part.trim())
            .filter(Boolean);
        return normalizeNumericIdList(parts);
    }
    return normalizeNumericIdList(values);
}

function parseKeywordTriggersInput(values: string | string[] | undefined): string[] {
    if (typeof values === "string") {
        return values
            .split(/[\n,，;；\s]+/)
            .map((part) => part.trim())
            .filter(Boolean);
    }
    if (Array.isArray(values)) {
        return values
            .map((part) => String(part).trim())
            .filter(Boolean);
    }
    return [];
}

function normalizeAccountLookupId(accountId: string | undefined | null): string {
    const raw = typeof accountId === "string" ? accountId.trim() : "";
    if (!raw) return DEFAULT_ACCOUNT_ID;
    if (raw === DEFAULT_ACCOUNT_ID) return raw;

    const noPrefix = raw.replace(/^qq:/i, "");
    if (noPrefix) return noPrefix;
    return DEFAULT_ACCOUNT_ID;
}

function getClientForAccount(accountId: string | undefined | null) {
    const lookupId = normalizeAccountLookupId(accountId);
    const direct = clients.get(lookupId);
    if (direct) return direct;

    const normalized = normalizeAccountId(lookupId);
    if (normalized && clients.has(normalized)) {
        return clients.get(normalized);
    }

    const suffix = lookupId.includes(":") ? lookupId.split(":").pop() : lookupId;
    if (suffix && clients.has(suffix)) {
        return clients.get(suffix);
    }

    if (clients.size === 1) {
        return Array.from(clients.values())[0];
    }

    console.warn(`[QQ] Client lookup miss: requested=${String(accountId)} resolved=${lookupId} keys=${Array.from(clients.keys()).join(",")}`);
    return undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isImageFile(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.gif') || lower.endsWith('.webp');
}

function isAudioFile(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.endsWith('.wav') || lower.endsWith('.mp3') || lower.endsWith('.m4a') || lower.endsWith('.ogg') || lower.endsWith('.flac') || lower.endsWith('.aac');
}

async function findRecentAudioFallback(preferredExt?: string): Promise<string | null> {
    const home = process.env.HOME;
    if (!home) return null;
    const fallbackDir = path.join(home, ".openclaw", "workspace", "voicevox_output");
    try {
        const entries = await fs.readdir(fallbackDir, { withFileTypes: true });
        const candidates = entries
            .filter((entry) => entry.isFile())
            .map((entry) => path.join(fallbackDir, entry.name))
            .filter((filePath) => isAudioFile(filePath));
        if (candidates.length === 0) return null;

        const preferred = preferredExt ? candidates.filter((filePath) => filePath.toLowerCase().endsWith(preferredExt.toLowerCase())) : [];
        const pool = preferred.length > 0 ? preferred : candidates;

        let bestPath: string | null = null;
        let bestMtime = 0;
        for (const filePath of pool) {
            const stat = await fs.stat(filePath);
            const mtime = stat.mtimeMs || 0;
            if (mtime > bestMtime) {
                bestMtime = mtime;
                bestPath = filePath;
            }
        }
        return bestPath;
    } catch {
        return null;
    }
}

async function readLocalFileAsBase64(localPath: string): Promise<string> {
    const data = await fs.readFile(localPath);
    return `base64://${data.toString("base64")}`;
}

async function ensureFileInSharedMedia(localPath: string, hostSharedDir: string): Promise<string> {
    const ext = path.extname(localPath) || ".dat";
    const baseName = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext}`;
    await fs.mkdir(hostSharedDir, { recursive: true });
    const destPath = path.join(hostSharedDir, baseName);
    await fs.copyFile(localPath, destPath);
    return baseName;
}

function toLocalPathIfAny(value: string): string | null {
    if (!value) return null;
    if (value.startsWith("file:")) {
        try {
            return fileURLToPath(value);
        } catch {
            return null;
        }
    }
    if (
        value.startsWith("/") ||
        value.startsWith("./") ||
        value.startsWith("../") ||
        /^[A-Za-z]:[\\/]/.test(value)
    ) {
        return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
    }
    return null;
}

function splitMessage(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];
    const chunks = [];
    let current = text;
    while (current.length > 0) {
        chunks.push(current.slice(0, limit));
        current = current.slice(limit);
    }
    return chunks;
}

function stripMarkdown(text: string): string {
    return text
        .replace(/\*\*(.*?)\*\*/g, "$1") // Bold
        .replace(/\*(.*?)\*/g, "$1")     // Italic
        .replace(/`(.*?)`/g, "$1")       // Inline code
        .replace(/#+\s+(.*)/g, "$1")     // Headers
        .replace(/\[(.*?)\]\(.*?\)/g, "$1") // Links
        .replace(/^\s*>\s+(.*)/gm, "▎$1") // Blockquotes
        .replace(/```[\s\S]*?```/g, "[代码块]") // Code blocks
        .replace(/^\|.*\|$/gm, (match) => { // Simple table row approximation
             return match.replace(/\|/g, " ").trim();
        })
        .replace(/^[\-\*]\s+/gm, "• "); // Lists
}

function processAntiRisk(text: string): string {
    return text.replace(/(https?:\/\/)/gi, "$1 ");
}

async function resolveMediaUrl(url: string): Promise<string> {
    if (url.startsWith("file:")) {
        try {
            const localPath = fileURLToPath(url);
            return await readLocalFileAsBase64(localPath);
        } catch (e) {
            const preferredExt = path.extname(url);
            const fallback = await findRecentAudioFallback(preferredExt);
            if (fallback) {
                try {
                    console.warn(`[QQ] Local media missing, fallback to recent audio: ${fallback}`);
                    return await readLocalFileAsBase64(fallback);
                } catch {}
            }
            console.warn(`[QQ] Failed to convert local file to base64: ${e}`);
            return url;
        }
    }

    const looksLocalPath =
      url.startsWith("/") ||
      url.startsWith("./") ||
      url.startsWith("../") ||
      /^[A-Za-z]:[\\/]/.test(url);
    if (looksLocalPath) {
        try {
            const absolutePath = path.isAbsolute(url) ? url : path.resolve(process.cwd(), url);
            return await readLocalFileAsBase64(absolutePath);
        } catch (e) {
            if (isAudioFile(url)) {
                const preferredExt = path.extname(url);
                const fallback = await findRecentAudioFallback(preferredExt);
                if (fallback) {
                    try {
                        console.warn(`[QQ] Local audio path unavailable, fallback to ${fallback}`);
                        return await readLocalFileAsBase64(fallback);
                    } catch {}
                }
            }
            console.warn(`[QQ] Failed to read local media path for base64 conversion: ${url} (${e})`);
            return url;
        }
    }

    return url;
}

async function resolveInlineCqRecord(text: string): Promise<string> {
    const regex = /\[CQ:record,([^\]]*)\]/g;
    let result = text;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        const whole = match[0];
        const params = match[1];
        const fileMatch = params.match(/(?:^|,)file=([^,]+)/);
        if (!fileMatch) continue;
        const rawFile = fileMatch[1].trim();
        const decoded = rawFile.replace(/&amp;/g, "&");
        const converted = await resolveMediaUrl(decoded);
        if (converted === decoded) continue;
        const nextParams = params.replace(fileMatch[1], converted);
        result = result.replace(whole, `[CQ:record,${nextParams}]`);
    }
    return result;
}

async function sendOneBotMessageWithAck(client: OneBotClient, to: string, message: OneBotMessage | string): Promise<{ ok: boolean; data?: any; error?: string }> {
    try {
        if (to.startsWith("group:")) {
            const data = await client.sendGroupMsgAck(parseInt(to.replace("group:", ""), 10), message);
            return { ok: true, data };
        }
        if (to.startsWith("guild:")) {
            const parts = to.split(":");
            if (parts.length >= 3) {
                const data = await client.sendGuildChannelMsgAck(parts[1], parts[2], message);
                return { ok: true, data };
            }
            return { ok: false, error: `Invalid guild target: ${to}` };
        }
        const data = await client.sendPrivateMsgAck(parseInt(to, 10), message);
        return { ok: true, data };
    } catch (err) {
        return { ok: false, error: String(err) };
    }
}

export const qqChannel: ChannelPlugin<ResolvedQQAccount> = {
  id: "qq",
  meta: {
    id: "qq",
    label: "QQ (OneBot)",
    selectionLabel: "QQ",
    docsPath: "extensions/qq",
    blurb: "Connect to QQ via OneBot v11",
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    // @ts-ignore
    deleteMessage: true,
  },
  configSchema: buildChannelConfigSchema(QQConfigSchema),
  config: {
    listAccountIds: (cfg) => {
        // @ts-ignore
        const qq = cfg.channels?.qq;
        if (!qq) return [];
        if (qq.accounts) return Object.keys(qq.accounts);
        return [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg, accountId) => {
        const id = accountId ?? DEFAULT_ACCOUNT_ID;
        // @ts-ignore
        const qq = cfg.channels?.qq;
        const accountConfig = id === DEFAULT_ACCOUNT_ID ? qq : qq?.accounts?.[id];
        return {
            accountId: id,
            name: accountConfig?.name ?? "QQ Default",
            enabled: true,
            configured: Boolean(accountConfig?.wsUrl),
            tokenSource: accountConfig?.accessToken ? "config" : "none",
            config: accountConfig || {},
        };
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    describeAccount: (acc) => ({
        accountId: acc.accountId,
        configured: acc.configured,
    }),
  },
  directory: {
      listPeers: async ({ accountId }) => {
          const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
          if (!client) return [];
          try {
              const friends = await client.getFriendList();
              return friends.map(f => ({
                  id: String(f.user_id),
                  name: f.remark || f.nickname,
                  type: "user" as const,
                  metadata: { ...f }
              }));
          } catch (e) {
              return [];
          }
      },
      listGroups: async ({ accountId, cfg }) => {
          const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
          if (!client) return [];
          const list: any[] = [];
          
          try {
              const groups = await client.getGroupList();
              list.push(...groups.map(g => ({
                  id: String(g.group_id),
                  name: g.group_name,
                  type: "group" as const,
                  metadata: { ...g }
              })));
          } catch (e) {}

          // @ts-ignore
          const enableGuilds = cfg?.channels?.qq?.enableGuilds ?? true;
          if (enableGuilds) {
              try {
                  const guilds = await client.getGuildList();
                  list.push(...guilds.map(g => ({
                      id: `guild:${g.guild_id}`,
                      name: `[频道] ${g.guild_name}`,
                      type: "group" as const,
                      metadata: { ...g }
                  })));
              } catch (e) {}
          }
          return list;
      }
  },
  status: {
      probeAccount: async ({ account, timeoutMs }) => {
          if (!account.config.wsUrl) return { ok: false, error: "Missing wsUrl" };
          
          const client = new OneBotClient({
              wsUrl: account.config.wsUrl,
              accessToken: account.config.accessToken,
          });
          
          return new Promise((resolve) => {
              const timer = setTimeout(() => {
                  client.disconnect();
                  resolve({ ok: false, error: "Connection timeout" });
              }, timeoutMs || 5000);

              client.on("connect", async () => {
                  try {
                      const info = await client.getLoginInfo();
                      clearTimeout(timer);
                      client.disconnect();
                      resolve({ 
                          ok: true, 
                          bot: { id: String(info.user_id), username: info.nickname } 
                      });
                  } catch (e) {
                      clearTimeout(timer);
                      client.disconnect();
                      resolve({ ok: false, error: String(e) });
                  }
              });
              
              client.on("error", (err) => {
                  clearTimeout(timer);
                  resolve({ ok: false, error: String(err) });
              });

              client.connect();
          });
      },
      buildAccountSnapshot: ({ account, runtime, probe }) => {
          return {
              accountId: account.accountId,
              name: account.name,
              enabled: account.enabled,
              configured: account.configured,
              running: runtime?.running ?? false,
              lastStartAt: runtime?.lastStartAt ?? null,
              lastError: runtime?.lastError ?? null,
              probe,
          };
      }
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => 
        applyAccountNameToChannelSection({ cfg, channelKey: "qq", accountId, name }),
    validateInput: ({ input }) => null,
    applyAccountConfig: ({ cfg, accountId, input }) => {
        const namedConfig = applyAccountNameToChannelSection({
            cfg,
            channelKey: "qq",
            accountId,
            name: input.name,
        });
        
        const next = accountId !== DEFAULT_ACCOUNT_ID 
            ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "qq" }) 
            : namedConfig;

        const newConfig = {
            wsUrl: input.wsUrl || "ws://localhost:3001",
            accessToken: input.accessToken,
            enabled: true,
        };

        if (accountId === DEFAULT_ACCOUNT_ID) {
            return {
                ...next,
                channels: {
                    ...next.channels,
                    qq: { ...next.channels?.qq, ...newConfig }
                }
            };
        }
        
        return {
            ...next,
            channels: {
                ...next.channels,
                qq: {
                    ...next.channels?.qq,
                    enabled: true,
                    accounts: {
                        ...next.channels?.qq?.accounts,
                        [accountId]: {
                            ...next.channels?.qq?.accounts?.[accountId],
                            ...newConfig
                        }
                    }
                }
            }
        };
    }
  },
  gateway: {
    startAccount: async (ctx) => {
        const { account, cfg } = ctx;
        const config = account.config;
        accountConfigs.set(account.accountId, config);
        const adminIds = [...new Set(parseIdListInput(config.admins as string | number | Array<string | number> | undefined))];
        const allowedGroupIds = [...new Set(parseIdListInput(config.allowedGroups as string | number | Array<string | number> | undefined))];
        const blockedUserIds = [...new Set(parseIdListInput(config.blockedUsers as string | number | Array<string | number> | undefined))];
        const blockedNotifyCooldownMs = Math.max(0, Number(config.blockedNotifyCooldownMs ?? 10000));

        if (!config.wsUrl) throw new Error("QQ: wsUrl is required");

        // 1. Prevent multiple clients for the same account
        const existingClient = clients.get(account.accountId);
        if (existingClient) {
            console.log(`[QQ] Stopping existing client for account ${account.accountId} before restart`);
            existingClient.disconnect();
        }

        const client = new OneBotClient({
            wsUrl: config.wsUrl,
            accessToken: config.accessToken,
        });
        
        clients.set(account.accountId, client);

        const processedMsgIds = new Set<string>();
        const cleanupInterval = setInterval(() => {
            if (processedMsgIds.size > 1000) processedMsgIds.clear();
        }, 3600000);

        client.on("connect", async () => {
             console.log(`[QQ] Connected account ${account.accountId}`);
             try {
                const info = await client.getLoginInfo();
                if (info && info.user_id) client.setSelfId(info.user_id);
                if (info && info.nickname) console.log(`[QQ] Logged in as: ${info.nickname} (${info.user_id})`);
                getQQRuntime().channel.activity.record({
                    channel: "qq", accountId: account.accountId, direction: "inbound", 
                 });
             } catch (err) { }
        });

        client.on("request", (event) => {
            if (config.autoApproveRequests) {
                if (event.request_type === "friend") client.setFriendAddRequest(event.flag, true);
                else if (event.request_type === "group") client.setGroupAddRequest(event.flag, event.sub_type, true);
            }
        });

        client.on("message", async (event) => {
          try {
            if (event.post_type === "meta_event") {
                 if (event.meta_event_type === "lifecycle" && event.sub_type === "connect" && event.self_id) client.setSelfId(event.self_id);
                 return;
            }

            if (event.post_type === "notice" && event.notice_type === "notify" && event.sub_type === "poke") {
                if (String(event.target_id) === String(client.getSelfId())) {
                    event.post_type = "message";
                    event.message_type = event.group_id ? "group" : "private";
                    event.raw_message = `[动作] 用户戳了你一下`;
                    event.message = [{ type: "text", data: { text: event.raw_message } }];
                } else return;
            }

            if (event.post_type !== "message") return;
            
            // 2. Dynamic self-message filtering
            const selfId = client.getSelfId() || event.self_id;
            if (selfId && String(event.user_id) === String(selfId)) return;

            if (config.enableDeduplication !== false && event.message_id) {
                const msgIdKey = String(event.message_id);
                if (processedMsgIds.has(msgIdKey)) return;
                processedMsgIds.add(msgIdKey);
            }

            const isGroup = event.message_type === "group";
            const isGuild = event.message_type === "guild";
            
            if (isGuild && !config.enableGuilds) return;

            const userId = event.user_id;
            const groupId = event.group_id;
            const guildId = event.guild_id;
            const channelId = event.channel_id;
            
            let text = event.raw_message || "";
            const fileHints: Array<{
                name: string;
                url?: string;
                fileId?: string;
                busid?: string;
                size?: number;
            }> = [];
            
            if (Array.isArray(event.message)) {
                let resolvedText = "";
                for (const seg of event.message) {
                    if (seg.type === "text") resolvedText += seg.data?.text || "";
                    else if (seg.type === "at") {
                        let name = seg.data?.qq;
                        if (name !== "all" && isGroup) {
                            const cached = getCachedMemberName(String(groupId), String(name));
                            if (cached) name = cached;
                            else {
                                try {
                                    const info = await (client as any).sendWithResponse("get_group_member_info", { group_id: groupId, user_id: name });
                                    name = info?.card || info?.nickname || name;
                                    setCachedMemberName(String(groupId), String(seg.data.qq), name);
                                } catch (e) {}
                            }
                        }
                        resolvedText += ` @${name} `;
                    } else if (seg.type === "record") resolvedText += ` [语音消息]${seg.data?.text ? `(${seg.data.text})` : ""}`;
                    else if (seg.type === "image") resolvedText += " [图片]";
                    else if (seg.type === "video") resolvedText += " [视频消息]";
                    else if (seg.type === "json") resolvedText += " [卡片消息]";
                    else if (seg.type === "forward" && seg.data?.id) {
                        try {
                            const forwardData = await client.getForwardMsg(seg.data.id);
                            if (forwardData?.messages) {
                                resolvedText += "\n[转发聊天记录]:";
                                for (const m of forwardData.messages.slice(0, 10)) {
                                    resolvedText += `\n${m.sender?.nickname || m.user_id}: ${cleanCQCodes(m.content || m.raw_message)}`;
                                }
                            }
                        } catch (e) {}
                    } else if (seg.type === "file") {
                         if (!seg.data?.url && isGroup) {
                             try {
                                 const info = await (client as any).sendWithResponse("get_group_file_url", { group_id: groupId, file_id: seg.data?.file_id, busid: seg.data?.busid });
                                 if (info?.url) seg.data.url = info.url;
                             } catch(e) {}
                         }
                         const fileName = seg.data?.name || seg.data?.file || "未命名";
                         const fileId = seg.data?.file_id ? String(seg.data.file_id) : undefined;
                         const busid = seg.data?.busid !== undefined ? String(seg.data.busid) : undefined;
                         const fileUrl = typeof seg.data?.url === "string" ? seg.data.url : undefined;
                         const fileSize = typeof seg.data?.file_size === "number" ? seg.data.file_size : undefined;
                         fileHints.push({
                            name: fileName,
                            ...(fileUrl ? { url: fileUrl } : {}),
                            ...(fileId ? { fileId } : {}),
                            ...(busid ? { busid } : {}),
                            ...(fileSize !== undefined ? { size: fileSize } : {}),
                         });
                         const shortHint = fileUrl
                            ? ` [文件: ${fileName}, 下载=${fileUrl}]`
                            : fileId
                                ? ` [文件: ${fileName}, file_id=${fileId}${busid ? `, busid=${busid}` : ""}]`
                                : ` [文件: ${fileName}]`;
                         resolvedText += shortHint;
                    }
                }
                if (resolvedText) text = resolvedText;
            }
            
            if (blockedUserIds.includes(userId)) return;
            if (isGroup && allowedGroupIds.length && !allowedGroupIds.includes(groupId)) return;
            
            const isAdmin = adminIds.includes(userId);

            if (!isGuild && isAdmin && text.trim().startsWith('/')) {
                const parts = text.trim().split(/\s+/);
                const cmd = parts[0];
                if (cmd === '/status') {
                    const statusMsg = `[OpenClawd QQ]\nState: Connected\nSelf ID: ${client.getSelfId()}\nMemory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`;
                    if (isGroup) client.sendGroupMsg(groupId, statusMsg); else client.sendPrivateMsg(userId, statusMsg);
                    return;
                }
                if (cmd === '/help') {
                    const helpMsg = `[OpenClawd QQ]\n/status - 状态\n/mute @用户 [分] - 禁言\n/kick @用户 - 踢出\n/help - 帮助`;
                    if (isGroup) client.sendGroupMsg(groupId, helpMsg); else client.sendPrivateMsg(userId, helpMsg);
                    return;
                }
                if (isGroup && (cmd === '/mute' || cmd === '/ban')) {
                    const targetMatch = text.match(/\[CQ:at,qq=(\d+)\]/);
                    const targetId = targetMatch ? parseInt(targetMatch[1]) : (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        client.setGroupBan(groupId, targetId, parts[2] ? parseInt(parts[2]) * 60 : 1800);
                        client.sendGroupMsg(groupId, `已禁言。`);
                    }
                    return;
                }
                if (isGroup && cmd === '/kick') {
                    const targetMatch = text.match(/\[CQ:at,qq=(\d+)\]/);
                    const targetId = targetMatch ? parseInt(targetMatch[1]) : (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        client.setGroupKick(groupId, targetId);
                        client.sendGroupMsg(groupId, `已踢出。`);
                    }
                    return;
                }
            }
            
            let repliedMsg: any = null;
            const replyMsgId = getReplyMessageId(event.message, text);
            if (replyMsgId) {
                try { repliedMsg = await client.getMsg(replyMsgId); } catch (err) {}
            }
            
            let historyContext = "";
            if (isGroup && config.historyLimit !== 0) {
                 try {
                     const history = await client.getGroupMsgHistory(groupId);
                     if (history?.messages) {
                         const limit = config.historyLimit || 5;
                         historyContext = history.messages.slice(-(limit + 1), -1).map((m: any) => `${m.sender?.nickname || m.user_id}: ${cleanCQCodes(m.raw_message || "")}`).join("\n");
                     }
                 } catch (e) {}
            }

            let isTriggered = !isGroup || text.includes("[动作] 用户戳了你一下");
            const keywordTriggers = parseKeywordTriggersInput(config.keywordTriggers as string | string[] | undefined);
            if (!isTriggered && keywordTriggers.length > 0) {
                for (const kw of keywordTriggers) { if (text.includes(kw)) { isTriggered = true; break; } }
            }

            let mentionedByAt = false;
            let mentionedByReply = false;
            
            const checkMention = isGroup || isGuild;
            if (checkMention && config.requireMention && !isTriggered) {
                const selfId = client.getSelfId();
                const effectiveSelfId = selfId ?? event.self_id;
                if (!effectiveSelfId) return;
                if (Array.isArray(event.message)) {
                    for (const s of event.message) {
                        if (s.type === "at" && (String(s.data?.qq) === String(effectiveSelfId) || s.data?.qq === "all")) {
                            mentionedByAt = true;
                            break;
                        }
                    }
                } else if (text.includes(`[CQ:at,qq=${effectiveSelfId}]`)) {
                    mentionedByAt = true;
                }
                if (!mentionedByAt && repliedMsg?.sender?.user_id === effectiveSelfId) {
                    mentionedByReply = true;
                }
                if (!mentionedByAt && !mentionedByReply) return;
            }

            if (config.adminOnlyChat && !isAdmin) {
                if (config.notifyNonAdminBlocked) {
                    const shouldNotifyBlocked = !isGroup && !isGuild ? true : (isTriggered || mentionedByAt);
                    if (!shouldNotifyBlocked) return;
                    const now = Date.now();
                    const targetKey = isGroup
                        ? `g:${groupId}:u:${userId}`
                        : isGuild
                            ? `guild:${guildId}:${channelId}:u:${userId}`
                            : `dm:${userId}`;
                    const cacheKey = `${account.accountId}:${targetKey}`;
                    const lastNotifyAt = blockedNotifyCache.get(cacheKey) ?? 0;
                    if (blockedNotifyCooldownMs > 0 && now - lastNotifyAt < blockedNotifyCooldownMs) return;
                    blockedNotifyCache.set(cacheKey, now);
                    const msg = (config.nonAdminBlockedMessage || "当前仅管理员可触发机器人。\n如需使用请联系管理员。").trim();
                    if (msg) {
                        if (isGroup) client.sendGroupMsg(groupId, `[CQ:at,qq=${userId}] ${msg}`);
                        else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, msg);
                        else client.sendPrivateMsg(userId, msg);
                    }
                }
                return;
            }

            let fromId = String(userId);
            let conversationLabel = `QQ User ${userId}`;
            if (isGroup) {
                fromId = `group:${groupId}`;
                conversationLabel = `QQ Group ${groupId}`;
            } else if (isGuild) {
                fromId = `guild:${guildId}:${channelId}`;
                conversationLabel = `QQ Guild ${guildId} Channel ${channelId}`;
            }

            const runtime = getQQRuntime();
            const route = runtime.channel.routing.resolveAgentRoute({
                cfg,
                channel: "qq",
                accountId: account.accountId,
                peer: {
                    kind: isGuild ? "channel" : (isGroup ? "group" : "direct"),
                    id: fromId,
                },
            });

            const deliver = async (payload: ReplyPayload) => {
                 const send = async (msg: string) => {
                     let processed = msg;
                     if (config.formatMarkdown) processed = stripMarkdown(processed);
                     if (config.antiRiskMode) processed = processAntiRisk(processed);
                     processed = await resolveInlineCqRecord(processed);
                     const chunks = splitMessage(processed, config.maxMessageLength || 4000);
                     for (let i = 0; i < chunks.length; i++) {
                         let chunk = chunks[i];
                         if (isGroup && i === 0) chunk = `[CQ:at,qq=${userId}] ${chunk}`;
                         
                         if (isGroup) client.sendGroupMsg(groupId, chunk);
                         else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, chunk);
                         else client.sendPrivateMsg(userId, chunk);
                         
                         if (!isGuild && config.enableTTS && i === 0 && chunk.length < 100) {
                             const tts = chunk.replace(/\[CQ:.*?\]/g, "").trim();
                             if (tts) { 
                                 if (isGroup) client.sendGroupMsg(groupId, `[CQ:tts,text=${tts}]`); 
                                 else client.sendPrivateMsg(userId, `[CQ:tts,text=${tts}]`); 
                             }
                         }
                         
                         if (chunks.length > 1 && config.rateLimitMs > 0) await sleep(config.rateLimitMs);
                     }
                 };
                 if (payload.text) await send(payload.text);
                 if (payload.files) {
                     for (const f of payload.files) { 
                         if (f.url) { 
                             const url = await resolveMediaUrl(f.url);
                             if (isImageFile(url)) {
                                 const imgMsg = `[CQ:image,file=${url}]`;
                                 if (isGroup) client.sendGroupMsg(groupId, imgMsg);
                                 else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, imgMsg);
                                 else client.sendPrivateMsg(userId, imgMsg);
                             } else if (isAudioFile(url) || isAudioFile(f.url)) {
                                 const audioMsg = `[CQ:record,file=${url}]`;
                                 if (isGroup) client.sendGroupMsg(groupId, audioMsg);
                                 else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, `[语音] ${url}`);
                                 else client.sendPrivateMsg(userId, audioMsg);
                             } else {
                                 const txtMsg = `[CQ:file,file=${url},name=${f.name || 'file'}]`;
                                 if (isGroup) client.sendGroupMsg(groupId, txtMsg);
                                 else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, `[文件] ${url}`);
                                 else client.sendPrivateMsg(userId, txtMsg);
                             }
                             if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
                         } 
                     }
                 }
            };

            const { dispatcher, replyOptions } = runtime.channel.reply.createReplyDispatcherWithTyping({ deliver });

            let replyToBody = "";
            let replyToSender = "";
            if (replyMsgId && repliedMsg) {
                replyToBody = cleanCQCodes(typeof repliedMsg.message === 'string' ? repliedMsg.message : repliedMsg.raw_message || '');
                replyToSender = repliedMsg.sender?.nickname || repliedMsg.sender?.card || String(repliedMsg.sender?.user_id || '');
            }

            const replySuffix = replyToBody ? `\n\n[Replying to ${replyToSender || "unknown"}]\n${replyToBody}\n[/Replying]` : "";
            let bodyWithReply = cleanCQCodes(text) + replySuffix;
            let systemBlock = "";
            if (config.systemPrompt) systemBlock += `<system>${config.systemPrompt}</system>\n\n`;
            if (historyContext) systemBlock += `<history>\n${historyContext}\n</history>\n\n`;
            if (fileHints.length > 0) {
                systemBlock += `<attachments>\n`;
                for (const hint of fileHints) {
                    const parts = [`name=${hint.name}`];
                    if (hint.url) parts.push(`url=${hint.url}`);
                    if (hint.fileId) parts.push(`file_id=${hint.fileId}`);
                    if (hint.busid) parts.push(`busid=${hint.busid}`);
                    if (hint.size !== undefined) parts.push(`size=${hint.size}`);
                    systemBlock += `- qq_file ${parts.join(" ")}\n`;
                }
                systemBlock += `</attachments>\n\n`;
            }
            bodyWithReply = systemBlock + bodyWithReply;

            const ctxPayload = runtime.channel.reply.finalizeInboundContext({
                Provider: "qq", Channel: "qq", From: fromId, To: "qq:bot", Body: bodyWithReply, RawBody: text,
                SenderId: String(userId), SenderName: event.sender?.nickname || "Unknown", ConversationLabel: conversationLabel,
                SessionKey: route.sessionKey, AccountId: route.accountId, ChatType: isGroup ? "group" : isGuild ? "channel" : "direct", Timestamp: event.time * 1000,
                Surface: "qq",
                OriginatingChannel: "qq", OriginatingTo: fromId, CommandAuthorized: true,
                ...(extractImageUrls(event.message).length > 0 && { MediaUrls: extractImageUrls(event.message) }),
                ...(replyMsgId && { ReplyToId: replyMsgId, ReplyToBody: replyToBody, ReplyToSender: replyToSender }),
            });
            
            await runtime.channel.session.recordInboundSession({
                storePath: runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
                sessionKey: ctxPayload.SessionKey!, ctx: ctxPayload,
                updateLastRoute: undefined,
                onRecordError: (err) => console.error("QQ Session Error:", err)
            });

            try { await runtime.channel.reply.dispatchReplyFromConfig({ ctx: ctxPayload, cfg, dispatcher, replyOptions });
            } catch (error) { if (config.enableErrorNotify) deliver({ text: "⚠️ 服务调用失败，请稍后重试。" }); }
          } catch (err) {
            console.error("[QQ] Critical error in message handler:", err);
          }
        });

        client.connect();
        return () => { 
            clearInterval(cleanupInterval);
            client.disconnect(); 
            clients.delete(account.accountId); 
            accountConfigs.delete(account.accountId);
        };
    },
    logoutAccount: async ({ accountId, cfg }) => {
        return { loggedOut: true, cleared: true };
    }
  },
  outbound: {
    sendText: async ({ to, text, accountId, replyTo }) => {
        const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
        if (!client) return { channel: "qq", sent: false, error: "Client not connected" };
        const normalizedText = await resolveInlineCqRecord(text);
        const chunks = splitMessage(normalizedText, 4000);
        let lastAck: any = null;
        for (let i = 0; i < chunks.length; i++) {
            let message: OneBotMessage | string = chunks[i];
            if (replyTo && i === 0) message = [ { type: "reply", data: { id: String(replyTo) } }, { type: "text", data: { text: chunks[i] } } ];
            const ack = await sendOneBotMessageWithAck(client, to, message);
            if (!ack.ok) {
                return { channel: "qq", sent: false, error: ack.error || "Failed to send text" };
            }
            lastAck = ack.data;
            
            if (chunks.length > 1) await sleep(1000); 
        }
        return { channel: "qq", sent: true, messageId: lastAck?.message_id ?? lastAck?.messageId ?? null };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyTo }) => {
         const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
         if (!client) return { channel: "qq", sent: false, error: "Client not connected" };

         const runtimeCfg = accountConfigs.get(accountId || DEFAULT_ACCOUNT_ID) || accountConfigs.get(DEFAULT_ACCOUNT_ID) || {};

         const hostSharedDir = typeof runtimeCfg.sharedMediaHostDir === "string" ? runtimeCfg.sharedMediaHostDir.trim() : "";
         const containerSharedDirRaw = typeof runtimeCfg.sharedMediaContainerDir === "string" ? runtimeCfg.sharedMediaContainerDir.trim() : "";
         const containerSharedDir = containerSharedDirRaw || "/openclaw_media";

         const audioLikeSource = isAudioFile(mediaUrl);
         let stagedAudioFile: string | null = null;
         if (audioLikeSource && hostSharedDir) {
             const localSourcePath = toLocalPathIfAny(mediaUrl);
             if (localSourcePath) {
                 try {
                     const copiedName = await ensureFileInSharedMedia(localSourcePath, hostSharedDir);
                     stagedAudioFile = path.posix.join(containerSharedDir.replace(/\\/g, "/"), copiedName);
                 } catch (err) {
                     console.warn(`[QQ] Failed to stage source audio into shared media dir: ${String(err)}`);
                 }
             }
         }
         
         const finalUrl = await resolveMediaUrl(mediaUrl);

         let textAck: any = null;
         if (text && text.trim()) {
             const textMessage: OneBotMessage = [];
             if (replyTo) textMessage.push({ type: "reply", data: { id: String(replyTo) } });
             textMessage.push({ type: "text", data: { text } });
             const ack = await sendOneBotMessageWithAck(client, to, textMessage);
             if (!ack.ok) {
                 return { channel: "qq", sent: false, error: `Text send failed: ${ack.error || "unknown"}` };
             }
             textAck = ack.data;
         }

         const mediaMessage: OneBotMessage = [];
         if (replyTo && !(text && text.trim())) mediaMessage.push({ type: "reply", data: { id: String(replyTo) } });
         const sourceAudioLike = isAudioFile(mediaUrl);
         const sourceImageLike = isImageFile(mediaUrl);
         const audioLike = sourceAudioLike || isAudioFile(finalUrl);
         const imageLike = !audioLike && (sourceImageLike || isImageFile(finalUrl) || finalUrl.startsWith("base64://"));

         if (audioLike && textAck) {
             const configuredDelay = Number(runtimeCfg.rateLimitMs ?? 1000);
             const delayMs = Number.isFinite(configuredDelay) ? Math.max(1200, configuredDelay) : 1200;
             await sleep(delayMs);
         }

         if (imageLike) mediaMessage.push({ type: "image", data: { file: finalUrl } });
         else if (audioLike) {
             let recordFile = stagedAudioFile || finalUrl;
             if (!finalUrl.startsWith("base64://") && hostSharedDir) {
                 try {
                     const localPath = finalUrl.startsWith("file:") ? fileURLToPath(finalUrl) : finalUrl;
                     const copiedName = await ensureFileInSharedMedia(localPath, hostSharedDir);
                     recordFile = path.posix.join(containerSharedDir.replace(/\\/g, "/"), copiedName);
                 } catch (err) {
                     console.warn(`[QQ] Failed to stage audio into shared media dir: ${String(err)}`);
                 }
             }
             mediaMessage.push({ type: "record", data: { file: recordFile } });
         }
         else mediaMessage.push({ type: "file", data: { file: finalUrl } });

         const mediaAck = await sendOneBotMessageWithAck(client, to, mediaMessage);
         if (!mediaAck.ok) {
             if (audioLike) {
                 const fileFallback: OneBotMessage = [];
                 if (replyTo && !(text && text.trim())) fileFallback.push({ type: "reply", data: { id: String(replyTo) } });
                 let fallbackFile = stagedAudioFile || finalUrl;
                 if (fallbackFile.startsWith("base64://")) {
                     return {
                         channel: "qq",
                         sent: Boolean(textAck),
                         error: `Media send failed: ${mediaAck.error || "unknown"}`,
                         textSent: Boolean(textAck),
                         mediaSent: false,
                         messageId: textAck?.message_id ?? textAck?.messageId ?? null,
                     };
                 }
                 if (!finalUrl.startsWith("base64://") && hostSharedDir) {
                     try {
                         const localPath = finalUrl.startsWith("file:") ? fileURLToPath(finalUrl) : finalUrl;
                         const copiedName = await ensureFileInSharedMedia(localPath, hostSharedDir);
                         fallbackFile = path.posix.join(containerSharedDir.replace(/\\/g, "/"), copiedName);
                     } catch (err) {
                         console.warn(`[QQ] Failed to stage fallback audio file into shared media dir: ${String(err)}`);
                     }
                 }
                 fileFallback.push({ type: "file", data: { file: fallbackFile } });
                 const fallbackAck = await sendOneBotMessageWithAck(client, to, fileFallback);
                 if (fallbackAck.ok) {
                     return {
                         channel: "qq",
                         sent: true,
                         textSent: Boolean(textAck),
                         mediaSent: false,
                         fallbackSent: true,
                         fallbackType: "file",
                         error: `Audio(record) failed; fallback file sent. reason=${mediaAck.error || "unknown"}`,
                         messageId: fallbackAck.data?.message_id ?? fallbackAck.data?.messageId ?? textAck?.message_id ?? textAck?.messageId ?? null,
                     };
                 }
             }
             return {
                 channel: "qq",
                 sent: Boolean(textAck),
                 error: `Media send failed: ${mediaAck.error || "unknown"}`,
                 textSent: Boolean(textAck),
                 mediaSent: false,
                 messageId: textAck?.message_id ?? textAck?.messageId ?? null,
             };
         }
         return {
             channel: "qq",
             sent: true,
             textSent: Boolean(textAck),
             mediaSent: true,
             messageId: mediaAck.data?.message_id ?? mediaAck.data?.messageId ?? textAck?.message_id ?? textAck?.messageId ?? null,
         };
    },
    // @ts-ignore
    deleteMessage: async ({ messageId, accountId }) => {
        const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
        if (!client) return { channel: "qq", success: false, error: "Client not connected" };
        try { client.deleteMsg(messageId); return { channel: "qq", success: true }; }
        catch (err) { return { channel: "qq", success: false, error: String(err) }; }
    }
  },
  messaging: { 
      normalizeTarget,
      targetResolver: {
          looksLikeId: (id) => /^\d{5,12}$/.test(id) || /^group:\d{5,12}$/.test(id) || /^guild:/.test(id),
          hint: "QQ号, 群号 (group:123), 或频道 (guild:id:channel)",
      }
  },
  setup: { resolveAccountId: ({ accountId }) => normalizeAccountId(accountId) }
};
