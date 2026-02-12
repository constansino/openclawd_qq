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
