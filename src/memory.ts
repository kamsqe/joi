// ─── Emotional Memory — Significant Moment Bookmarks (D1-backed) ─────────────
// Stores up to MAX_EVENTS significant emotional moments per user per chat.
// These are injected into the system prompt to give Joi deep, specific memories
// like "помнишь как мы поругались из-за Скриптонита" or "ты тогда рассказал про переезд".

import type { Env, LLMMessage } from "./config";
import { callLLMLight } from "./ai";

const MAX_EVENTS = 10;

export type EventType = "fight" | "apology" | "personal" | "joke" | "milestone" | "warmth";

export interface EmotionalEvent {
  id: number;
  chatId: number;
  userId: number;
  eventType: EventType;
  summary: string;
  valence: number; // -1.0 to 1.0
  ts: number;
}

// ─── Load Events ─────────────────────────────────────────────────────────────

export async function getEmotionalEvents(
  env: Env,
  chatId: number,
  userId: number,
): Promise<EmotionalEvent[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM emotional_events WHERE chat_id = ? AND user_id = ? ORDER BY ts DESC LIMIT ?`,
  )
    .bind(chatId, userId, MAX_EVENTS)
    .all<{
      id: number; chat_id: number; user_id: number;
      event_type: string; summary: string; valence: number; ts: number;
    }>();

  return (rows.results || []).map((r) => ({
    id: r.id,
    chatId: r.chat_id,
    userId: r.user_id,
    eventType: r.event_type as EventType,
    summary: r.summary,
    valence: r.valence,
    ts: r.ts,
  }));
}

// ─── Detect & Save Significant Moments ───────────────────────────────────────
// Called after sentiment classification on messages with strong sentiment deltas.
// Uses Flash-Lite to extract a 1-line bookmark of what happened.

export async function maybeBookmarkMoment(
  env: Env,
  chatId: number,
  userId: number,
  text: string,
  sentiment: "positive" | "negative" | "neutral",
  delta: number,
): Promise<void> {
  // Only bookmark strong emotional moments
  const absDelta = Math.abs(delta);
  if (absDelta < 5) return; // threshold: only significant moments

  const systemPrompt = `Определи тип эмоционального момента и опиши его ОДНОЙ короткой фразой (до 15 слов).

Типы:
- fight: конфликт, ссора, грубость
- apology: извинение, примирение
- personal: личное откровение, поделился чем-то важным
- joke: шутка которая зашла, смешной момент
- milestone: важное событие (день рождения, достижение, новость)
- warmth: тёплый момент, комплимент, благодарность

Верни ТОЛЬКО JSON: {"type":"тип","summary":"краткое описание"}
Если момент не значимый — верни {"type":"none","summary":""}

Примеры:
"ты лучшая, серьёзно, спасибо за всё" → {"type":"warmth","summary":"искренне поблагодарил и похвалил"}
"да пошла ты нахуй тупая железка" → {"type":"fight","summary":"грубо оскорбил, назвал тупой железкой"}
"я вчера узнал что меня повысили на работе" → {"type":"milestone","summary":"повышение на работе"}`;

  const messages: LLMMessage[] = [{ role: "user", content: text }];
  const result = await callLLMLight(env, messages, systemPrompt, 80, 0.1);

  if (!result) return;

  try {
    let raw = result.trim();
    if (raw.startsWith("\`\`\`json")) raw = raw.replace(/^\`\`\`json\n?/, "").replace(/\n?\`\`\`$/, "");
    else if (raw.startsWith("\`\`\`")) raw = raw.replace(/^\`\`\`\n?/, "").replace(/\n?\`\`\`$/, "");
    
    const parsed = JSON.parse(raw.trim());
    if (!parsed.type || parsed.type === "none" || !parsed.summary) return;

    const eventType = parsed.type as EventType;
    const validTypes: EventType[] = ["fight", "apology", "personal", "joke", "milestone", "warmth"];
    if (!validTypes.includes(eventType)) return;

    const valence = sentiment === "positive" ? Math.min(delta / 15, 1.0)
      : sentiment === "negative" ? Math.max(delta / 15, -1.0)
      : 0;

    // Dedup: don't save if a very similar event happened in the last hour
    const recentRows = await env.DB.prepare(
      `SELECT summary FROM emotional_events
       WHERE chat_id = ? AND user_id = ? AND ts > ? AND event_type = ?
       LIMIT 1`,
    )
      .bind(chatId, userId, Date.now() - 3600000, eventType)
      .first<{ summary: string }>();

    if (recentRows) return; // similar event type in last hour, skip

    // Insert new event
    await env.DB.prepare(
      `INSERT INTO emotional_events (chat_id, user_id, event_type, summary, valence, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(chatId, userId, eventType, parsed.summary, valence, Date.now())
      .run();

    // Trim to MAX_EVENTS (keep newest)
    await env.DB.prepare(
      `DELETE FROM emotional_events WHERE chat_id = ? AND user_id = ? AND id NOT IN (
         SELECT id FROM emotional_events WHERE chat_id = ? AND user_id = ? ORDER BY ts DESC LIMIT ?
       )`,
    )
      .bind(chatId, userId, chatId, userId, MAX_EVENTS)
      .run();
  } catch (err: any) { 
    console.error(`[Bookmark Parse Failed] raw: "${result}", error: ${err.message}`);
  }
}

// ─── Build Memory Block for System Prompt ────────────────────────────────────
// Formats emotional bookmarks into a natural-sounding memory block.

export function buildMemoryBlock(events: EmotionalEvent[], userName: string): string {
  if (events.length === 0) return "";

  const now = Date.now();

  const lines = events.map((e) => {
    const ago = formatTimeAgo(now - e.ts);
    const emoji = eventEmoji(e.eventType);
    return `${emoji} ${ago}: ${e.summary}`;
  });

  return `ТВОИ ВОСПОМИНАНИЯ О ${userName} (используй уместно, не вываливай все сразу):
${lines.join("\n")}
Ссылайся на эти моменты естественно: "помнишь как ты...", "кста ты тогда говорил...", "после того раза когда...". Но НЕ в каждом сообщении — только когда контекст позволяет.`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimeAgo(ms: number): string {
  const hours = ms / 3600000;
  if (hours < 1) return "только что";
  if (hours < 24) return "сегодня";
  const days = Math.floor(hours / 24);
  if (days === 1) return "вчера";
  if (days < 7) return `${days} дн назад`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks} нед назад`;
  return "давно";
}

function eventEmoji(type: EventType): string {
  switch (type) {
    case "fight": return "⚡";
    case "apology": return "🤝";
    case "personal": return "💭";
    case "joke": return "😂";
    case "milestone": return "🎯";
    case "warmth": return "💛";
  }
}
