// ─── Emotional Memory — Significant Moment Bookmarks (D1-backed) ─────────────
// Stores up to MAX_EVENTS significant emotional moments per user per chat.
// These are injected into the system prompt to give Joi deep, specific memories
// like "помнишь как мы поругались из-за Скриптонита" or "ты тогда рассказал про переезд".

import type { Env, LLMMessage } from "./config";
import { callLLMLight } from "./ai";

const MAX_EVENTS = 10;
const SALIENCE_POOL_SIZE = 30;                 // how many recent events to consider
const SALIENCE_DECAY_DAYS = 14;                // half-life for recency weighting
const MS_PER_DAY = 86_400_000;

export type EventType = "fight" | "apology" | "personal" | "joke" | "milestone" | "warmth" | "crisis_moment";

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
  // D3: Fetch a larger pool, then rank by salience (|valence| × recency weight).
  // This prevents strong old memories from being crowded out by trivial new ones.
  const rows = await env.DB.prepare(
    `SELECT * FROM emotional_events WHERE chat_id = ? AND user_id = ? ORDER BY ts DESC LIMIT ?`,
  )
    .bind(chatId, userId, SALIENCE_POOL_SIZE)
    .all<{
      id: number; chat_id: number; user_id: number;
      event_type: string; summary: string; valence: number; ts: number;
    }>();

  const pool = (rows.results || []).map((r) => ({
    id: r.id,
    chatId: r.chat_id,
    userId: r.user_id,
    eventType: r.event_type as EventType,
    summary: r.summary,
    valence: r.valence,
    ts: r.ts,
  }));

  if (pool.length <= MAX_EVENTS) return pool;

  // Score: magnitude × exponential decay over days.
  // salience = |valence| * exp(-ageDays / SALIENCE_DECAY_DAYS)
  const now = Date.now();
  const scored = pool.map((e) => {
    const ageDays = (now - e.ts) / MS_PER_DAY;
    const salience = Math.abs(e.valence) * Math.exp(-ageDays / SALIENCE_DECAY_DAYS);
    return { event: e, salience };
  });

  // Keep top MAX_EVENTS by salience, then re-sort chronologically (newest first) for display
  scored.sort((a, b) => b.salience - a.salience);
  const top = scored.slice(0, MAX_EVENTS).map((s) => s.event);
  top.sort((a, b) => b.ts - a.ts);
  return top;
}

// ─── Detect & Save Significant Moments ───────────────────────────────────────
// Called after sentiment classification on messages with strong sentiment deltas.
// Uses Flash-Lite to extract a 1-line bookmark of what happened.

// High-signal life-event keywords. Match here bypasses the sentiment-delta gate
// so we still bookmark "развожусь" / "повысили" / "переехал" when classifier
// returned neutral (the user is reporting a fact, not directing emotion at Joi).
const LIFE_EVENT_PATTERNS: { re: RegExp; valenceHint: number }[] = [
  { re: /\b(?:женил(?:ся|ась)|вышла?\s+замуж|свадьб[а-я]+)\b/i, valenceHint: 0.6 },
  { re: /\b(?:развел(?:ся|ась)|развод(?:юсь|имся|илсь|илась|или)?|расста(?:ли(?:сь)?|юсь|емся|лся|лась))\b/i, valenceHint: -0.6 },
  { re: /\b(?:бросил[аи]?\s+меня|кинул[аи]?\s+меня)\b/i, valenceHint: -0.7 },
  { re: /\b(?:умер(?:л[аи]?)?|скончал(?:ся|ась|ись)|похорон[а-я]+|не\s+стало)\b/i, valenceHint: -0.85 },
  { re: /\b(?:повысили|повышение|новая\s+работа|устроил(?:ся|ась))\b/i, valenceHint: 0.7 },
  { re: /\b(?:уволил[аи]?|выгнал[аи]?\s+с\s+работы|потерял[а]?\s+работу)\b/i, valenceHint: -0.7 },
  { re: /\b(?:переехал[аи]?|переезжаю|переезд)\b/i, valenceHint: 0.3 },
  { re: /\b(?:поступил[аи]?|сдал[аи]?\s+экзамен|защитил[аи]?\s+диплом)\b/i, valenceHint: 0.6 },
  { re: /\b(?:роди(?:л|лся|лась|ли)|беременна|жду\s+ребёнка)\b/i, valenceHint: 0.7 },
  { re: /\b(?:день\s+рождения|др\s+у\s+меня|сегодня\s+мой\s+др)\b/i, valenceHint: 0.5 },
];

function detectLifeEvent(text: string): { matched: boolean; valenceHint: number } {
  for (const { re, valenceHint } of LIFE_EVENT_PATTERNS) {
    if (re.test(text)) return { matched: true, valenceHint };
  }
  return { matched: false, valenceHint: 0 };
}

export async function maybeBookmarkMoment(
  env: Env,
  chatId: number,
  userId: number,
  text: string,
  sentiment: "positive" | "negative" | "neutral",
  delta: number,
): Promise<void> {
  // Two gates: strong sentiment delta OR life-event keyword match.
  // The keyword path catches neutral-tone fact reports ("развожусь")
  // that the sentiment classifier rates as 0.
  const absDelta = Math.abs(delta);
  const lifeEvent = detectLifeEvent(text);
  if (absDelta < 3 && !lifeEvent.matched) return;

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

    let valence = sentiment === "positive" ? Math.min(delta / 15, 1.0)
      : sentiment === "negative" ? Math.max(delta / 15, -1.0)
      : 0;
    // If sentiment is neutral but a life-event keyword fired, use the keyword's
    // valence hint so salience ranking gives this memory weight.
    if (valence === 0 && lifeEvent.matched) valence = lifeEvent.valenceHint;

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

    // D3: Keep a larger pool in DB (SALIENCE_POOL_SIZE) so salience ranking at
    // read time has something to choose from. Trim by recency — at read time
    // we rank by |valence| × recency to pick the top MAX_EVENTS for display.
    await env.DB.prepare(
      `DELETE FROM emotional_events WHERE chat_id = ? AND user_id = ? AND id NOT IN (
         SELECT id FROM emotional_events WHERE chat_id = ? AND user_id = ? ORDER BY ts DESC LIMIT ?
       )`,
    )
      .bind(chatId, userId, chatId, userId, SALIENCE_POOL_SIZE)
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
    case "crisis_moment": return "🔴";
  }
}
