import { getQQRuntime } from "../runtime.js";
import { pathToFileURL } from "node:url";
import { cleanCQCodes, extractImageUrls, getReplyMessageId } from "../cq/parser.js";
import { materializeImageForVision, MAX_VISION_IMAGE_COUNT } from "../media/vision.js";
import { isAudioFile, isImageFile, processAntiRisk, resolveInlineCqRecord, resolveMediaUrl, splitMessage, stripMarkdown } from "../media/outbound.js";

export async function handleQQInboundMessage(ctx: any): Promise<void> {
  const {
    event,
    client,
    config,
    processedMsgIds,
    blockedUserIds,
    allowedGroupIds,
    adminIds,
    blockedNotifyCooldownMs,
    accountId,
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
  } = ctx;
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
            const imageHints: string[] = [];
            
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
                    else if (seg.type === "image") {
                        let imageUrl: string | undefined;
                        const segUrl = typeof seg.data?.url === "string" ? seg.data.url.trim() : "";
                        if (segUrl && (segUrl.startsWith("http") || segUrl.startsWith("base64://") || segUrl.startsWith("file:"))) {
                            imageUrl = segUrl;
                        }
                        if (!imageUrl && typeof seg.data?.file === "string") {
                            const fileRef = seg.data.file.trim();
                            if (fileRef.startsWith("http") || fileRef.startsWith("base64://") || fileRef.startsWith("file:")) {
                                imageUrl = fileRef;
                            } else if (fileRef.length > 0) {
                                try {
                                    const info = await (client as any).sendWithResponse("get_image", { file: fileRef });
                                    const resolved = typeof info?.url === "string"
                                        ? info.url
                                        : (typeof info?.file === "string" ? info.file : undefined);
                                    if (resolved) {
                                        imageUrl = resolved.startsWith("/") ? pathToFileURL(resolved).toString() : resolved;
                                        seg.data.url = imageUrl;
                                    }
                                } catch (err) {
                                    console.warn(`[QQ] Failed to resolve image URL via get_image: ${String(err)}`);
                                }
                            }
                        }
                        if (imageUrl) {
                            imageHints.push(imageUrl);
                            resolvedText += ` [图片: ${imageUrl}]`;
                        } else {
                            resolvedText += " [图片]";
                        }
                    }
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

            // feat: allow admin-only @bot /models in groups via /model list alias
            const commandTextCandidate = Array.isArray(event.message)
                ? event.message
                    .filter((seg: any) => seg?.type === "text")
                    .map((seg: any) => String(seg.data?.text || ""))
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
                    const activeCount = countActiveTasksForAccount(accountId);
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
                    const cacheKey = `${accountId}:${targetKey}`;
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
                accountId: accountId,
                peer: {
                    kind: isGuild ? "channel" : (isGroup ? "group" : "direct"),
                    id: fromId,
                },
            });

            const deliver = async (payload: any) => {
                 // Fix: Only use blankLineSplitDelayMs when splitOnBlankLine is enabled and actually used
                 const splitOnBlankLine = Boolean(config.splitOnBlankLine ?? true);
                 const hasBlankLines = payload.text?.includes('\n\n');
                 const useBlankLineDelay = splitOnBlankLine && hasBlankLines;
                 const sendDelayMs = useBlankLineDelay
                   ? Math.max(0, Number(config.blankLineSplitDelayMs ?? 1000))
                   : Math.max(0, Number(config.rateLimitMs ?? 1000));

                 const send = async (msg: string) => {
                     let processed = msg;
                     if (config.formatMarkdown) processed = stripMarkdown(processed);
                     if (config.antiRiskMode) processed = processAntiRisk(processed);
                     processed = await resolveInlineCqRecord(processed);

                     const splitOnBlankLine = Boolean(config.splitOnBlankLine ?? true);
                     const paragraphParts = splitOnBlankLine
                        ? processed
                            .split(/\n\s*\n+/)
                            .map((part) => part.trim())
                            .filter(Boolean)
                        : [];
                     const sendUnits = paragraphParts.length > 0 ? paragraphParts : [processed.trim() || processed];
                     const outboundChunks: string[] = [];
                     for (const unit of sendUnits) {
                        outboundChunks.push(...splitMessage(unit, config.maxMessageLength || 4000));
                     }

                     let ttsSent = false;
                     for (let idx = 0; idx < outboundChunks.length; idx++) {
                        let chunk = outboundChunks[idx];
                        if (isGroup && idx === 0) chunk = `[CQ:at,qq=${userId}] ${chunk}`;

                        if (isGroup) client.sendGroupMsg(groupId, chunk);
                        else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, chunk);
                        else client.sendPrivateMsg(userId, chunk);

                        if (!isGuild && config.enableTTS && !ttsSent && chunk.length < 100) {
                            const tts = chunk.replace(/\[CQ:.*?\]/g, "").trim();
                            if (tts) {
                                if (isGroup) client.sendGroupMsg(groupId, `[CQ:tts,text=${tts}]`);
                                else client.sendPrivateMsg(userId, `[CQ:tts,text=${tts}]`);
                                ttsSent = true;
                            }
                        }

                        if (idx < outboundChunks.length - 1 && sendDelayMs > 0) await sleep(sendDelayMs);
                     }
                 };

                 const sendFileMessage = async (msg: string) => {
                    if (isGroup) client.sendGroupMsg(groupId, msg);
                    else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, msg);
                    else client.sendPrivateMsg(userId, msg);
                    if (sendDelayMs > 0) await sleep(sendDelayMs);
                 };

                 const files = Array.isArray(payload.files) ? payload.files.filter((f: any) => Boolean(f?.url)) : [];
                 const sendImageAlone = Boolean(config.sendImageAlone ?? false);

                 if (payload.text && files.length > 0 && !sendImageAlone) {
                    const first = files[0];
                    const firstUrl = await resolveMediaUrl(first.url);
                    if (isImageFile(firstUrl)) {
                        await send(`${payload.text}\n[CQ:image,file=${firstUrl}]`);
                        for (let i = 1; i < files.length; i++) {
                            const f = files[i];
                            const url = await resolveMediaUrl(f.url);
                            if (isImageFile(url)) await sendFileMessage(`[CQ:image,file=${url}]`);
                            else if (isAudioFile(url) || isAudioFile(f.url)) {
                                if (isGuild) await sendFileMessage(`[语音] ${url}`);
                                else await sendFileMessage(`[CQ:record,file=${url}]`);
                            } else await sendFileMessage(`[CQ:file,file=${url},name=${f.name || 'file'}]`);
                        }
                        return;
                    }
                 }

                 if (payload.text) await send(payload.text);
                 if (files.length > 0) {
                     for (const f of files) {
                         const url = await resolveMediaUrl(f.url);
                         if (isImageFile(url)) await sendFileMessage(`[CQ:image,file=${url}]`);
                         else if (isAudioFile(url) || isAudioFile(f.url)) {
                             if (isGuild) await sendFileMessage(`[语音] ${url}`);
                             else await sendFileMessage(`[CQ:record,file=${url}]`);
                         } else await sendFileMessage(`[CQ:file,file=${url},name=${f.name || 'file'}]`);
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

            const inboundMediaPaths = (
                await Promise.all(
                    inboundMediaUrls
                        .slice(0, MAX_VISION_IMAGE_COUNT)
                        .map((url, index) => materializeImageForVision(url, event.message_id || "msg", index))
                )
            ).filter((item): item is string => Boolean(item));

            const ctxPayload = runtime.channel.reply.finalizeInboundContext({
                Provider: "qq", Channel: "qq", From: fromId, To: "qq:bot", Body: bodyWithReply, RawBody: text,
                SenderId: String(userId), SenderName: event.sender?.nickname || "Unknown", ConversationLabel: conversationLabel,
                SessionKey: route.sessionKey, AccountId: route.accountId, ChatType: isGroup ? "group" : isGuild ? "channel" : "direct", Timestamp: event.time * 1000,
                Surface: "qq",
                OriginatingChannel: "qq", OriginatingTo: fromId, CommandAuthorized: true,
                ...(inboundMediaUrls.length > 0 && { MediaUrls: inboundMediaUrls }),
                ...(inboundMediaPaths.length > 0 && { MediaPaths: inboundMediaPaths }),
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
            const taskKey = buildTaskKey(accountId, isGroup, isGuild, groupId, guildId, channelId, userId);

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
                        void setGroupTypingCard(client, accountId, groupId, (config.processingStatusText || "输入中").trim() || "输入中");
                    }
                }, delayMs);
            }

            try { await runtime.channel.reply.dispatchReplyFromConfig({ ctx: ctxPayload, cfg, dispatcher, replyOptions });
            } catch (error) { if (config.enableErrorNotify) deliver({ text: "⚠️ 服务调用失败，请稍后重试。" }); }
            finally {
                clearProcessingTimers();
                activeTaskIds.delete(taskKey);
                if (typingCardActivated && isGroup) {
                    clearGroupTypingCard(client, accountId, groupId);
                }
            }
          } catch (err) {
            console.error("[QQ] Critical error in message handler:", err);
          }
}
