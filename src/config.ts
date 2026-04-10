// ─── Environment & Types ─────────────────────────────────────────────────────

export interface Env {
  KV: KVNamespace;
  AI: Ai;
  TELEGRAM_BOT_TOKEN: string;
  GEMINI_API_KEY: string;
}

// ─── Telegram Types ──────────────────────────────────────────────────────────

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  sticker?: { file_id: string; emoji?: string; set_name?: string };
  photo?: Array<{ file_id: string }>;
  video?: { file_id: string };
  audio?: { file_id: string; title?: string; performer?: string };
  voice?: { file_id: string; duration: number };
  video_note?: { file_id: string };
  document?: { file_id: string; file_name?: string };
  animation?: { file_id: string };
  reply_to_message?: TelegramMessage;
  forward_from_chat?: { title?: string; type?: string };
  forward_sender_name?: string;
  forward_from?: TelegramUser;
  message_thread_id?: number;
  is_topic_message?: boolean;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

// ─── LLM Types ───────────────────────────────────────────────────────────────

export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// ─── Context Buffer ──────────────────────────────────────────────────────────

export interface BufferMessage {
  role: "user" | "assistant";
  content: string;
  userName?: string;
  userId?: number;
  ts: number;
}

// ─── Mood System ─────────────────────────────────────────────────────────────

export type MoodState =
  | "happy"
  | "playful"
  | "chill"
  | "flirty"
  | "annoyed"
  | "offended"
  | "mean"
  | "serious"
  | "unhinged"
  | "manic";

export interface MoodData {
  mood: MoodState;
  intensity: number;         // 0-100
  volatility: number;        // 0.0-1.0, how likely mood swings are
  lastChange: number;        // timestamp
  offendedBy?: number;       // userId who offended her
  offenseReason?: string;
  coolPeriodUntil?: number;  // timestamp when cool period ends
}

// ─── Relationship System ─────────────────────────────────────────────────────

export interface UserProfile {
  userId: number;
  chatId: number;
  nickname?: string;          // user-chosen nickname (overrides defaults)
  nicknameOverride: boolean;  // true if user personally asked for a name change
  score: number;              // -100 to +100
  lastInteraction: number;    // timestamp for decay calculation
  firstSeen: number;
  isFirstContact: boolean;    // true if we haven't asked their name yet (private)
}

// ─── Reminders ───────────────────────────────────────────────────────────────

export interface Reminder {
  id: string;
  chatId: number;
  userId: number;
  description: string;
  remindAt: number;           // timestamp
  recurrence?: "once" | "daily" | "weekly" | "monthly" | "yearly";
  createdAt: number;
  lastReminded?: number;
}

// ─── Proactive Messaging ─────────────────────────────────────────────────────

export interface ProactiveState {
  lastProactiveTs: number;
  pendingFollowUp?: {
    topicSnapshot: string;
    scheduledAt: number;
    bufferLengthAtSchedule: number;  // to detect if convo moved on
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const BOT_USERNAME = "joicanfixthat_bot";

export const BOT_NAME_VARIANTS = [
  "джой", "жой", "джойка", "joi",
  `@${BOT_USERNAME}`,
];

export const VIP_GROUP_ID = -1003199433987;

export const DAILY_RATE_LIMIT = 50;

export const AMONYA_USERNAME = "amonya_chuy_valley_bot";

// ─── VIP Group Pre-loaded Members ────────────────────────────────────────────

export interface VipMember {
  id: number;
  defaultName: string;
  aliases: string[];
}

export const VIP_MEMBERS: VipMember[] = [
  { id: 1038120471, defaultName: "Кама", aliases: ["Камский"] },
  { id: 370789625, defaultName: "Аса", aliases: ["Асеке"] },
  { id: 271113269, defaultName: "Рус", aliases: ["Руся"] },
  { id: 163421204, defaultName: "Босс", aliases: ["Шеф", "Шефуля"] },
  { id: 521857800, defaultName: "Макс", aliases: [] },
];
