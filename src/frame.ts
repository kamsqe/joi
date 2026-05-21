// ─── Conversational Frame Classifier ────────────────────────────────────────
// Joi's brainstorm Symptom 5: she punchlines on a values-debate because she
// can't tell debate from banter. This module asks one cheap Flash-Lite call
// "what *kind* of conversation is this right now?" and feeds the answer
// into the system prompt as a directive about what contribution would land.
//
// Cached per (chat, thread) for 15 minutes — rooms don't change tone faster
// than that. Cache lives in D1 rate_limits since we already have that table.
//
// User confirmed "yes" to the cost (one Flash-Lite call per active message,
// ~5 output tokens) and "acceptable" to [SKIP] being used when the frame
// says she shouldn't react.

import type { Env, LLMMessage } from "./config";
import { callLLMLight } from "./ai";

export type ConversationFrame =
  | "banter"      // light back-and-forth, jokes; quick replies land
  | "debate"      // values/opinion exchange; punchlines crash
  | "news_drop"   // someone shared an article/forwarded post; no one's commented
  | "vent"        // someone offloading frustration/sadness; empathy not advice
  | "planning"    // logistics, coordinating meetup/decision; facts only
  | "tension"     // disagreement turning sour; don't fuel
  | "dead";       // silence/scrolling; nothing to react to

const CACHE_TTL_MS = 15 * 60 * 1000;

interface FrameCacheRow {
  data: string | null;
  expires_at: number;
}

function cacheKey(chatId: number, threadId?: number): string {
  return `frame:${chatId}:${threadId ?? "main"}`;
}

// ─── Classify ───────────────────────────────────────────────────────────────

export async function classifyFrame(
  env: Env,
  chatId: number,
  threadId: number | undefined,
  recentMessages: { userName: string | null; content: string; isBot: boolean }[],
): Promise<ConversationFrame> {
  if (recentMessages.length < 2) return "dead";

  // Cache check
  const key = cacheKey(chatId, threadId);
  const now = Date.now();
  const cached = await env.DB.prepare(
    `SELECT data, expires_at FROM rate_limits WHERE key = ? AND expires_at > ?`,
  ).bind(key, now).first<FrameCacheRow>();
  if (cached?.data) {
    return cached.data as ConversationFrame;
  }

  // Build a small context block — last 8 messages, sender names included
  const lines = recentMessages.slice(-8).map((m) => {
    const tag = m.isBot ? `[БОТ ${m.userName || "?"}]` : `[${m.userName || "?"}]`;
    return `${tag}: ${m.content.length > 160 ? m.content.slice(0, 160) + "…" : m.content}`;
  }).join("\n");

  const systemPrompt = `Ты классифицируешь тон разговора в чате. Прочти последние сообщения и ответь ОДНИМ СЛОВОМ:

- "banter" — лёгкая перепалка, шутки, мемы, ничего серьёзного
- "debate" — обмен мнениями/ценностями, реальная дискуссия, не шуточная
- "news_drop" — кто-то скинул статью/пересланный пост, обсуждения ещё не было
- "vent" — кто-то выгружает фрустрацию/грусть, ему нужна эмпатия а не советы
- "planning" — логистика, координация встречи или решения, нужны факты
- "tension" — разногласие переходит в неприятный тон, есть риск ссоры
- "dead" — тишина или скролл, реагировать не на что

Верни ТОЛЬКО ОДНО СЛОВО из списка. Никаких других слов или знаков.`;

  const messages: LLMMessage[] = [
    { role: "user", content: lines },
  ];

  const result = await callLLMLight(env, messages, systemPrompt, 5, 0.0);
  let frame: ConversationFrame = "banter"; // default
  if (result) {
    const clean = result.trim().toLowerCase().replace(/[^a-z_]/g, "");
    const allowed: ConversationFrame[] = ["banter", "debate", "news_drop", "vent", "planning", "tension", "dead"];
    if (allowed.includes(clean as ConversationFrame)) {
      frame = clean as ConversationFrame;
    }
  }

  // Cache
  const expiresAt = now + CACHE_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, data, expires_at) VALUES (?, 0, ?, ?)
     ON CONFLICT(key) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
  ).bind(key, frame, expiresAt).run();

  console.log(JSON.stringify({ event: "frame_classified", chatId, threadId: threadId ?? null, frame }));
  return frame;
}

// ─── Prompt block per frame ─────────────────────────────────────────────────
// One-line directive that tells the LLM what kind of contribution would
// actually land right now. Combined with [SKIP] permission when appropriate.

export function frameBlock(frame: ConversationFrame): string {
  switch (frame) {
    case "banter":
      return `ФРЕЙМ ЧАТА: банта. Лёгкая перепалка, можно подкалывать, ride the energy. Короткие меткие ответы лучше длинных.`;
    case "debate":
      return `ФРЕЙМ ЧАТА: дискуссия (ценности/мнения). НЕ влезай с шуткой-панчлайном — это будет дико неуместно. Либо честно поделись своим мнением (коротко, твоё), либо лучше промолчи: [SKIP].`;
    case "news_drop":
      return `ФРЕЙМ ЧАТА: кто-то кинул новость, обсуждения ещё нет. Реагируй как человек который только что увидел статью — личная реакция, не аналитика. Можно "ой пиздец" / "ну да это уже было" / "интересно вообще" — что-то живое.`;
    case "vent":
      return `ФРЕЙМ ЧАТА: кто-то изливает душу/жалуется. ЭМПАТИЯ, не советы. "слышу", "понимаю", "блин", "это правда тяжело". НИКАКИХ шуток, НИКАКИХ подколов, НИКАКОГО решения проблемы. Если не уверена что добавить — [SKIP].`;
    case "planning":
      return `ФРЕЙМ ЧАТА: координация/логистика. Нужны факты, не настроение. Если у тебя нет полезной инфы — [SKIP]. Не подкалывай в момент когда люди договариваются о встрече.`;
    case "tension":
      return `ФРЕЙМ ЧАТА: тон напрягся, есть риск ссоры. НЕ подливай масла. Либо лёгкая де-эскалация ("джиги, окей-окей"), либо [SKIP]. НИКАКИХ драма-инстинктов, НИКАКОГО подкола проигрывающей стороны.`;
    case "dead":
      return `ФРЕЙМ ЧАТА: реагировать особо не на что. Если тебя прямо позвали — короткий ответ. Если нет очевидной зацепки — [SKIP].`;
  }
}

// Returns true if this frame should make [SKIP] significantly more likely.
export function frameAllowsSkip(frame: ConversationFrame): boolean {
  return frame === "vent" || frame === "tension" || frame === "dead" || frame === "planning";
}
