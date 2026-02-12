import { promises as fs } from "node:fs";
import path from "node:path";

export const MAX_VISION_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VISION_IMAGE_COUNT = 3;
export const VISION_IMAGE_TIMEOUT_MS = 15_000;

const QQ_TMP_PREFIX = "qq_vision_";

// 允许的本地文件目录（安全白名单）
const ALLOWED_LOCAL_PATH_PREFIXES = [
  "/tmp",
  "/var/tmp",
  "/temp",
  process.env.TMPDIR,
  process.env.TEMP,
  process.env.HOME ? path.join(process.env.HOME, ".openclaw") : undefined,
].filter((p): p is string => typeof p === "string" && p.length > 0);

// 添加 OneBot/NapCat 可能的缓存目录
function getOneBotCacheDirs(): string[] {
  const dirs: string[] = [];
  // NapCat 常见缓存路径
  if (process.env.HOME) {
    dirs.push(path.join(process.env.HOME, ".config", "NapCat", "cache"));
    dirs.push(path.join(process.env.HOME, ".napcat"));
    dirs.push(path.join(process.env.HOME, "napcat"));
  }
  // 可能的系统临时目录
  if (process.env.TMPDIR) dirs.push(process.env.TMPDIR);
  if (process.env.TEMP) dirs.push(process.env.TEMP);
  return dirs;
}

const SAFE_PATH_PREFIXES = [...ALLOWED_LOCAL_PATH_PREFIXES, ...getOneBotCacheDirs()];

// 检查路径是否在允许的安全目录内
function isPathInSafeLocation(filePath: string): boolean {
  const resolvedPath = path.resolve(filePath);
  return SAFE_PATH_PREFIXES.some((prefix) => {
    const resolvedPrefix = path.resolve(prefix);
    // Fix: Use path-boundary check to prevent /tmp_evil matching /tmp
    const relative = path.relative(resolvedPrefix, resolvedPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

// SSRF 防护：检查 URL 是否指向私有/内部网络
function isPrivateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    // 检查 localhost 及其变体
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0") {
      return true;
    }

    // 检查 IPv4 私有地址段
    const ipv4PrivateRanges = [
      /^10\./, // 10.0.0.0/8
      /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12
      /^192\.168\./, // 192.168.0.0/16
      /^127\./, // 127.0.0.0/8
      /^169\.254\./, // 链路本地地址
      /^0\./, // 当前网络
      /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // 运营商级 NAT (100.64.0.0/10)
    ];

    if (ipv4PrivateRanges.some((range) => range.test(hostname))) {
      return true;
    }

    // 检查 IPv6 私有地址段
    const ipv6PrivateRanges = [
      /^::$/,
      /^::1$/,
      /^fc00:/i, // 唯一本地地址
      /^fe80:/i, // 链路本地地址
      /^ff00:/i, // 多播地址
    ];

    if (ipv6PrivateRanges.some((range) => range.test(hostname))) {
      return true;
    }

    return false;
  } catch {
    return true; // 解析失败，保守起见认为是私有的
  }
}

function extFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const mime = contentType.split(";")[0]?.trim().toLowerCase();
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/bmp") return ".bmp";
  return null;
}

function extFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const ext = path.extname(parsed.pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) {
      return ext === ".jpeg" ? ".jpg" : ext;
    }
  } catch {
    return null;
  }
  return null;
}

export function parseContentLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function readResponseBodyWithLimit(res: Response, maxBytes: number, controller?: AbortController): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      received += value.byteLength;
      if (received > maxBytes) {
        controller?.abort();
        return null;
      }
      chunks.push(value);
    }

    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), received);
  } finally {
    reader.releaseLock();
  }
}

async function writeTempImageFile(buffer: Buffer, messageId: string | number, index: number, extHint: string): Promise<string> {
  const safeExt = extHint.startsWith(".") ? extHint : ".jpg";
  const name = `${QQ_TMP_PREFIX}${messageId}_${Date.now()}_${index}${safeExt}`;
  const outPath = path.join("/tmp", name);
  await fs.writeFile(outPath, buffer);
  return outPath;
}

