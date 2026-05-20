// ─── Environment & Types ─────────────────────────────────────────────────────

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  GEMINI_API_KEY: string;
  GEMINI_API_VIP_GROUP_KEY: string;
  GEMINI_API_TELEGRAM_JOI: string;
  GEMINI_API_TELEGRAM_JOI_FLASH_LITE: string;
}

// ─── Telegram Types ──────────────────────────────────────────────────────────

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
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
  quote?: { text: string; position?: number; is_manual?: boolean };
  forward_from_chat?: { title?: string; type?: string };
  forward_sender_name?: string;
  forward_from?: TelegramUser;
  message_thread_id?: number;
  is_topic_message?: boolean;
  entities?: Array<{ type: string; offset: number; length: number; user?: TelegramUser }>;
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

// ─── Context Buffer (D1 row representation) ─────────────────────────────────

export interface BufferMessage {
  role: "user" | "assistant";
  content: string;
  userName?: string;
  userId?: number;
  ts: number;
  messageId?: number;
  isBot?: boolean;
  isForwarded?: boolean;
  forwardSource?: string;
  replyToMessageId?: number;
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
  sentimentAvg: number;       // rolling average of recent sentiment (-1.0 to +1.0)
  lastInteraction: number;    // timestamp for decay calculation
  firstSeen: number;
  isFirstContact: boolean;    // true if we haven't asked their name yet (private)
  activityHours?: number[];   // last 20 message hours (UTC) for time pattern detection
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
export const VIP_PROACTIVE_TOPIC_ID = 16208;

// Forum topic ID → human-readable name (for system prompt injection)
export const VIP_TOPIC_NAMES: Record<number, string> = {
  1: "Общий",
  2452: "Тех/Игры",
  2475: "Разное",
  3164: "Активности в Алматы",
  4764: "Экономика/Финансы",
  2457: "Новости",
  2478: "Бачелор зона (девушки/рилсы)",
  3874: "Возможности",
  2481: "Музыка",
  2455: "Мемы",
  16208: "Канал Джой и Амони",
  2458: "Здоровье/Спорт",
  2712: "Новые стикеры",
  2474: "Путешествия",
  8873: "Промпты",
};

export const DAILY_RATE_LIMIT = 100;

export const RUSTEM_USER_ID = 271113269;

export const AMONYA_USERNAME = "amonya_chuy_valley_bot";
export const AMONYA_BOT_ID = 8464398774;

// ─── VIP Group Pre-loaded Members ────────────────────────────────────────────

export interface VipMember {
  id: number;
  defaultName: string;
  aliases: string[];
  gender: "male" | "female";
}

export const VIP_MEMBERS: VipMember[] = [
  { id: 1038120471, defaultName: "Кама", aliases: ["Камский"], gender: "male" },
  { id: 370789625, defaultName: "Аса", aliases: ["Асеке"], gender: "male" },
  { id: RUSTEM_USER_ID, defaultName: "Рус", aliases: ["Руся"], gender: "male" },
  { id: 163421204, defaultName: "Босс", aliases: ["Шеф", "Шефуля"], gender: "male" },
  { id: 521857800, defaultName: "Макс", aliases: [], gender: "male" },
];
