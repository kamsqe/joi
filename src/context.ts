// ─── KV-Based Rolling Message Buffer ─────────────────────────────────────────

import type { Env, BufferMessage, LLMMessage } from "./config";
import { getPrimaryName } from "./users";

const MAX_BUFFER_SIZE = 50;
const BUFFER_TTL = 60 * 60 * 24 * 7; // 7 days

function bufferKey(chatId: number): string {
  return `chat_buffer:${chatId}`;
}

// ─── Read Buffer ─────────────────────────────────────────────────────────────

export async function getBuffer(env: Env, chatId: number): Promise<BufferMessage[]> {
  try {
    const raw = await env.KV.get(bufferKey(chatId));
    if (!raw) return [];
    return JSON.parse(raw) as BufferMessage[];
  } catch {
    return [];
  }
}

// ─── Append Message to Buffer ────────────────────────────────────────────────

export async function appendToBuffer(
  env: Env,
  chatId: number,
  message: BufferMessage,
): Promise<void> {
  const buffer = await getBuffer(env, chatId);
  buffer.push(message);

  // Trim to last MAX_BUFFER_SIZE messages
  const trimmed = buffer.slice(-MAX_BUFFER_SIZE);

  await env.KV.put(bufferKey(chatId), JSON.stringify(trimmed), {
    expirationTtl: BUFFER_TTL,
  });
}

// ─── Build LLM History from Buffer ──────────────────────────────────────────

const MAX_HISTORY_MESSAGES = 20;
const MAX_CONTENT_LENGTH = 600;

export function buildLLMHistory(buffer: BufferMessage[]): LLMMessage[] {
  const messages: LLMMessage[] = [];

  // Only send last N messages to avoid context bloat on long conversations
  const recent = buffer.slice(-MAX_HISTORY_MESSAGES);

  for (const msg of recent) {
    const raw = msg.content.length > MAX_CONTENT_LENGTH
      ? msg.content.slice(0, MAX_CONTENT_LENGTH) + "…"
      : msg.content;

    const content =
      msg.role === "user" && msg.userName
        ? `[${msg.userName}]: ${raw}`
        : raw;

    messages.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content,
    });
  }

  return messages;
}

// ─── Save User Message (convenience) ────────────────────────────────────────

export async function saveUserMessage(
  env: Env,
  chatId: number,
  userId: number,
  text: string,
): Promise<void> {
  await appendToBuffer(env, chatId, {
    role: "user",
    content: text,
    userName: getPrimaryName(userId),
    userId,
    ts: Date.now(),
  });
}

// ─── Save Bot Message (convenience) ─────────────────────────────────────────

export async function saveBotMessage(
  env: Env,
  chatId: number,
  text: string,
): Promise<void> {
  await appendToBuffer(env, chatId, {
    role: "assistant",
    content: text,
    ts: Date.now(),
  });
}
