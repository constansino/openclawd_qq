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

function splitLongText(input: string, maxLength = 2800): string[] {
  const text = (input || "").trim();
  if (!text) return [];
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf("\n", maxLength);
    if (cut < Math.floor(maxLength * 0.5)) cut = maxLength;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function grokDrawDirect(prompt: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const p = (prompt || "").trim();
  if (!p) return { ok: false, error: "缺少提示词。用法: /grok_draw <提示词>" };

  const baseUrl = (process.env.GROK2API_BASE_URL || "http://127.0.0.1:18001/v1").replace(/\/+$/, "");
  const apiKey = process.env.GROK2API_KEY || "grok2api";

  try {
    const resp = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-imagine-1.0",
        prompt: p,
        n: 1,
        size: "1024x1024",
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: `Grok API 错误: HTTP ${resp.status}${text ? ` | ${text.slice(0, 300)}` : ""}` };
    }

    const data = await resp.json().catch(() => null) as any;
    const url = typeof data?.data?.[0]?.url === "string" ? data.data[0].url.trim() : "";
    if (!url) return { ok: false, error: "Grok 返回中没有图片 URL" };
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: `调用 Grok 失败: ${String(err)}` };
  }
}
async function buildModelCatalogText(): Promise<string> {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    process.env.OPENCLAW_CONFIG,
    process.env.OPENCLAW_CONFIG_PATH,
    home ? path.join(home, ".openclaw", "openclaw.json") : "",
  ].filter((value): value is string => Boolean(value && value.trim()));

  let parsed: any = null;
  let usedPath = "";
  for (const cfgPath of candidates) {
    try {
      const raw = await fs.readFile(cfgPath, "utf-8");
      parsed = JSON.parse(raw);
      usedPath = cfgPath;
      break;
    } catch {}
  }

  if (!parsed) {
    return "[OpenClawd QQ]\n无法读取模型配置文件。请在服务器执行：openclaw status";
  }

  const providers = parsed?.models?.providers as Record<string, any> | undefined;
  const currentModel = typeof parsed?.agent?.model === "string" ? parsed.agent.model : "unknown";
  if (!providers || typeof providers !== "object") {
    return `[OpenClawd QQ]\nCurrent: ${currentModel}\n未找到 models.providers 配置。`;
  }

  const lines: string[] = [`[OpenClawd QQ]`, `Current: ${currentModel}`, `Providers:`];
  let index = 1;
  for (const [providerName, providerValue] of Object.entries(providers)) {
    const models = Array.isArray((providerValue as any)?.models) ? (providerValue as any).models : [];
    lines.push(`- ${providerName} (${models.length})`);
    for (const model of models) {
      const modelId = typeof model?.id === "string" && model.id.trim() ? model.id.trim() : "(no-id)";
      lines.push(`  ${index}. ${providerName}/${modelId}`);
      index += 1;
    }
  }
  lines.push(`Config: ${usedPath}`);
  return lines.join("\n");
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

async function resetSessionByKey(storePath: string, sessionKey: string): Promise<boolean> {
    try {
        const raw = await fs.readFile(storePath, "utf-8");
        const store = JSON.parse(raw) as Record<string, unknown>;
        if (!store || typeof store !== "object") return false;
        if (!(sessionKey in store)) return false;
        delete store[sessionKey];
        await fs.writeFile(storePath, JSON.stringify(store, null, 2));
        return true;
    } catch {
        return false;
    }
}

const clients = new Map<string, OneBotClient>();
const allClientsByAccount = new Map<string, Set<OneBotClient>>();
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

function stripTrailingBusySuffixes(card: string, busySuffix: string): string {
    const normalized = (card || "").trim();
    const suffix = (busySuffix || "输入中").trim();
    if (!normalized || !suffix) return normalized;

    const marker = `(${suffix})`;
    let result = normalized;
    while (result.endsWith(marker)) {
        result = result.slice(0, -marker.length).trimEnd();
    }
    return result.trim();
}

function countActiveTasksForAccount(accountId: string): number {
    let count = 0;
    const prefix = `${accountId}:`;
    for (const taskId of activeTaskIds) {
        if (taskId.startsWith(prefix)) count += 1;
    }
    return count;
}


const TEMP_SESSION_STATE_FILE = path.join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".openclaw",
    "workspace",
    "qq-temp-sessions.json",
);

type TempSessionState = {
    active?: Record<string, string>;
    history?: Record<string, string[]>;
};

const tempSessionSlots = new Map<string, string>();
const tempSessionHistory = new Map<string, string[]>();
let tempSessionSlotsLoaded = false;
let tempSessionSlotsLoading: Promise<void> | null = null;
const globalProcessedMsgIds = new Set<string>();
const recentCommandFingerprints = new Map<string, number>();
const accountStartGeneration = new Map<string, number>();
let globalProcessedMsgCleanupTimer: NodeJS.Timeout | null = null;