export async function materializeImageForVision(rawUrl: string, messageId: string | number, index: number): Promise<string | null> {
  if (!rawUrl) return null;

  try {
    if (rawUrl.startsWith("base64://")) {
      const encoded = rawUrl.slice("base64://".length);
      if (!encoded) return null;
      const buffer = Buffer.from(encoded, "base64");
      if (!buffer.length || buffer.length > MAX_VISION_IMAGE_BYTES) return null;
      return await writeTempImageFile(buffer, messageId, index, ".jpg");
    }

    if (rawUrl.startsWith("file://")) {
      const localPath = decodeURIComponent(rawUrl.slice("file://".length));
      if (!localPath) return null;
      
      // 安全检查：只允许安全目录内的文件
      if (!isPathInSafeLocation(localPath)) {
        console.warn(`[QQ] Rejected file:// URL outside safe directories: ${localPath}`);
        return null;
      }
      
      const stat = await fs.stat(localPath).catch(() => null);
      if (!stat || !stat.isFile() || stat.size > MAX_VISION_IMAGE_BYTES) return null;
      return localPath;
    }

    if (rawUrl.startsWith("/")) {
      // 安全检查：只允许安全目录内的文件
      if (!isPathInSafeLocation(rawUrl)) {
        console.warn(`[QQ] Rejected local path outside safe directories: ${rawUrl}`);
        return null;
      }
      
      const stat = await fs.stat(rawUrl).catch(() => null);
      if (!stat || !stat.isFile() || stat.size > MAX_VISION_IMAGE_BYTES) return null;
      return rawUrl;
    }

    if (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) return null;

    // SSRF 防护：阻止私有网络请求
    if (isPrivateUrl(rawUrl)) {
      console.warn(`[QQ] Rejected request to private/internal URL: ${rawUrl}`);
      return null;
    }

    const headController = new AbortController();
    const headTimeout = setTimeout(() => headController.abort(), VISION_IMAGE_TIMEOUT_MS);
    try {
      const headRes = await fetch(rawUrl, { method: "HEAD", signal: headController.signal });
      if (headRes.ok) {
        const len = parseContentLength(headRes.headers);
        if (len !== null && len > MAX_VISION_IMAGE_BYTES) return null;
      }
    } catch {
      // Some hosts block HEAD requests; enforce size again during GET.
    } finally {
      clearTimeout(headTimeout);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VISION_IMAGE_TIMEOUT_MS);
    try {
      const res = await fetch(rawUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (OpenClaw QQ)",
        },
      });
      if (!res.ok) return null;

      const len = parseContentLength(res.headers);
      if (len !== null && len > MAX_VISION_IMAGE_BYTES) return null;

      const body = await readResponseBodyWithLimit(res, MAX_VISION_IMAGE_BYTES, controller);
      if (!body || !body.length) return null;

      const ext = extFromContentType(res.headers.get("content-type")) || extFromUrl(rawUrl) || ".jpg";
      return await writeTempImageFile(body, messageId, index, ext);
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.warn(`[QQ] Failed to prepare image for vision: ${String(error)}`);
    return null;
  }
}

export async function downloadImageUrlAsBase64(rawUrl: string): Promise<string | null> {
  // SSRF 防护：阻止私有网络请求
  if (isPrivateUrl(rawUrl)) {
    console.warn(`[QQ] Rejected download from private/internal URL: ${rawUrl}`);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VISION_IMAGE_TIMEOUT_MS);

  try {
    const res = await fetch(rawUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (OpenClaw QQ)",
      },
    });

    if (!res.ok) return null;

    const len = parseContentLength(res.headers);
    if (len !== null && len > MAX_VISION_IMAGE_BYTES) return null;

    const body = await readResponseBodyWithLimit(res, MAX_VISION_IMAGE_BYTES, controller);
    if (!body || !body.length) return null;

    return `base64://${body.toString("base64")}`;
  } catch (error) {
    console.warn(`[QQ] Failed to download external image as base64: ${String(error)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
