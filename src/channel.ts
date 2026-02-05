import {
  type ChannelPlugin,
  type ChannelAccountSnapshot,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import { OneBotClient } from "./client.js";
import { QQConfigSchema, type QQConfig } from "./config.js";
import { getQQRuntime } from "./runtime.js";
import type { OneBotMessage, OneBotMessageSegment } from "./types.js";

export type ResolvedQQAccount = ChannelAccountSnapshot & {
  config: QQConfig;
  client?: OneBotClient;
};

/**
 * Extract image URLs from message segments
 * Returns images from newest to oldest (as they appear in the array)
 * Limited to max 3 images
 * Only returns valid HTTP(S) URLs (filters out local file:// paths)
 */
function extractImageUrls(message: OneBotMessage | string | undefined, maxImages = 3): string[] {
  if (!message || typeof message === "string") return [];
  
  const urls: string[] = [];
  for (const segment of message) {
    if (segment.type === "image") {
      // Prefer url, fallback to file if it's a valid URL
      const url = segment.data?.url || segment.data?.file;
      if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
        urls.push(url);
        if (urls.length >= maxImages) break;
      }
    }
  }
  return urls;
}

/**
 * Check if message contains a reply segment
 */
function hasReplySegment(message: OneBotMessage | string | undefined): boolean {
  if (!message || typeof message === "string") return false;
  return message.some(seg => seg.type === "reply");
}

/**
 * Clean CQ codes from message text
 * Removes [CQ:xxx,...] format and normalizes whitespace
 * Preserves image URLs by extracting them from [CQ:image,url=...] format
 */
function cleanCQCodes(text: string | undefined): string {
  if (!text) return "";
  
  // Extract image URLs from CQ:image codes and replace with a placeholder
  let result = text;
  const imageUrls: string[] = [];
  
  // Match [CQ:image,...url=xxx...] and extract URL
  const imageRegex = /\[CQ:image,[^\]]*url=([^,\]]+)[^\]]*\]/g;
  let match;
  while ((match = imageRegex.exec(text)) !== null) {
    const url = match[1].replace(/&amp;/g, "&");  // Decode HTML entities
    imageUrls.push(url);
  }

  // Handle Face IDs
  result = result.replace(/\[CQ:face,id=(\d+)\]/g, "[表情]");
  
  // Replace all CQ codes
  result = result.replace(/\[CQ:[^\]]+\]/g, (match) => {
    // If it's an image with URL, return placeholder
    if (match.startsWith("[CQ:image") && match.includes("url=")) {
      return "[图片]";
    }
    // Otherwise remove it
    return "";
  });
  
  result = result.replace(/\s+/g, " ").trim();
  
  // Append image URLs at the end if any were found
  if (imageUrls.length > 0) {
    result = result ? `${result} [图片: ${imageUrls.join(", ")}]` : `[图片: ${imageUrls.join(", ")}]`;
  }
  
  return result;
}

/**
 * Get reply message ID from message segments or raw message string
 * Returns string to avoid type conversion issues
 */
function getReplyMessageId(message: OneBotMessage | string | undefined, rawMessage?: string): string | null {
  // First try to get from parsed message array
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
  
  // Fallback: parse from raw_message CQ code
  if (rawMessage) {
    const match = rawMessage.match(/\[CQ:reply,id=(\d+)\]/);
    if (match) {
      return match[1];
    }
  }
  
  return null;
}

function normalizeTarget(raw: string): string {
  return raw.replace(/^(qq:)/i, "");
}

const clients = new Map<string, OneBotClient>();
const processedMsgIds = new Set<string>(); // Deduplication cache

// Clean up old message IDs periodically
setInterval(() => {
    if (processedMsgIds.size > 1000) {
        processedMsgIds.clear();
    }
}, 3600000); // Clear every hour

function getClientForAccount(accountId: string) {
    return clients.get(accountId);
}

