import { z } from "zod";

export const QQConfigSchema = z.object({
  wsUrl: z.string().url().describe("The WebSocket URL of the OneBot v11 server (e.g. ws://localhost:3001)"),
  accessToken: z.string().optional().describe("The access token for the OneBot server"),
  admins: z.array(z.number()).optional().describe("List of admin QQ numbers"),
  requireMention: z.boolean().optional().default(true).describe("Require @mention or reply to bot in group chats"),
  systemPrompt: z.string().optional().describe("Custom system prompt to inject into the context"),
  enableDeduplication: z.boolean().optional().default(true).describe("Enable message deduplication to prevent double replies"),
  enableErrorNotify: z.boolean().optional().default(true).describe("Notify admins or users when errors occur"),
  autoApproveRequests: z.boolean().optional().default(false).describe("Automatically approve friend/group add requests"),
  maxMessageLength: z.number().optional().default(4000).describe("Maximum length of a single message before splitting"),
  formatMarkdown: z.boolean().optional().default(false).describe("Format markdown to plain text for better readability"),
  antiRiskMode: z.boolean().optional().default(false).describe("Enable anti-risk processing (e.g. modify URLs)"),
  allowedGroups: z.array(z.number()).optional().describe("Whitelist of group IDs allowed to interact with"),
  blockedUsers: z.array(z.number()).optional().describe("Blacklist of user IDs to ignore"),
  historyLimit: z.number().optional().default(0).describe("Number of history messages to include in context"),
  keywordTriggers: z.array(z.string()).optional().describe("List of keywords that trigger the bot (without @)"),
  enableTTS: z.boolean().optional().default(false).describe("Experimental: Convert AI text replies to voice (TTS)"),
  enableGuilds: z.boolean().optional().default(true).describe("Enable QQ Guild (Channel) support"),
  rateLimitMs: z.number().optional().default(1000).describe("Delay in ms between sent messages to avoid risk"),
});

export type QQConfig = z.infer<typeof QQConfigSchema>;
