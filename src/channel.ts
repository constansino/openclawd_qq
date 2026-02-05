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

        client.on("connect", () => {
             console.log(`[QQ] Connected account ${account.accountId}`);
             try {
                getQQRuntime().channel.activity.record({
                    channel: "qq",
                    accountId: account.accountId,
                    direction: "inbound", 
                 });
             } catch (err) {
                 // ignore
             }
        });

        client.on("message", async (event) => {
            if (event.post_type === "meta_event" && event.meta_event_type === "lifecycle" && event.sub_type === "connect") {
                // Record bot's self ID when connected
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
            const text = event.raw_message || "";
            
            // Debug: log message structure for images
            if (Array.isArray(event.message)) {
                const imageSegments = event.message.filter(seg => seg.type === "image");
                if (imageSegments.length > 0) {
                    console.log("[QQ Debug] Image segments:", JSON.stringify(imageSegments, null, 2));
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
            
            // Pre-fetch replied message if exists (for mention check, images, and reply context)
            if (replyMsgId) {
                try {
                    console.log("[QQ Debug] Fetching replied message, ID:", replyMsgId);
                    repliedMsg = await client.getMsg(replyMsgId);
                    console.log("[QQ Debug] Got replied message:", JSON.stringify(repliedMsg, null, 2));
                } catch (err) {
                    console.log("[QQ] Failed to get replied message:", err);
                }
            }
            
            if (isGroup && config.requireMention) {
                const selfId = client.getSelfId();
                let isMentioned = false;
                
                // If we don't know selfId yet, we can't reliably check mentions
                // Try to get it from the event as fallback
                const effectiveSelfId = selfId ?? event.self_id;
                if (!effectiveSelfId) {
                    console.log("[QQ] Cannot check mention: selfId not available yet");
                    return;
                }
                
                // Check for @mention in message array
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
                    // Fallback to raw message check for @bot or @all
                    if (text.includes(`[CQ:at,qq=${effectiveSelfId}]`)) {
                        isMentioned = true;
                    }
                }
                
                // If not mentioned by @, check if reply is to bot's message
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

            // Extract images from current message (max 3, newest first)
            let mediaUrls: string[] = extractImageUrls(event.message, 3);
            
            // If there's space, also extract images from replied message
            if (mediaUrls.length < 3 && replyMsgId && repliedMsg?.message) {
                const repliedImages = extractImageUrls(repliedMsg.message, 3 - mediaUrls.length);
                mediaUrls = [...mediaUrls, ...repliedImages];
            }

            const runtime = getQQRuntime();

            // Create Dispatcher
            const deliver = async (payload: ReplyPayload) => {
                 const send = (msg: string) => {
                     if (isGroup) client.sendGroupMsg(groupId, msg);
                     else client.sendPrivateMsg(userId, msg);
                 };

                 // Simulate 'Typing' by checking if we can send a status (Not supported in standard OneBot v11)
                 // However, we can ensure we don't send too fast if needed, but 'createReplyDispatcherWithTyping' handles the delay.
                 
                 if (payload.text) {
                     send(payload.text);
                 }
                 
                 if (payload.files) {
                     for (const file of payload.files) {
                         if (file.url) {
                            // Check file type to decide between [CQ:image] and [CQ:file]
                            // Simple heuristic based on extension
                            if (isImageFile(file.url)) {
                                send(`[CQ:image,file=${file.url}]`);
                            } else {
                                // For OneBot v11, [CQ:file] usually requires a file path or url
                                // Note: Sending non-image files via URL might require specific OneBot implementation support
                                send(`[CQ:file,file=${file.url},name=${file.name || 'file'}]`);
                            }
                         }
                     }
                 }
            };

            const { dispatcher, replyOptions } = runtime.channel.reply.createReplyDispatcherWithTyping({
                deliver,
            });

            // Build reply context if message is a reply
            let replyToBody: string | null = null;
            let replyToSender: string | null = null;
            if (replyMsgId && repliedMsg) {
                const rawBody = typeof repliedMsg.message === 'string'
                    ? repliedMsg.message
                    : repliedMsg.raw_message || '';
                replyToBody = cleanCQCodes(rawBody);
                replyToSender = repliedMsg.sender?.nickname || repliedMsg.sender?.card || String(repliedMsg.sender?.user_id || '');
                console.log("[QQ Debug] Reply fetched:", { replyToSender, replyToBody: replyToBody.slice(0, 100) });
            }

            // Build body with reply context inline (like Telegram)
            const replySuffix = replyToBody
                ? `\n\n[Replying to ${replyToSender || "unknown"}]\n${replyToBody}\n[/Replying]`
                : "";
            
            let bodyWithReply = cleanCQCodes(text) + replySuffix;
            
            // Inject System Prompt if configured
            if (config.systemPrompt) {
                // Prepending system instructions as context header
                bodyWithReply = `<system>${config.systemPrompt}</system>\n\n${bodyWithReply}`;
            }

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
                     // Notify admin or reply with error (optional)
                     // deliver({ text: "⚠️ Error processing request" }); 
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

        // Construct message: add reply segment if replyTo is provided
        let message: OneBotMessage | string = text;
        if (replyTo) {
            message = [
                { type: "reply", data: { id: String(replyTo) } },
                { type: "text", data: { text } }
            ];
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
    sendMedia: async ({ to, text, mediaUrl, accountId, replyTo }) => {
         const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
         if (!client) {
            console.warn(`[QQ] No client for account ${accountId}, cannot send media`);
            return { channel: "qq", sent: false, error: "Client not connected" };
         }

         // Construct message array for proper reply support
         const message: OneBotMessage = [];
         
         // Add reply segment if replyTo is provided
         if (replyTo) {
             message.push({ type: "reply", data: { id: String(replyTo) } });
         }
         
         // Add text if provided
         if (text) {
             message.push({ type: "text", data: { text } });
         }
         
         // Add media (image or file)
         if (isImageFile(mediaUrl)) {
             message.push({ type: "image", data: { file: mediaUrl } });
         } else {
             // Use CQ:file for non-image files (requires OneBot support for URL files)
             // Using raw CQ code in text segment or constructing a custom node might be needed depending on implementation
             // Here we use a safe fallback for modern OneBot implementations that support generic file segments or CQ codes
             // Note: Standard OneBot v11 segment for file is often implementation specific or done via upload API
             // For now, we try sending as CQ code inside a text segment or a specialized segment if available
             // But to be safe, let's treat it as a text-based CQ code injection if the type definition allows, 
             // or just send the link if not supported.
             // Given existing code uses `message` array, we'll try to push a raw node if we can, or just text.
             
             // Simplest OneBot v11 approach: Send it as a file upload if possible, but here we only have sendMsg.
             // Let's rely on the implementation parsing [CQ:file]
             // We'll treat it as a "text" segment containing the CQ code because standard OneBot segment types for 'file' are rare/complex
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
    }
  },
  messaging: {
      normalizeTarget: normalizeTarget,
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  }
};
