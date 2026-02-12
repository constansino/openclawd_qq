import {
  type ChannelPlugin,
  type ChannelAccountSnapshot,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "openclaw/plugin-sdk";
import { OneBotClient } from "./client.js";
import { QQConfigSchema, type QQConfig } from "./config.js";
import { getQQRuntime } from "./runtime.js";
import { createQQOutbound } from "./outbound/index.js";
import { handleQQInboundMessage } from "./inbound/message.js";

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

function normalizeTarget(raw: string): string {
  return raw.replace(/^(qq:)/i, "");
}

const clients = new Map<string, OneBotClient>();
const accountConfigs = new Map<string, QQConfig>();
const blockedNotifyCache = new Map<string, number>();
const activeTaskIds = new Set<string>();
const groupBusyCounters = new Map<string, number>();
const groupBaseCards = new Map<string, string>();

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

function buildTaskKey(accountId: string, isGroup: boolean, isGuild: boolean, groupId?: number, guildId?: string, channelId?: string, userId?: number): string {
    if (isGroup && groupId !== undefined && userId !== undefined) return `${accountId}:group:${groupId}:user:${userId}`;
    if (isGuild && guildId && channelId && userId !== undefined) return `${accountId}:guild:${guildId}:${channelId}:user:${userId}`;
    return `${accountId}:dm:${String(userId ?? "unknown")}`;
}

function countActiveTasksForAccount(accountId: string): number {
    let count = 0;
    const prefix = `${accountId}:`;
    for (const taskId of activeTaskIds) {
        if (taskId.startsWith(prefix)) count += 1;
    }
    return count;
}

async function setGroupTypingCard(client: OneBotClient, accountId: string, groupId: number, busySuffix: string): Promise<void> {
    const selfId = client.getSelfId();
    if (!selfId) return;
    const groupKey = `${accountId}:group:${groupId}`;
    const current = groupBusyCounters.get(groupKey) || 0;
    const next = current + 1;
    groupBusyCounters.set(groupKey, next);

    if (current > 0) return;

    try {
        const info = await (client as any).sendWithResponse("get_group_member_info", { group_id: groupId, user_id: selfId, no_cache: true });
        const baseCard = (info?.card || info?.nickname || "").trim();
        groupBaseCards.set(groupKey, baseCard);
        const suffix = (busySuffix || "输入中").trim();
        const nextCard = baseCard ? `${baseCard}(${suffix})` : `(${suffix})`;
        client.setGroupCard(groupId, selfId, nextCard);
    } catch (err) {
        console.warn(`[QQ] Failed to set busy group card: ${String(err)}`);
    }
}

function clearGroupTypingCard(client: OneBotClient, accountId: string, groupId: number): void {
    const selfId = client.getSelfId();
    if (!selfId) return;
    const groupKey = `${accountId}:group:${groupId}`;
    const current = groupBusyCounters.get(groupKey) || 0;
    if (current <= 1) {
        groupBusyCounters.delete(groupKey);
        const baseCard = groupBaseCards.get(groupKey) || "";
        groupBaseCards.delete(groupKey);
        try {
            client.setGroupCard(groupId, selfId, baseCard);
        } catch (err) {
            console.warn(`[QQ] Failed to restore group card: ${String(err)}`);
        }
        return;
    }
    groupBusyCounters.set(groupKey, current - 1);
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
          await handleQQInboundMessage({
            event,
            client,
            config,
            processedMsgIds,
            blockedUserIds,
            allowedGroupIds,
            adminIds,
            blockedNotifyCooldownMs,
            accountId: account.accountId,
            cfg,
            getCachedMemberName,
            setCachedMemberName,
            countActiveTasksForAccount,
            parseKeywordTriggersInput,
            blockedNotifyCache,
            buildTaskKey,
            activeTaskIds,
            setGroupTypingCard,
            clearGroupTypingCard,
            sleep,
          });
        });
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
            const commandTextCandidate = Array.isArray(event.message)
                ? event.message
                    .filter((seg) => seg?.type === "text")
                    .map((seg) => String(seg.data?.text || ""))
                    .join(" ")
                    .trim()
                : text.trim();

            let forceTriggered = false;
            if (isGroup && /^\/models\b/i.test(commandTextCandidate)) {
                if (!isAdmin) return;
                text = commandTextCandidate.replace(/^\/models\b/i, "/model list").trim();
                forceTriggered = true;
            } else if (isGroup && /^\/model\b/i.test(commandTextCandidate)) {
                if (!isAdmin) return;
                text = commandTextCandidate;
                forceTriggered = true;
            }

            if (!isGuild && isAdmin && text.trim().startsWith('/')) {
                const parts = text.trim().split(/\s+/);
                const cmd = parts[0];
                if (cmd === '/status') {
                    const activeCount = countActiveTasksForAccount(account.accountId);
                    const statusMsg = `[OpenClawd QQ]\nState: Connected\nSelf ID: ${client.getSelfId()}\nMemory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB\nActiveTasks: ${activeCount}`;
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

            if (repliedMsg) {
                try {
                    const replyImageUrls = extractImageUrls(Array.isArray(repliedMsg.message) ? repliedMsg.message : repliedMsg.raw_message, 5);
                    for (const imageUrl of replyImageUrls) {
                        if (imageUrl && !imageHints.includes(imageUrl)) imageHints.push(imageUrl);
                    }
                } catch {}
            }

            if (fileHints.length === 0 && repliedMsg) {
                try {
                    const replySegments = Array.isArray(repliedMsg.message) ? repliedMsg.message : [];
                    for (const seg of replySegments) {
                        if (seg?.type !== "file") continue;
                        if (!seg.data?.url && isGroup && seg.data?.file_id) {
                            try {
                                const info = await (client as any).sendWithResponse("get_group_file_url", {
                                    group_id: groupId,
                                    file_id: seg.data.file_id,
                                    busid: seg.data.busid,
                                });
                                if (info?.url) seg.data.url = info.url;
                            } catch {}
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
                    }

                    if (fileHints.length === 0 && typeof repliedMsg.raw_message === "string") {
                        const raw = repliedMsg.raw_message;
                        const fileNameMatch = raw.match(/\[文件[:：]?\s*([^\]]+)\]/);
                        if (fileNameMatch) {
                            fileHints.push({ name: fileNameMatch[1].trim() || "未命名" });
                        }
                    }
                } catch {}
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

            let isTriggered = forceTriggered || !isGroup || text.includes("[动作] 用户戳了你一下");
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
            if (fileHints.length > 0 || imageHints.length > 0) {
                systemBlock += `<attachments>\n`;
                for (const hint of fileHints) {
                    const parts = [`name=${hint.name}`];
                    if (hint.url) parts.push(`url=${hint.url}`);
                    if (hint.fileId) parts.push(`file_id=${hint.fileId}`);
                    if (hint.busid) parts.push(`busid=${hint.busid}`);
                    if (hint.size !== undefined) parts.push(`size=${hint.size}`);
                    systemBlock += `- qq_file ${parts.join(" ")}\n`;
                }
                for (const imageUrl of imageHints.slice(0, 5)) {
                    systemBlock += `- qq_image url=${imageUrl}\n`;
                }
                systemBlock += `</attachments>\n\n`;
            }
            bodyWithReply = systemBlock + bodyWithReply;

            const inboundMediaUrls = Array.from(new Set([
                ...extractImageUrls(event.message),
                ...imageHints,
            ])).slice(0, 5);

            const ctxPayload = runtime.channel.reply.finalizeInboundContext({
                Provider: "qq", Channel: "qq", From: fromId, To: "qq:bot", Body: bodyWithReply, RawBody: text,
                SenderId: String(userId), SenderName: event.sender?.nickname || "Unknown", ConversationLabel: conversationLabel,
                SessionKey: route.sessionKey, AccountId: route.accountId, ChatType: isGroup ? "group" : isGuild ? "channel" : "direct", Timestamp: event.time * 1000,
                Surface: "qq",
                OriginatingChannel: "qq", OriginatingTo: fromId, CommandAuthorized: true,
                ...(inboundMediaUrls.length > 0 && { MediaUrls: inboundMediaUrls }),
                ...(replyMsgId && { ReplyToId: replyMsgId, ReplyToBody: replyToBody, ReplyToSender: replyToSender }),
            });
            
            await runtime.channel.session.recordInboundSession({
                storePath: runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
                sessionKey: ctxPayload.SessionKey!, ctx: ctxPayload,
                updateLastRoute: undefined,
                onRecordError: (err) => console.error("QQ Session Error:", err)
            });

            let processingDelayTimer: NodeJS.Timeout | null = null;
            let typingCardActivated = false;
            const taskKey = buildTaskKey(account.accountId, isGroup, isGuild, groupId, guildId, channelId, userId);

            const clearProcessingTimers = () => {
                if (processingDelayTimer) {
                    clearTimeout(processingDelayTimer);
                    processingDelayTimer = null;
                }
            };

            if (config.showProcessingStatus !== false) {
                activeTaskIds.add(taskKey);
                const delayMs = Math.max(100, Number(config.processingStatusDelayMs ?? 500));
                processingDelayTimer = setTimeout(() => {
                    if (isGroup) {
                        typingCardActivated = true;
                        void setGroupTypingCard(client, account.accountId, groupId, (config.processingStatusText || "输入中").trim() || "输入中");
                    }
                }, delayMs);
            }

            try { await runtime.channel.reply.dispatchReplyFromConfig({ ctx: ctxPayload, cfg, dispatcher, replyOptions });
            } catch (error) { if (config.enableErrorNotify) deliver({ text: "⚠️ 服务调用失败，请稍后重试。" }); }
            finally {
                clearProcessingTimers();
                activeTaskIds.delete(taskKey);
                if (typingCardActivated && isGroup) {
                    clearGroupTypingCard(client, account.accountId, groupId);
                }
            }
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
  outbound: createQQOutbound({
      getClientForAccount,
      accountConfigs,
      sleep,
  }),
  messaging: { 
      normalizeTarget,
      targetResolver: {
          looksLikeId: (id) => /^\d{5,12}$/.test(id) || /^group:\d{5,12}$/.test(id) || /^guild:/.test(id),
          hint: "QQ号, 群号 (group:123), 或频道 (guild:id:channel)",
      }
  },
};