function isImageFile(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.gif') || lower.endsWith('.webp');
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
  gateway: {
    startAccount: async (ctx) => {
        const { account, cfg } = ctx;
        const config = account.config;

        if (!config.wsUrl) {
            throw new Error("QQ: wsUrl is required");
        }

        const client = new OneBotClient({
            wsUrl: config.wsUrl,
            accessToken: config.accessToken,
        });
        
        clients.set(account.accountId, client);

        client.on("connect", async () => {
             console.log(`[QQ] Connected account ${account.accountId}`);
             try {
                // Sync bot info
                const info = await client.getLoginInfo();
                if (info && info.nickname) {
                    console.log(`[QQ] Logged in as: ${info.nickname} (${info.user_id})`);
                }

                getQQRuntime().channel.activity.record({
                    channel: "qq",
                    accountId: account.accountId,
                    direction: "inbound", 
                 });
             } catch (err) {
                 console.error("[QQ] Failed to get login info or record activity:", err);
             }
        });

        // Request handling
        client.on("request", (event) => {
            if (config.autoApproveRequests) {
                console.log(`[QQ] Auto-approving request: ${event.request_type} from ${event.user_id}`);
                if (event.request_type === "friend") {
                    client.setFriendAddRequest(event.flag, true);
                } else if (event.request_type === "group" && event.sub_type === "invite") {
                    client.setGroupAddRequest(event.flag, event.sub_type, true);
                } else if (event.request_type === "group" && event.sub_type === "add") {
                     client.setGroupAddRequest(event.flag, event.sub_type, true);
                }
            }
        });

        client.on("message", async (event) => {
            if (event.post_type === "meta_event" && event.meta_event_type === "lifecycle" && event.sub_type === "connect") {
                if (event.self_id) {
                    client.setSelfId(event.self_id);
                }
                return;
            }
            
            if (event.post_type !== "message") return;

            // Deduplication
            if (config.enableDeduplication !== false && event.message_id) {
                const msgIdKey = String(event.message_id);
                if (processedMsgIds.has(msgIdKey)) {
                    console.log(`[QQ] Skipping duplicate message ${msgIdKey}`);
                    return;
                }
                processedMsgIds.add(msgIdKey);
            }

            const isGroup = event.message_type === "group";
            const userId = event.user_id;
            const groupId = event.group_id;
            let text = event.raw_message || "";
            
            // Rich Media Handling
            if (Array.isArray(event.message)) {
                for (const seg of event.message) {
                    if (seg.type === "record") text += " [语音消息]";
                    else if (seg.type === "video") text += " [视频消息]";
                    else if (seg.type === "json") text += " [卡片消息]";
                }
            }

            // Check blacklist/whitelist
            if (config.blockedUsers?.includes(userId)) {
                return;
            }
            if (isGroup && config.allowedGroups && config.allowedGroups.length > 0) {
                if (!config.allowedGroups.includes(groupId)) {
                    return;
                }
            }
            
            // Check admin whitelist if configured
            const isAdmin = config.admins?.includes(userId) ?? false;
            if (config.admins && config.admins.length > 0 && userId) {
                if (!isAdmin) {
                    return; // Ignore non-admin messages
                }
            }

            // Admin Commands
            if (isAdmin && text.startsWith('/')) {
                const cmd = text.trim();
                if (cmd === '/status') {
                    const statusMsg = `[OpenClawd QQ]\nState: Connected\nSelf ID: ${client.getSelfId()}\nMemory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`;
                    if (isGroup) client.sendGroupMsg(groupId, statusMsg);
                    else client.sendPrivateMsg(userId, statusMsg);
                    return;
                }
                if (cmd === '/help') {
                    const helpMsg = `[OpenClawd QQ]\n/status - Check bot status\n/help - Show this message`;
                    if (isGroup) client.sendGroupMsg(groupId, helpMsg);
                    else client.sendPrivateMsg(userId, helpMsg);
                    return;
                }
            }
            
            // Check requireMention for group chats
            let repliedMsg: any = null;
            const replyMsgId = getReplyMessageId(event.message, text);
            
            if (replyMsgId) {
                try {
                    repliedMsg = await client.getMsg(replyMsgId);
                } catch (err) {
                    console.log("[QQ] Failed to get replied message:", err);
                }
            }

            // Fetch History Context (Group only)
            let historyContext = "";
            if (isGroup) {
                 try {
                     // Get recent history (Note: OneBot API varies, napcat/go-cqhttp usually support get_group_msg_history)
                     // Here we try to get messages. We limit strictly to avoid token overflow.
                     const history = await client.getGroupMsgHistory(groupId);
                     if (history && history.messages && Array.isArray(history.messages)) {
                         // Filter last 5 text messages from others
                         // We exclude the current message which is already in 'text'
                         const recent = history.messages.slice(-6, -1); 
                         historyContext = recent.map((m: any) => {
                             const sender = m.sender?.nickname || m.sender?.card || m.user_id;
                             const content = cleanCQCodes(m.raw_message || "");
                             return `${sender}: ${content}`;
                         }).join("\n");
                     }
                 } catch (e) {
                     // History fetch failed, ignore
                 }
            }
            
            if (isGroup && config.requireMention) {
                const selfId = client.getSelfId();
                let isMentioned = false;
                
                const effectiveSelfId = selfId ?? event.self_id;
                if (!effectiveSelfId) {
                    return;
                }
                
                if (Array.isArray(event.message)) {
                    for (const segment of event.message) {
                        if (segment.type === "at" && segment.data?.qq) {
                            const targetId = String(segment.data.qq);
                            if (targetId === String(effectiveSelfId) || targetId === "all") {
                                isMentioned = true;
                                break;
                            }
                        }
                    }
                } else {
                    if (text.includes(`[CQ:at,qq=${effectiveSelfId}]`)) {
                        isMentioned = true;
                    }
                }
                
                if (!isMentioned && repliedMsg) {
                    if (repliedMsg?.sender?.user_id === effectiveSelfId) {
                        isMentioned = true;
                    }
                }
                
                if (!isMentioned) {
                    return; // Skip this message
                }
            }

            const fromId = isGroup ? `group:${groupId}` : String(userId);
            const conversationLabel = isGroup ? `QQ Group ${groupId}` : `QQ User ${userId}`;
            const senderName = event.sender?.nickname || "Unknown";

            let mediaUrls: string[] = extractImageUrls(event.message, 3);
            if (mediaUrls.length < 3 && replyMsgId && repliedMsg?.message) {
                const repliedImages = extractImageUrls(repliedMsg.message, 3 - mediaUrls.length);
                mediaUrls = [...mediaUrls, ...repliedImages];
            }

            const runtime = getQQRuntime();

            // Create Dispatcher
            const deliver = async (payload: ReplyPayload) => {
                 const send = (msg: string) => {
                     let processed = msg;
                     if (config.formatMarkdown) {
                         processed = stripMarkdown(processed);
                     }
                     if (config.antiRiskMode) {
                         processed = processAntiRisk(processed);
                     }
                     const chunks = splitMessage(processed, config.maxMessageLength || 4000);
                     
                     for (let i = 0; i < chunks.length; i++) {
                         let chunk = chunks[i];
                         
                         // Auto-At for group replies (only on first chunk)
                         if (isGroup && i === 0) {
                             chunk = `[CQ:at,qq=${userId}] ${chunk}`;
                         }

                         if (isGroup) client.sendGroupMsg(groupId, chunk);
                         else client.sendPrivateMsg(userId, chunk);
                     }
                 };

                 if (payload.text) {
                     send(payload.text);
                 }
                 
                 if (payload.files) {
                     for (const file of payload.files) {
                         if (file.url) {
                            if (isImageFile(file.url)) {
                                send(`[CQ:image,file=${file.url}]`);
                            } else {
                                send(`[CQ:file,file=${file.url},name=${file.name || 'file'}]`);
                            }
                         }
                     }
                 }
            };

            const { dispatcher, replyOptions } = runtime.channel.reply.createReplyDispatcherWithTyping({
                deliver,
            });

            let replyToBody: string | null = null;
            let replyToSender: string | null = null;
            if (replyMsgId && repliedMsg) {
                const rawBody = typeof repliedMsg.message === 'string'
                    ? repliedMsg.message
                    : repliedMsg.raw_message || '';
                replyToBody = cleanCQCodes(rawBody);
                replyToSender = repliedMsg.sender?.nickname || repliedMsg.sender?.card || String(repliedMsg.sender?.user_id || '');
            }

            const replySuffix = replyToBody
                ? `\n\n[Replying to ${replyToSender || "unknown"}]\n${replyToBody}\n[/Replying]`
                : "";
            
            let bodyWithReply = cleanCQCodes(text) + replySuffix;
            
            let systemBlock = "";
            if (config.systemPrompt) {
                systemBlock += `<system>${config.systemPrompt}</system>\n\n`;
            }
            if (historyContext) {
                systemBlock += `<history>\n${historyContext}\n</history>\n\n`;
            }
            
            bodyWithReply = systemBlock + bodyWithReply;

            const ctxPayload = runtime.channel.reply.finalizeInboundContext({
                Provider: "qq",
                Channel: "qq",
                From: fromId,
                To: "qq:bot", 
                Body: bodyWithReply,
                RawBody: text,
                SenderId: String(userId),
                SenderName: senderName,
                ConversationLabel: conversationLabel,
                SessionKey: `qq:${fromId}`,
                AccountId: account.accountId,
                ChatType: isGroup ? "group" : "direct",
                Timestamp: event.time * 1000,
                OriginatingChannel: "qq",
                OriginatingTo: fromId,
                CommandAuthorized: true,
                ...(mediaUrls.length > 0 && { MediaUrls: mediaUrls }),
                ...(replyMsgId && { ReplyToId: replyMsgId }),
                ...(replyToBody && { ReplyToBody: replyToBody }),
                ...(replyToSender && { ReplyToSender: replyToSender }),
            });
            
            await runtime.channel.session.recordInboundSession({
                storePath: runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId: "default" }),
                sessionKey: ctxPayload.SessionKey!,
                ctx: ctxPayload,
                updateLastRoute: {
                    sessionKey: ctxPayload.SessionKey!,
                    channel: "qq",
                    to: fromId,
                    accountId: account.accountId,
                },
                onRecordError: (err) => console.error("QQ Session Error:", err)
            });

            try {
                await runtime.channel.reply.dispatchReplyFromConfig({
                    ctx: ctxPayload,
                    cfg,
                    dispatcher, // Passed dispatcher
                    replyOptions, // Passed options
                });
            } catch (error) {
                console.error("[QQ] Dispatch Error:", error);
                if (config.enableErrorNotify) {
                     deliver({ text: "⚠️ 服务调用失败，请稍后重试。" }); 
                }
            }
        });

        client.connect();
        
        return () => {
            client.disconnect();
            clients.delete(account.accountId);
        };
    },
  },
  outbound: {
    sendText: async ({ to, text, accountId, replyTo }) => {
        const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
        if (!client) {
            console.warn(`[QQ] No client for account ${accountId}, cannot send text`);
            return { channel: "qq", sent: false, error: "Client not connected" };
        }

        const chunks = splitMessage(text, 4000);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            let message: OneBotMessage | string = chunk;
            
            // Only reply to first chunk
            if (replyTo && i === 0) {
                message = [
                    { type: "reply", data: { id: String(replyTo) } },
                    { type: "text", data: { text: chunk } }
                ];
            }

            if (to.startsWith("group:")) {
                const groupId = parseInt(to.replace("group:", ""), 10);
                client.sendGroupMsg(groupId, message);
            } else {
                const userId = parseInt(to, 10);
                client.sendPrivateMsg(userId, message);
            }
        }
        
        return { channel: "qq", sent: true };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyTo }) => {
         const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
         if (!client) {
            console.warn(`[QQ] No client for account ${accountId}, cannot send media`);
            return { channel: "qq", sent: false, error: "Client not connected" };
         }

         const message: OneBotMessage = [];
         
         if (replyTo) {
             message.push({ type: "reply", data: { id: String(replyTo) } });
         }
         
         if (text) {
             message.push({ type: "text", data: { text } });
         }
         
         if (isImageFile(mediaUrl)) {
             message.push({ type: "image", data: { file: mediaUrl } });
         } else {
             message.push({ type: "text", data: { text: `[CQ:file,file=${mediaUrl},url=${mediaUrl}]` } });
         }

         if (to.startsWith("group:")) {
             const groupId = parseInt(to.replace("group:", ""), 10);
             client.sendGroupMsg(groupId, message);
         } else {
             const userId = parseInt(to, 10);
             client.sendPrivateMsg(userId, message);
         }
         return { channel: "qq", sent: true };
    },
    // @ts-ignore
    deleteMessage: async ({ messageId, accountId }) => {
        const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
        if (!client) {
             return { channel: "qq", success: false, error: "Client not connected" };
        }
        try {
            client.deleteMsg(messageId);
            return { channel: "qq", success: true };
        } catch (err) {
            return { channel: "qq", success: false, error: String(err) };
        }
    }
  },
  messaging: {
      normalizeTarget: normalizeTarget,
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  }
};