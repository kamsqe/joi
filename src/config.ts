// ─── Environment & Types ─────────────────────────────────────────────────────

export interface Env {
  KV: KVNamespace;
  AI: Ai;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  GEMINI_API_KEY: string;
  TAVILY_API_KEY: string;
  WEATHER_THREAD_ID?: string;
}

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
  type: string;
  title?: string;
}

export interface BufferMessage {
  role: "user" | "assistant";
  content: string;
  userName?: string;
  userId?: number;
  ts: number;
}

export interface RetryTask {
  chatId: number;
  messageId: number;
  userId: number;
  text: string;
  intent: string;
  threadId?: number;
  attempt: number;
}

export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const BOT_USERNAME = "amonya_chuy_valley_bot";

export const BOT_NAME_VARIANTS = [
  "амоня", "амоню", "амоне", "амоней", "амони",
  "amonya", `@${BOT_USERNAME}`,
];

export const SENTINEL_429 = "__RATE_LIMITED_429__";
export const SENTINEL_503 = "__SERVER_OVERLOADED_503__";
