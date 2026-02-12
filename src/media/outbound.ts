import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OneBotClient } from "../client.js";
import type { OneBotMessage } from "../types.js";
import { downloadImageUrlAsBase64 } from "./vision.js";

export function isImageFile(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".png") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".webp")
  );
}

export function isAudioFile(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.endsWith(".wav") ||
    lower.endsWith(".mp3") ||
    lower.endsWith(".m4a") ||
    lower.endsWith(".ogg") ||
    lower.endsWith(".flac") ||
    lower.endsWith(".aac")
  );
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

    const preferred = preferredExt
      ? candidates.filter((filePath) => filePath.toLowerCase().endsWith(preferredExt.toLowerCase()))
      : [];
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

export async function ensureFileInSharedMedia(localPath: string, hostSharedDir: string): Promise<string> {
  const ext = path.extname(localPath) || ".dat";
  const baseName = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext}`;
  await fs.mkdir(hostSharedDir, { recursive: true });
  const destPath = path.join(hostSharedDir, baseName);
  await fs.copyFile(localPath, destPath);
  return baseName;
}

export function toLocalPathIfAny(value: string): string | null {
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

export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks = [];
  let current = text;
  while (current.length > 0) {
    chunks.push(current.slice(0, limit));
    current = current.slice(limit);
  }
  return chunks;
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/#+\s+(.*)/g, "$1")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/^\s*>\s+(.*)/gm, "▎$1")
    .replace(/```[\s\S]*?```/g, "[代码块]")
    .replace(/^\|.*\|$/gm, (match) => {
      return match.replace(/\|/g, " ").trim();
    })
    .replace(/^[\-\*]\s+/gm, "• ");
}

export function processAntiRisk(text: string): string {
  return text.replace(/(https?:\/\/)/gi, "$1 ");
}

export async function resolveMediaUrl(url: string): Promise<string> {
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

  const isRemoteHttp = url.startsWith("http://") || url.startsWith("https://");
  const isRemoteImage = isImageFile(url);
  if (isRemoteHttp && isRemoteImage) {
    // Fix: Use proper hostname parsing instead of substring match
    let isQQHost = false;
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      isQQHost =
        hostname === "qq.com" ||
        hostname.endsWith(".qq.com") ||
        hostname === "multimedia.nt.qq.com.cn" ||
        hostname.endsWith(".multimedia.nt.qq.com.cn") ||
        hostname === "gchat.qpic.cn" ||
        hostname === "c2cpicdw.qpic.cn" ||
        hostname === "puui.qpic.cn";
    } catch {
      // Fix: On URL parse failure, treat as non-QQ host and let downloadImageUrlAsBase64 handle it with SSRF protections
      isQQHost = false;
    }
    if (!isQQHost) {
      const converted = await downloadImageUrlAsBase64(url);
      if (converted) return converted;
      console.warn(`[QQ] External image base64 conversion failed, keep original URL: ${url}`);
    }
  }

  return url;
}

export async function resolveInlineCqRecord(text: string): Promise<string> {
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

export async function sendOneBotMessageWithAck(
  client: OneBotClient,
  to: string,
  message: OneBotMessage | string
): Promise<{ ok: boolean; data?: any; error?: string }> {
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
