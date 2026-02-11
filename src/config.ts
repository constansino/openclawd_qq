import { z } from "zod";

const IdListStringSchema = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  return String(value);
}, z.string().optional());

const NumberInputSchema = (defaultValue: number) => z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}, z.number().optional().default(defaultValue));

const KeywordTriggersSchema = z.preprocess((value) => {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean).join(", ");
  return String(value);
}, z.string().optional().default(""));

export const QQConfigSchema = z.object({
  wsUrl: z.string().url().describe("OneBot WebSocket 地址。示例：ws://127.0.0.1:3001"),
  accessToken: z.string().optional().describe("OneBot 访问令牌（Token）。需与 NapCat/OneBot 配置一致。"),
  admins: IdListStringSchema.describe("管理员QQ号（字符串）。Web表单示例：1838552185,123456789；Raw JSON 示例：\"1838552185,123456789\"。"),
  requireMention: z.boolean().optional().default(true).describe("群聊是否需要 @ 机器人才触发。建议开启以节省 Token。"),
  systemPrompt: z.string().optional().describe("系统提示词。示例：你是一个高效、礼貌的助理。"),
  enableDeduplication: z.boolean().optional().default(true).describe("启用消息去重，避免重复回复。"),
  enableErrorNotify: z.boolean().optional().default(true).describe("调用失败时是否给用户提示。"),
  adminOnlyChat: z.boolean().optional().default(false).describe("仅管理员可触发聊天（防盗刷推荐开启）。"),
  notifyNonAdminBlocked: z.boolean().optional().default(false).describe("启用管理员模式后，是否提示非管理员“无权限”。"),
  nonAdminBlockedMessage: z.string().optional().default("当前仅管理员可触发机器人。\n如需使用请联系管理员。"),
  blockedNotifyCooldownMs: NumberInputSchema(10000).describe("非管理员拦截提示防抖时长（毫秒）。10秒可填 10000。"),
  autoApproveRequests: z.boolean().optional().default(false).describe("自动通过好友申请/群邀请。"),
  maxMessageLength: NumberInputSchema(4000).describe("单条消息最大长度，超出后自动分段发送。"),
  formatMarkdown: z.boolean().optional().default(false).describe("把 Markdown 转纯文本，QQ 显示更清晰。"),
  antiRiskMode: z.boolean().optional().default(false).describe("风控规避模式（例如处理 URL 发送样式）。"),
  allowedGroups: IdListStringSchema.describe("允许响应的群号白名单（字符串）。Web表单：883766069 123456789；Raw JSON：\"883766069 123456789\"。"),
  blockedUsers: IdListStringSchema.describe("用户黑名单QQ号（字符串）。Web表单：342571216 或 342571216,10002；Raw JSON：\"342571216\"。"),
  historyLimit: NumberInputSchema(0).describe("群历史注入条数。默认0（推荐，依赖会话系统）；需强保留原文时可设 3~5。"),
  keywordTriggers: KeywordTriggersSchema.describe("关键词触发（字符串）。Web表单：小助手, 帮我；Raw JSON：\"小助手, 帮我\"。"),
  enableTTS: z.boolean().optional().default(false).describe("是否启用语音回复（依赖 OneBot 服务端支持）。"),
  enableGuilds: z.boolean().optional().default(true).describe("是否启用 QQ 频道（Guild）支持。"),
  rateLimitMs: NumberInputSchema(1000).describe("多段消息发送间隔（毫秒）。建议 1000。"),
}).passthrough();

export type QQConfig = z.infer<typeof QQConfigSchema>;