function ensureGlobalProcessedMsgCleanupTimer(): void {
    if (globalProcessedMsgCleanupTimer) return;
    globalProcessedMsgCleanupTimer = setInterval(() => {
        if (globalProcessedMsgIds.size > 5000) {
            globalProcessedMsgIds.clear();
        }
        const now = Date.now();
        for (const [key, ts] of recentCommandFingerprints.entries()) {
            if (now - ts > 10_000) {
                recentCommandFingerprints.delete(key);
            }
        }
    }, 3600000);
}

function markAndCheckRecentCommandDuplicate(key: string, ttlMs = 2500): boolean {
    const now = Date.now();
    const lastTs = recentCommandFingerprints.get(key);
    recentCommandFingerprints.set(key, now);
    return typeof lastTs === "number" && now - lastTs <= ttlMs;
}

function normalizeSlashVariants(input: string): string {
    if (!input) return "";
    return input.replace(/[／⁄∕]/g, "/");
}

function buildTempThreadKey(accountId: string, isGroup: boolean, isGuild: boolean, groupId?: number, guildId?: string, channelId?: string, userId?: number): string {
    if (isGroup && groupId !== undefined) return `${accountId}:group:${groupId}`;
    if (isGuild && guildId && channelId) return `${accountId}:guild:${guildId}:${channelId}`;
    return `${accountId}:dm:${String(userId ?? "unknown")}`;
}

