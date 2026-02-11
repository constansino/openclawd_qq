import { z } from "zod";

export const QQConfigSchema = z.object({
  wsUrl: z.string().url().describe("The WebSocket URL of the OneBot v11 server (e.g. ws://localhost:3001)"),
  accessToken: z.string().optional().describe("The access token for the OneBot server"),
  admins: z.string().optional().describe("Admin QQ numbers (comma/space/newline separated, e.g. 12345,67890)"),
  requireMention: z.boolean().optional().default(true).describe("Require @mention or reply to bot in group chats"),
  systemPrompt: z.string().optional().describe("Custom system prompt to inject into the context"),
  enableDeduplication: z.boolean().optional().default(true).describe("Enable message deduplication to prevent double replies"),
  enableErrorNotify: z.boolean().optional().default(true).describe("Notify admins or users when errors occur"),
  adminOnlyChat: z.boolean().optional().default(false).describe("Only allow admin users to trigger normal chat replies"),
  notifyNonAdminBlocked: z.boolean().optional().default(false).describe("Notify non-admin users when adminOnlyChat blocks a request"),
  nonAdminBlockedMessage: z.string().optional().default("当前仅管理员可触发机器人。\n如需使用请联系管理员。"),
  autoApproveRequests: z.boolean().optional().default(false).describe("Automatically approve friend/group add requests"),
  maxMessageLength: z.number().optional().default(4000).describe("Maximum length of a single message before splitting"),
  formatMarkdown: z.boolean().optional().default(false).describe("Format markdown to plain text for better readability"),
  antiRiskMode: z.boolean().optional().default(false).describe("Enable anti-risk processing (e.g. modify URLs)"),
  allowedGroups: z.string().optional().describe("Whitelist group IDs (comma/space/newline separated)"),
  blockedUsers: z.string().optional().describe("Blacklist user IDs (comma/space/newline separated)"),
  historyLimit: z.number().optional().default(0).describe("Number of history messages to include in context"),
  keywordTriggers: z.array(z.string()).optional().describe("List of keywords that trigger the bot (without @)"),
  enableTTS: z.boolean().optional().default(false).describe("Experimental: Convert AI text replies to voice (TTS)"),
  enableGuilds: z.boolean().optional().default(true).describe("Enable QQ Guild (Channel) support"),
  rateLimitMs: z.number().optional().default(1000).describe("Delay in ms between sent messages to avoid risk"),
});

export type QQConfig = z.infer<typeof QQConfigSchema>;
