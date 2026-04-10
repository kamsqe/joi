// ─── Telegram API Helpers ────────────────────────────────────────────────────

import type { Env, TelegramUpdate, TelegramMessage } from "./config";

const TELEGRAM_API = "https://api.telegram.org/bot";

// ─── Send Message ────────────────────────────────────────────────────────────

export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  replyToMessageId?: number,
  messageThreadId?: number,
): Promise<TelegramMessage | null> {
  const url = `${TELEGRAM_API}${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  // Telegram limit: 4096 chars
  const truncated = text.length > 4000 ? text.slice(0, 4000) + "..." : text;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: truncated,
    parse_mode: "HTML",
  };

  if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
  if (messageThreadId) body.message_thread_id = messageThreadId;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // If HTML parse fails, retry without parse_mode
      const errBody = await res.text();
      if (errBody.includes("can't parse entities")) {
        body.parse_mode = undefined;
        body.text = text.length > 4000 ? text.slice(0, 4000) + "..." : text;
        const retry = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (retry.ok) {
          const data = await retry.json() as { result: TelegramMessage };
          return data.result;
        }
      }
      console.error("sendMessage failed:", errBody);
      return null;
    }

    const data = await res.json() as { result: TelegramMessage };
    return data.result;
  } catch (err) {
    console.error("sendMessage error:", err);
    return null;
  }
}

// ─── Set Reaction ────────────────────────────────────────────────────────────

const REACTION_EMOJIS = [
  "👍", "❤", "🔥", "😂", "🤔", "👀", "💯", "🤣",
  "😎", "🫡", "👏", "🤝", "😢", "🎉", "🤯",
];

export async function setMessageReaction(
  env: Env,
  chatId: number,
  messageId: number,
): Promise<void> {
  const emoji = REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)];
  const url = `${TELEGRAM_API}${env.TELEGRAM_BOT_TOKEN}/setMessageReaction`;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
      }),
    });
  } catch {
    // Reactions are best-effort, ignore errors
  }
}

// ─── Parse Update ────────────────────────────────────────────────────────────

export function parseUpdate(body: unknown): TelegramUpdate | null {
  if (!body || typeof body !== "object") return null;
  const update = body as TelegramUpdate;
  if (!update.update_id) return null;
  return update;
}

// ─── Format for Telegram ─────────────────────────────────────────────────────
// Convert LLM markdown to Telegram HTML

export function formatForTelegram(text: string): string {
  let result = text;

  // Escape HTML entities first
  result = result.replace(/&/g, "&amp;");
  result = result.replace(/</g, "&lt;");
  result = result.replace(/>/g, "&gt;");

  // Code blocks (triple backtick) — preserve as-is in <pre>
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    const inner = match.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
    return `<pre>${inner}</pre>`;
  });

  // Inline code
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold **text** (must come before italic)
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic *text* (single asterisk, not double)
  result = result.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, "<i>$1</i>");

  // Headings # → bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  return result;
}

// ─── Sanitize LLM Response ──────────────────────────────────────────────────

export function sanitizeResponse(text: string): string {
  let result = text;

  // Remove CJK characters (Chinese/Japanese/Korean ideographs)
  result = result.replace(/[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uFF00-\uFFEF]/g, "");

  // Remove German special characters
  result = result.replace(/[äöüßÄÖÜ]/g, "");

  // Collapse excessive whitespace (3+ newlines → double newline)
  result = result.replace(/\n{3,}/g, "\n\n");

  // Collapse excessive spaces
  result = result.replace(/ {3,}/g, "  ");

  return result.trim();
}