function sanitizeTempSlotName(input: string | undefined): string {
    const raw = String(input || "").trim();
    if (!raw) return "";
    return raw
        .replace(/\s+/g, "-")
        .replace(/[^\p{L}\p{N}_-]+/gu, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
}

function buildEffectiveFromId(baseFromId: string, tempSlot: string | null): string {
    if (!tempSlot) return baseFromId;
    return `${baseFromId}::tmp:${tempSlot}`;
}

function getTempSessionHistory(threadKey: string): string[] {
    return tempSessionHistory.get(threadKey) || [];
}

function pushTempHistory(threadKey: string, slot: string): void {
    const prev = tempSessionHistory.get(threadKey) || [];
    const next = [slot, ...prev.filter((item) => item !== slot)];
    tempSessionHistory.set(threadKey, next);
}

async function ensureTempSessionSlotsLoaded(): Promise<void> {
    if (tempSessionSlotsLoaded) return;
    if (tempSessionSlotsLoading) {
        await tempSessionSlotsLoading;
        return;
    }
    tempSessionSlotsLoading = (async () => {
        try {
            const raw = await fs.readFile(TEMP_SESSION_STATE_FILE, "utf-8");
            const parsed = JSON.parse(raw) as TempSessionState | Record<string, string>;

            if (parsed && typeof parsed === "object" && "active" in parsed) {
                const state = parsed as TempSessionState;
                if (state.active && typeof state.active === "object") {
                    for (const [key, value] of Object.entries(state.active)) {
                        const slot = sanitizeTempSlotName(value);
                        if (slot) tempSessionSlots.set(key, slot);
                    }
                }
                if (state.history && typeof state.history === "object") {
                    for (const [key, values] of Object.entries(state.history)) {
                        if (!Array.isArray(values)) continue;
                        const cleaned = values
                            .map((value) => sanitizeTempSlotName(String(value)))
                            .filter(Boolean);
                        if (cleaned.length > 0) tempSessionHistory.set(key, cleaned);
                    }
                }
            } else if (parsed && typeof parsed === "object") {
                for (const [key, value] of Object.entries(parsed)) {
                    const slot = sanitizeTempSlotName(String(value));
                    if (slot) {
                        tempSessionSlots.set(key, slot);
                        pushTempHistory(key, slot);
                    }
                }
            }
        } catch {}
        tempSessionSlotsLoaded = true;
    })();
    await tempSessionSlotsLoading;
    tempSessionSlotsLoading = null;
}

async function reloadTempSessionStateFromDisk(): Promise<void> {
    try {
        const raw = await fs.readFile(TEMP_SESSION_STATE_FILE, "utf-8");
        const parsed = JSON.parse(raw) as TempSessionState | Record<string, string>;
        const nextSlots = new Map<string, string>();
        const nextHistory = new Map<string, string[]>();

        if (parsed && typeof parsed === "object" && "active" in parsed) {
            const state = parsed as TempSessionState;
            if (state.active && typeof state.active === "object") {
                for (const [key, value] of Object.entries(state.active)) {
                    const slot = sanitizeTempSlotName(value);
                    if (slot) nextSlots.set(key, slot);
                }
            }
            if (state.history && typeof state.history === "object") {
                for (const [key, values] of Object.entries(state.history)) {
                    if (!Array.isArray(values)) continue;
                    const cleaned = values
                        .map((value) => sanitizeTempSlotName(String(value)))
                        .filter(Boolean);
                    if (cleaned.length > 0) nextHistory.set(key, cleaned);
                }
            }
        } else if (parsed && typeof parsed === "object") {
            for (const [key, value] of Object.entries(parsed)) {
                const slot = sanitizeTempSlotName(String(value));
                if (!slot) continue;
                nextSlots.set(key, slot);
                nextHistory.set(key, [slot]);
            }
        } else {
            return;
        }

        tempSessionSlots.clear();
        tempSessionHistory.clear();
        for (const [key, value] of nextSlots.entries()) tempSessionSlots.set(key, value);
        for (const [key, values] of nextHistory.entries()) tempSessionHistory.set(key, values);
        tempSessionSlotsLoaded = true;
    } catch (err) {
        console.warn(`[QQ] Failed to reload temp session state from disk: ${String(err)}`);
    }
}

async function persistTempSessionSlots(): Promise<void> {
    try {
        await fs.mkdir(path.dirname(TEMP_SESSION_STATE_FILE), { recursive: true });
        const active: Record<string, string> = {};
        for (const [key, value] of tempSessionSlots.entries()) {
            active[key] = value;
        }
        const history: Record<string, string[]> = {};
        for (const [key, values] of tempSessionHistory.entries()) {
            if (values.length > 0) history[key] = values;
        }
        const state: TempSessionState = { active, history };
        await fs.writeFile(TEMP_SESSION_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
    } catch (err) {
        console.warn(`[QQ] Failed to persist temp session slots: ${String(err)}`);
    }
}

function getTempSessionSlot(threadKey: string): string | null {
    const slot = tempSessionSlots.get(threadKey);
    return slot || null;
}

async function setTempSessionSlot(threadKey: string, slot: string | null): Promise<void> {
    if (slot) {
        tempSessionSlots.set(threadKey, slot);
        pushTempHistory(threadKey, slot);
    } else {
        tempSessionSlots.delete(threadKey);
    }
    await persistTempSessionSlots();
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
        const suffix = (busySuffix || "输入中").trim();
        const currentCard = (info?.card || info?.nickname || "").trim();
        const baseCard = stripTrailingBusySuffixes(currentCard, suffix);
        groupBaseCards.set(groupKey, baseCard);
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
        const suffix = "输入中";
        const baseCard = stripTrailingBusySuffixes(groupBaseCards.get(groupKey) || "", suffix);
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isImageFile(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.gif') || lower.endsWith('.webp');
}

function isAudioFile(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.endsWith('.wav') || lower.endsWith('.mp3') || lower.endsWith('.m4a') || lower.endsWith('.ogg') || lower.endsWith('.flac') || lower.endsWith('.aac');
}

function isVideoFile(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.endsWith(".mp4") || lower.endsWith(".mov") || lower.endsWith(".mkv") || lower.endsWith(".avi") || lower.endsWith(".webm") || lower.endsWith(".m4v");
}

type MediaKind = "image" | "audio" | "video" | "file";

function detectMediaKind(...values: Array<string | undefined | null>): MediaKind {
    for (const value of values) {
        if (!value) continue;
        if (value.startsWith("base64://")) return "image";
        if (isImageFile(value)) return "image";
        if (isAudioFile(value)) return "audio";
        if (isVideoFile(value)) return "video";
    }
    return "file";
}

function classifyMediaError(error: string): "rich_media" | "timeout" | "connection" | "permission" | "unsupported" | "unknown" {
    const msg = (error || "").toLowerCase();
    if (msg.includes("rich media transfer failed") || msg.includes("rich media")) return "rich_media";
    if (msg.includes("timeout")) return "timeout";
    if (msg.includes("websocket not open") || msg.includes("econn") || msg.includes("connection")) return "connection";
    if (msg.includes("permission") || msg.includes("forbidden") || msg.includes("denied")) return "permission";
    if (msg.includes("unsupported") || msg.includes("not supported") || msg.includes("unknown action")) return "unsupported";
    return "unknown";
}

function parseGroupIdFromTarget(to: string): number | null {
    if (!to.startsWith("group:")) return null;
    const n = parseInt(to.replace("group:", ""), 10);
    return Number.isFinite(n) ? n : null;
}

function guessFileName(input: string): string {
    const local = toLocalPathIfAny(input);
    const name = path.basename(local || input.split("?")[0].split("#")[0]);
    if (!name || name === "." || name === "/") return `media_${Date.now()}.bin`;
    return name;
}

async function stageLocalFileForContainer(localPath: string, hostSharedDir: string, containerSharedDir: string): Promise<string | null> {
    if (!hostSharedDir) return null;
    try {
        const copiedName = await ensureFileInSharedMedia(localPath, hostSharedDir);
        return path.posix.join(containerSharedDir.replace(/\\/g, "/"), copiedName);
    } catch (err) {
        console.warn(`[QQ] Failed to stage local file into shared media dir: ${String(err)}`);
        return null;
    }
}

async function uploadGroupFile(
    client: OneBotClient,
    groupId: number,
    filePath: string,
    fileName: string,
): Promise<{ ok: boolean; data?: any; error?: string }> {
    try {
        const data = await (client as any).sendWithResponse("upload_group_file", {
            group_id: groupId,
            file: filePath,
            name: fileName,
        }, 30000);
        return { ok: true, data };
    } catch (err) {
        return { ok: false, error: String(err) };
    }
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

          const runningClient = clients.get(account.accountId);
          if (runningClient) {
              try {
                  const info = await Promise.race([
                      runningClient.getLoginInfo(),
                      new Promise((_, reject) => setTimeout(() => reject(new Error("Probe timeout")), timeoutMs || 5000)),
                  ]);
                  const data = info as any;
                  return {
                      ok: true,
                      bot: { id: String(data?.user_id ?? ""), username: data?.nickname },
                  };
              } catch (err) {
                  return { ok: false, error: String(err) };
              }
          }
          
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
                  client.disconnect();
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
        const accountGen = (accountStartGeneration.get(account.accountId) || 0) + 1;
        accountStartGeneration.set(account.accountId, accountGen);
        accountConfigs.set(account.accountId, config);
        const adminIds = [...new Set(parseIdListInput(config.admins as string | number | Array<string | number> | undefined))];
        const allowedGroupIds = [...new Set(parseIdListInput(config.allowedGroups as string | number | Array<string | number> | undefined))];
        const blockedUserIds = [...new Set(parseIdListInput(config.blockedUsers as string | number | Array<string | number> | undefined))];
        const blockedNotifyCooldownMs = Math.max(0, Number(config.blockedNotifyCooldownMs ?? 10000));

        if (!config.wsUrl) throw new Error("QQ: wsUrl is required");

        const existingLiveClient = clients.get(account.accountId);
        if (existingLiveClient?.isConnected()) {
            console.log(`[QQ] Existing live client detected for account ${account.accountId}; skip duplicate start`);
            return;
        }

        // 1. Prevent multiple clients for the same account
        const existingSet = allClientsByAccount.get(account.accountId);
        if (existingSet && existingSet.size > 0) {
            console.log(`[QQ] Disconnecting ${existingSet.size} stale client(s) for account ${account.accountId}`);
            for (const stale of existingSet) {
                try { stale.disconnect(); } catch {}
            }
            existingSet.clear();
        }
        const existingClient = clients.get(account.accountId);
        if (existingClient) {
            console.log(`[QQ] Stopping existing client for account ${account.accountId} before restart`);
            existingClient.disconnect();
        }

        const client = new OneBotClient({
            wsUrl: config.wsUrl,
            accessToken: config.accessToken,
        });

        const isStaleGeneration = () => accountStartGeneration.get(account.accountId) !== accountGen;
        
        clients.set(account.accountId, client);
        const clientSet = allClientsByAccount.get(account.accountId) || new Set<OneBotClient>();
        clientSet.add(client);
        allClientsByAccount.set(account.accountId, clientSet);
        ensureGlobalProcessedMsgCleanupTimer();

        client.on("connect", async () => {
             if (isStaleGeneration()) {
                console.log(`[QQ] Ignore stale client connect for account ${account.accountId} gen=${accountGen}`);
                client.disconnect();
                return;
             }
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

        client.on("heartbeat", () => {
            if (isStaleGeneration()) return;
            getQQRuntime().channel.activity.record({
                channel: "qq",
                accountId: account.accountId,
                direction: "inbound",
            });
        });

        client.on("request", (event) => {
            if (isStaleGeneration()) return;
            if (config.autoApproveRequests) {
                if (event.request_type === "friend") client.setFriendAddRequest(event.flag, true);
                else if (event.request_type === "group") client.setGroupAddRequest(event.flag, event.sub_type, true);
            }
        });

        client.on("message", async (event) => {
          try {
            if (isStaleGeneration()) return;
            getQQRuntime().channel.activity.record({
                channel: "qq",
                accountId: account.accountId,
                direction: "inbound",
            });
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
                const msgIdKey = `${account.accountId}:${event.self_id ?? ""}:${event.message_type ?? ""}:${event.group_id ?? ""}:${event.user_id ?? ""}:${String(event.message_id)}`;
                if (globalProcessedMsgIds.has(msgIdKey)) return;
                globalProcessedMsgIds.add(msgIdKey);
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
                                        imageUrl = resolved.startsWith("/") ? `file://${resolved}` : resolved;
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
            await ensureTempSessionSlotsLoaded();
            const threadSessionKey = buildTempThreadKey(account.accountId, isGroup, isGuild, groupId, guildId, channelId, userId);
            let activeTempSlot = getTempSessionSlot(threadSessionKey);
            const extractedTextFromSegments = Array.isArray(event.message)
                ? event.message
                    .filter((seg) => seg?.type === "text")
                    .map((seg) => String(seg.data?.text || ""))
                    .join(" ")
                    .trim()
                : "";
            // Some OneBot variants may not emit text segments for plain messages.
            // Fall back to already-normalized text to avoid losing slash commands.
            const commandTextCandidate = normalizeSlashVariants(extractedTextFromSegments || text.trim());
            const slashMatch = commandTextCandidate.match(/[\/]/);
            const slashIdx = slashMatch ? slashMatch.index ?? -1 : -1;
            const inlineCommand = slashIdx >= 0 ? commandTextCandidate.slice(slashIdx).trim() : "";
            if (inlineCommand) {
                const shortInline = inlineCommand.replace(/\s+/g, " ").slice(0, 160);
                console.log(`[QQCMD] inbound user=${userId} group=${groupId ?? "-"} admin=${isAdmin} cmd="${shortInline}"`);
            }
            const normalizedCommandKey = inlineCommand
                ? `${account.accountId}:${event.message_type ?? ""}:${String(groupId ?? "")}:${String(guildId ?? "")}:${String(channelId ?? "")}:${String(userId ?? "")}:${inlineCommand.replace(/\s+/g, " ").toLowerCase()}`
                : "";
            if (normalizedCommandKey && markAndCheckRecentCommandDuplicate(normalizedCommandKey)) {
                console.log(`[QQ] dropped duplicate command key=${normalizedCommandKey}`);
                return;
            }

            let forceTriggered = false;
            if (isGroup && /^\/models\b/i.test(inlineCommand)) {
                if (!isAdmin) return;
                text = inlineCommand;
                forceTriggered = true;
            } else if (isGroup && /^\/model\b/i.test(inlineCommand)) {
                if (!isAdmin) return;
                text = inlineCommand;
                forceTriggered = true;
            } else if (isGroup && /^\/newsession\b/i.test(inlineCommand)) {
                if (!isAdmin) return;
                text = "/newsession";
                forceTriggered = true;
            }
            else if (isGroup && /^\/(临时|tmp|退出临时|exittemp|临时状态|tmpstatus|临时列表|tmplist|临时结束|tmpend|临时重命名|tmprename)\b/i.test(inlineCommand)) {
                if (!isAdmin) {
                    console.warn(`[QQCMD] temp command denied: non-admin user=${userId} group=${groupId ?? "-"}`);
                    if (config.notifyNonAdminBlocked) {
                        client.sendGroupMsg(groupId, `[CQ:at,qq=${userId}] 当前仅管理员可使用临时会话命令。`);
                    }
                    return;
                }
                text = inlineCommand;
                forceTriggered = true;
                console.log(`[QQCMD] temp command accepted user=${userId} group=${groupId ?? "-"}`);
            }
            else if (isGroup && /^\/grok_draw\b/i.test(inlineCommand)) {
                text = inlineCommand;
                forceTriggered = true;
            }

            const normalizedTextForCommand = normalizeSlashVariants(text).trim();
            if (!isGuild && isAdmin && normalizedTextForCommand.startsWith('/')) {
                const parts = normalizedTextForCommand.split(/\s+/);
                const cmd = parts[0];
                const baseFromIdForCommand = isGroup
                    ? String(groupId)
                    : isGuild
                        ? `guild:${guildId}:${channelId}`
                        : `qq:user:${userId}`;

                if (cmd === '/临时' || cmd === '/tmp') {
                    const requested = sanitizeTempSlotName(parts.slice(1).join(' '));
                    if (!requested) {
                        const current = activeTempSlot
                            ? `当前临时会话: ${activeTempSlot}`
                            : "当前未启用临时会话。";
                        const usage = `[OpenClawd QQ]
${current}
用法:
/临时 <名称> 进入临时会话
/临时重命名 <新名称> 重命名当前临时会话
/退出临时 回到主会话
/临时状态 查看当前会话
/临时列表 查看已有临时会话
/临时结束 结束当前临时会话`;
                        if (isGroup) client.sendGroupMsg(groupId, usage); else client.sendPrivateMsg(userId, usage);
                        return;
                    }
                    await setTempSessionSlot(threadSessionKey, requested);
                    activeTempSlot = requested;
                    const msg = `[OpenClawd QQ]
✅ 已进入临时会话: ${requested}
后续消息将写入临时会话，不占用主会话。\n可用命令：/临时状态 /临时列表 /临时重命名 /退出临时 /临时结束`;
                    if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                    return;
                }

                if (cmd === '/临时重命名' || cmd === '/tmprename') {
                    if (!activeTempSlot) {
                        const msg = `[OpenClawd QQ]\n当前未在临时会话中，无法重命名。\n先用 /临时 <名称> 进入临时会话。`;
                        if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                        return;
                    }
                    const renamed = sanitizeTempSlotName(parts.slice(1).join(' '));
                    if (!renamed) {
                        const msg = `[OpenClawd QQ]\n用法：/临时重命名 <新名称>`;
                        if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                        return;
                    }
                    const oldName = activeTempSlot;
                    await setTempSessionSlot(threadSessionKey, renamed);
                    activeTempSlot = renamed;
                    const msg = `[OpenClawd QQ]\n✅ 临时会话已重命名：${oldName} -> ${renamed}`;
                    if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                    return;
                }

                if (cmd === '/退出临时' || cmd === '/exittemp') {
                    if (!activeTempSlot) {
                        const msg = `[OpenClawd QQ]
当前未在临时会话中。`;
                        if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                        return;
                    }
                    const prev = activeTempSlot;
                    await setTempSessionSlot(threadSessionKey, null);
                    activeTempSlot = null;
                    const msg = `[OpenClawd QQ]
✅ 已退出临时会话: ${prev}
当前已回到主会话。`;
                    if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                    return;
                }

                if (cmd === '/临时状态' || cmd === '/tmpstatus') {
                    const effective = buildEffectiveFromId(baseFromIdForCommand, activeTempSlot);
                    const msg = `[OpenClawd QQ]
当前会话: ${activeTempSlot ? `临时(${activeTempSlot})` : '主会话'}
会话键ID: ${effective}`;
                    if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                    return;
                }

                if (cmd === '/临时列表' || cmd === '/tmplist') {
                    await reloadTempSessionStateFromDisk();
                    activeTempSlot = getTempSessionSlot(threadSessionKey);
                    const slots = getTempSessionHistory(threadSessionKey);
                    console.log(`[QQ] /临时列表 thread=${threadSessionKey} slots=${slots.length}`);
                    try {
                        const rawState = await fs.readFile(TEMP_SESSION_STATE_FILE, "utf-8");
                        const parsedState = JSON.parse(rawState) as TempSessionState;
                        const diskSlots = Array.isArray(parsedState?.history?.[threadSessionKey])
                            ? parsedState.history![threadSessionKey]!.length
                            : 0;
                        console.error(`[QQDBG] /临时列表 thread=${threadSessionKey} mem=${slots.length} disk=${diskSlots}`);
                    } catch (err) {
                        console.error(`[QQDBG] /临时列表 read-state-failed thread=${threadSessionKey} err=${String(err)}`);
                    }
                    const rendered = slots.length > 0
                        ? slots.map((slot, idx) => `${idx + 1}. ${slot}${slot === activeTempSlot ? ' (当前)' : ''}`).join("\n")
                        : "（暂无）";
                    const msg = `[OpenClawd QQ]\n临时会话列表：\n${rendered}\n使用 /临时 <名称> 进入会话`;
                    if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                    return;
                }

                if (cmd === '/临时结束' || cmd === '/tmpend') {
                    if (!activeTempSlot) {
                        const msg = `[OpenClawd QQ]
当前未在临时会话中。`;
                        if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                        return;
                    }
                    const runtimeForEnd = getQQRuntime();
                    const tempFromId = buildEffectiveFromId(baseFromIdForCommand, activeTempSlot);
                    const routeForEnd = runtimeForEnd.channel.routing.resolveAgentRoute({
                        cfg,
                        channel: "qq",
                        accountId: account.accountId,
                        peer: {
                            kind: isGuild ? "channel" : (isGroup ? "group" : "direct"),
                            id: tempFromId,
                        },
                    });
                    const storePathForEnd = runtimeForEnd.channel.session.resolveStorePath(cfg.session?.store, { agentId: routeForEnd.agentId });
                    await resetSessionByKey(storePathForEnd, routeForEnd.sessionKey);
                    await setTempSessionSlot(threadSessionKey, null);
                    const msg = `[OpenClawd QQ]
✅ 临时会话 ${activeTempSlot} 已结束并清空，已回到主会话。`;
                    activeTempSlot = null;
                    if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                    return;
                }
                if (cmd === '/models' || (cmd === '/model' && (!parts[1] || /^list$/i.test(parts[1])))) {
                    const catalog = await buildModelCatalogText();
                    const chunks = splitLongText(catalog, 2800);
                    for (const chunk of chunks) {
                        if (isGroup) client.sendGroupMsg(groupId, chunk);
                        else client.sendPrivateMsg(userId, chunk);
                        if (config.rateLimitMs > 0) await sleep(Math.min(config.rateLimitMs, 800));
                    }
                    return;
                }
                if (cmd === '/newsession') {
                    const runtimeForReset = getQQRuntime();
                    const baseFromIdForReset = isGroup
                        ? String(groupId)
                        : isGuild
                            ? `guild:${guildId}:${channelId}`
                            : `qq:user:${userId}`;
                    const fromIdForReset = buildEffectiveFromId(baseFromIdForReset, activeTempSlot);
                    const routeForReset = runtimeForReset.channel.routing.resolveAgentRoute({
                        cfg,
                        channel: "qq",
                        accountId: account.accountId,
                        peer: {
                            kind: isGuild ? "channel" : (isGroup ? "group" : "direct"),
                            id: fromIdForReset,
                        },
                    });
                    const storePath = runtimeForReset.channel.session.resolveStorePath(cfg.session?.store, { agentId: routeForReset.agentId });
                    const resetOk = await resetSessionByKey(storePath, routeForReset.sessionKey);
                    const notice = resetOk
                        ? "✅ 当前会话已重置。请继续发送你的问题。"
                        : "ℹ️ 当前会话本就为空，已为你准备新会话。";
                    if (isGroup) client.sendGroupMsg(groupId, `[CQ:at,qq=${userId}] ${notice}`);
                    else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, notice);
                    else client.sendPrivateMsg(userId, notice);
                    return;
                }
                if (cmd === '/grok_draw') {
                    const prompt = text.trim().slice('/grok_draw'.length).trim();
                    console.log(`[QQ] direct command hit: /grok_draw prompt_len=${prompt.length} group=${groupId || "-"} user=${userId}`);
                    const draw = await grokDrawDirect(prompt);
                    if (!draw.ok) {
                        const fail = `[OpenClawd QQ]\n❌ ${draw.error}`;
                        if (isGroup) client.sendGroupMsg(groupId, `[CQ:at,qq=${userId}] ${fail}`);
                        else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, fail);
                        else client.sendPrivateMsg(userId, fail);
                        return;
                    }
                    const okMsg = `[CQ:image,file=${draw.url}]`;
                    if (isGroup) client.sendGroupMsg(groupId, okMsg);
                    else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, okMsg);
                    else client.sendPrivateMsg(userId, okMsg);
                    return;
                }
                if (cmd === '/status') {
                    const activeCount = countActiveTasksForAccount(account.accountId);
                    const statusMsg = `[OpenClawd QQ]\nState: Connected\nSelf ID: ${client.getSelfId()}\nMemory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB\nActiveTasks: ${activeCount}`;
                    if (isGroup) client.sendGroupMsg(groupId, statusMsg); else client.sendPrivateMsg(userId, statusMsg);
                    return;
                }
                if (cmd === '/help') {
                    const helpMsg = `[OpenClawd QQ]
/status - 状态
/临时 <名称> - 进入临时会话
/临时重命名 <新名称> - 重命名当前临时会话
/退出临时 - 回到主会话
/临时状态 - 查看当前会话
/临时列表 - 查看最近临时会话
/临时结束 - 结束当前临时会话
/newsession - 重置当前会话
/mute @用户 [分] - 禁言
/kick @用户 - 踢出
/help - 帮助`;
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

            let baseFromId = `qq:user:${userId}`;
            let conversationLabel = `QQ User ${userId}`;
            if (isGroup) {
                baseFromId = String(groupId);
                conversationLabel = `QQ Group ${groupId}`;
            } else if (isGuild) {
                baseFromId = `guild:${guildId}:${channelId}`;
                conversationLabel = `QQ Guild ${guildId} Channel ${channelId}`;
            }
            const fromId = buildEffectiveFromId(baseFromId, activeTempSlot);
            if (activeTempSlot) {
                conversationLabel = `${conversationLabel} [tmp:${activeTempSlot}]`;
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

            let deliveredAnything = false;

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
                 if (payload.text && payload.text.trim()) {
                     deliveredAnything = true;
                     await send(payload.text);
                 }
                 if (payload.files) {
                     if (payload.files.length > 0) deliveredAnything = true;
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
                const shouldFallback = config.enableEmptyReplyFallback !== false && !text.trim().startsWith('/');
                if (shouldFallback && !deliveredAnything) {
                    const fallbackText = (config.emptyReplyFallbackText || "⚠️ 本轮模型返回空内容。请重试，或先执行 /newsession 后再试。").trim();
                    if (fallbackText) {
                        if (isGroup) client.sendGroupMsg(groupId, `[CQ:at,qq=${userId}] ${fallbackText}`);
                        else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, fallbackText);
                        else client.sendPrivateMsg(userId, fallbackText);
                    }
                }
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
            if (accountStartGeneration.get(account.accountId) === accountGen) {
                accountStartGeneration.set(account.accountId, accountGen + 1);
            }
            client.disconnect(); 
            clients.delete(account.accountId); 
            accountConfigs.delete(account.accountId);
            const setForAccount = allClientsByAccount.get(account.accountId);
            if (setForAccount) {
                setForAccount.delete(client);
                if (setForAccount.size === 0) {
                    allClientsByAccount.delete(account.accountId);
                }
            }
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

         const sourceKind = detectMediaKind(mediaUrl);
         const groupId = parseGroupIdFromTarget(to);
         const localSourcePath = toLocalPathIfAny(mediaUrl);
         let stagedSharedPath: string | null = null;
         if (localSourcePath && hostSharedDir) {
             stagedSharedPath = await stageLocalFileForContainer(localSourcePath, hostSharedDir, containerSharedDir);
         }

         const audioLikeSource = sourceKind === "audio";
         let stagedAudioFile: string | null = null;
         if (audioLikeSource && hostSharedDir) {
             if (localSourcePath) {
                 try {
                     const copiedName = await ensureFileInSharedMedia(localSourcePath, hostSharedDir);
                     stagedAudioFile = path.posix.join(containerSharedDir.replace(/\\/g, "/"), copiedName);
                 } catch (err) {
                     console.warn(`[QQ] Failed to stage source audio into shared media dir: ${String(err)}`);
                 }
             }
         }
         const finalUrl = sourceKind === "image" || sourceKind === "audio"
             ? await resolveMediaUrl(mediaUrl)
             : mediaUrl;

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
         const mediaKind = detectMediaKind(mediaUrl, finalUrl);
         const audioLike = mediaKind === "audio";
         const imageLike = mediaKind === "image";
         const videoLike = mediaKind === "video";
         const fileLike = mediaKind === "file";

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
         else if (videoLike) {
             const videoFile = stagedSharedPath || finalUrl;
             mediaMessage.push({ type: "video", data: { file: videoFile } });
         } else {
             if (groupId && (stagedSharedPath || localSourcePath)) {
                 const uploadPath = stagedSharedPath || localSourcePath!;
                 const uploadName = guessFileName(mediaUrl);
                 const uploadAck = await uploadGroupFile(client, groupId, uploadPath, uploadName);
                 if (uploadAck.ok) {
                     return {
                         channel: "qq",
                         sent: true,
                         textSent: Boolean(textAck),
                         mediaSent: true,
                         transport: "upload_group_file",
                         mediaKind: "file",
                         messageId: textAck?.message_id ?? textAck?.messageId ?? null,
                     };
                 }
                 console.warn(`[QQ] upload_group_file failed (primary path): ${uploadAck.error || "unknown"}`);
             }
             mediaMessage.push({ type: "file", data: { file: stagedSharedPath || finalUrl, name: guessFileName(mediaUrl) } });
         }

         const mediaAck = await sendOneBotMessageWithAck(client, to, mediaMessage);
         if (!mediaAck.ok) {
             const primaryError = mediaAck.error || "unknown";
             const errorClass = classifyMediaError(primaryError);
             if ((videoLike || fileLike) && groupId && (stagedSharedPath || localSourcePath)) {
                 const uploadPath = stagedSharedPath || localSourcePath!;
                 const uploadName = guessFileName(mediaUrl);
                 const uploadAck = await uploadGroupFile(client, groupId, uploadPath, uploadName);
                 if (uploadAck.ok) {
                     return {
                         channel: "qq",
                         sent: true,
                         textSent: Boolean(textAck),
                         mediaSent: true,
                         fallbackSent: true,
                         fallbackType: "upload_group_file",
                         mediaKind: videoLike ? "video" : "file",
                         errorClass,
                         error: `Primary media path failed; fallback upload_group_file succeeded. reason=${primaryError}`,
                         messageId: textAck?.message_id ?? textAck?.messageId ?? null,
                     };
                 }
             }
             if (audioLike) {
                 const fileFallback: OneBotMessage = [];
                 if (replyTo && !(text && text.trim())) fileFallback.push({ type: "reply", data: { id: String(replyTo) } });
                 let fallbackFile = stagedAudioFile || finalUrl;
                 if (fallbackFile.startsWith("base64://")) {
                     return {
                         channel: "qq",
                         sent: Boolean(textAck),
                         error: `Media send failed: ${primaryError}`,
                         errorClass,
                         mediaKind: "audio",
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
                         errorClass,
                         mediaKind: "audio",
                         error: `Audio(record) failed; fallback file sent. reason=${primaryError}`,
                         messageId: fallbackAck.data?.message_id ?? fallbackAck.data?.messageId ?? textAck?.message_id ?? textAck?.messageId ?? null,
                     };
                 }
             }
             return {
                 channel: "qq",
                 sent: Boolean(textAck),
                 error: `Media send failed: ${primaryError}`,
                 errorClass,
                 mediaKind: mediaKind,
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
             mediaKind,
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
  }
};
