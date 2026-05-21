// ─── Living Interests ───────────────────────────────────────────────────────
// Joi has one rotating "current obsession" per chat — a topic she's been into
// the last few days. The brainstorm's Symptom 2 was that BASE_PERSONALITY
// hardcodes canon hobbies (Скриптонит, кошки, астрология, кофе) and the LLM
// faithfully resurfaces them every turn. This module replaces that with:
//
//   1. A pool of candidate topics (canon seed + organic additions from chat).
//   2. A "current" one that's active for 3-7 days, then rotates.
//   3. A *probabilistic* mention gate per turn — she mentions her obsession
//      sometimes, not always. Probability depends on mood, frame, recency.
//
// The LLM only ever sees the *current* topic (or nothing). The canon list
// in BASE_PERSONALITY can stay as background flavor but the load-bearing
// "what she's into right now" lives in this table.

import type { Env, MoodState } from "./config";

export interface Interest {
  id: number;
  chatId: number;
  topic: string;
  flavor?: string;
  source: string;
  isCurrent: boolean;
  intensity: number;
  startedAt: number | null;
  lastMentioned: number | null;
  tsCreated: number;
}

// Canon seed pool — what Joi could plausibly be obsessing over at any time.
// Mixed: some shallow/funny, some serious, some niche. The rotation picks
// from these unless an organic one has been added from chat context.
const SEED_TOPICS: { topic: string; flavor: string }[] = [
  { topic: "корейские дорамы", flavor: "залипает на одну в неделю, ругается на сюжетные дыры" },
  { topic: "документалки про океан", flavor: "цитирует Аттенборо, пугает фактами про кашалотов" },
  { topic: "шахматы онлайн", flavor: "проигрывает блицам и злится, ELO 800 застряло намертво" },
  { topic: "теории заговора про NASA", flavor: "не верит всерьёз, но любит рассказывать" },
  { topic: "карты таро", flavor: "тянет одну карту утром и весь день её интерпретирует" },
  { topic: "история кочевников", flavor: "цепляется за случайные факты про каганаты и нойонов" },
  { topic: "редкие виды кофе", flavor: "хочет попробовать копи лювак, но жалко денег" },
  { topic: "японская керамика", flavor: "сохраняет в инсте кружки, никогда не покупает" },
  { topic: "матчи лиги чемпионов", flavor: "диванный аналитик с твёрдым мнением про каждого тренера" },
  { topic: "странные книги Викторианской эпохи", flavor: "началось со страниц про спиритизм" },
  { topic: "видео про дрессировку котов", flavor: "хочет научить своего трюкам, но он не сотрудничает" },
  { topic: "ASMR-каналы на корейском", flavor: "фоном на работе, не понимает ни слова, всё равно успокаивает" },
  { topic: "минералогия", flavor: "хочет коллекцию камней, начала с амазонита" },
  { topic: "пересмотр сериалов нулевых", flavor: "Lost / Skins / OC — ностальгия и кринж одновременно" },
  { topic: "ретро-инди-игры", flavor: "ищет что-то с пиксельной графикой и хорошим сюжетом" },
];

const MIN_DURATION_MS = 3 * 24 * 60 * 60 * 1000;    // current stays at least 3 days
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;    // rotates after 7
const RECENT_MENTION_QUIET_MS = 4 * 60 * 60 * 1000; // 4h after a mention, low chance

// ─── Read / write ───────────────────────────────────────────────────────────

function rowToInterest(row: any): Interest {
  return {
    id: row.id,
    chatId: row.chat_id,
    topic: row.topic,
    flavor: row.flavor ?? undefined,
    source: row.source ?? "canon",
    isCurrent: !!row.is_current,
    intensity: row.intensity ?? 0.5,
    startedAt: row.started_at ?? null,
    lastMentioned: row.last_mentioned ?? null,
    tsCreated: row.ts_created,
  };
}

export async function getCurrentInterest(env: Env, chatId: number): Promise<Interest | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM interests WHERE chat_id = ? AND is_current = 1 LIMIT 1`,
  ).bind(chatId).first();
  return row ? rowToInterest(row) : null;
}

async function seedIfEmpty(env: Env, chatId: number): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM interests WHERE chat_id = ?`,
  ).bind(chatId).first<{ cnt: number }>();
  if (row && row.cnt > 0) return;

  // Seed the canon topics for this chat
  const now = Date.now();
  const statements = SEED_TOPICS.map((s) =>
    env.DB.prepare(
      `INSERT INTO interests (chat_id, topic, flavor, source, is_current, intensity, ts_created)
       VALUES (?, ?, ?, 'canon', 0, 0.5, ?)`,
    ).bind(chatId, s.topic, s.flavor, now),
  );
  await env.DB.batch(statements);
}

// ─── Rotation ───────────────────────────────────────────────────────────────
// Called by cron. Picks a new current if:
//   - none is current, or
//   - current is older than MIN_DURATION_MS and a coin flip says "rotate",
//   - current is older than MAX_DURATION_MS (forced rotation).
// New picks weight by inverse-recency: topics not recently current are
// preferred, so she doesn't bounce between two favorites.

export async function rotateInterestIfNeeded(env: Env, chatId: number): Promise<Interest | null> {
  await seedIfEmpty(env, chatId);
  const current = await getCurrentInterest(env, chatId);
  const now = Date.now();

  if (current) {
    const age = now - (current.startedAt ?? current.tsCreated);
    const shouldRotate = age >= MAX_DURATION_MS
      || (age >= MIN_DURATION_MS && Math.random() < 0.15);
    if (!shouldRotate) return current;
  }

  // Pick next: prefer those not recently active. Score = 1 / (1 + days_since_last_current)
  const candidates = await env.DB.prepare(
    `SELECT * FROM interests WHERE chat_id = ? AND (is_current = 0 OR id != COALESCE(?, -1))`,
  ).bind(chatId, current?.id ?? null).all<any>();

  if (!candidates.results || candidates.results.length === 0) return current;

  const scored = candidates.results.map((r) => {
    const interest = rowToInterest(r);
    const daysSince = interest.startedAt
      ? Math.max(0.5, (now - interest.startedAt) / (24 * 60 * 60 * 1000))
      : 30; // never been current → high score
    const weight = 1 / (1 + 1 / daysSince);
    return { interest, weight };
  });

  // Weighted random pick
  const total = scored.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  let chosen = scored[0].interest;
  for (const s of scored) {
    r -= s.weight;
    if (r <= 0) { chosen = s.interest; break; }
  }

  // Atomic: unset old current, set new
  const statements = [];
  if (current) {
    statements.push(env.DB.prepare(`UPDATE interests SET is_current = 0 WHERE id = ?`).bind(current.id));
  }
  statements.push(env.DB.prepare(
    `UPDATE interests SET is_current = 1, intensity = 0.7, started_at = ? WHERE id = ?`,
  ).bind(now, chosen.id));
  await env.DB.batch(statements);

  console.log(JSON.stringify({
    event: "interest_rotated",
    chatId,
    from: current?.topic ?? null,
    to: chosen.topic,
  }));

  return { ...chosen, isCurrent: true, intensity: 0.7, startedAt: now };
}

// ─── Mention gate ───────────────────────────────────────────────────────────
// Probabilistic — she only mentions her obsession sometimes. The user said:
// "she should act like a real human, when sometimes she is in the mood to
// talk about her obsessions, sometimes not, etc."
//
// Computes a mention probability based on mood, recency, and frame; returns
// the system-prompt block or null (silent influence).

export interface MentionContext {
  mood: MoodState;
  intensity: number;       // 0..100
  recentBotMessages: string[];
  hasCrisis?: boolean;
}

const MOOD_BOOST: Partial<Record<MoodState, number>> = {
  manic: 0.35,
  playful: 0.20,
  unhinged: 0.20,
  happy: 0.10,
  flirty: 0.05,
  chill: 0.00,
  serious: -0.15,
  annoyed: -0.10,
  offended: -0.20,
  mean: -0.10,
};

export function shouldMentionInterest(
  interest: Interest,
  ctx: MentionContext,
): { mention: boolean; probability: number; reason: string } {
  // Hard nos
  if (ctx.hasCrisis) return { mention: false, probability: 0, reason: "crisis" };

  // Recency: if she just mentioned it, quiet down
  const now = Date.now();
  if (interest.lastMentioned && now - interest.lastMentioned < RECENT_MENTION_QUIET_MS) {
    return { mention: false, probability: 0, reason: "recent_mention" };
  }

  // Base probability scaled by intensity
  let p = 0.15 + interest.intensity * 0.15; // 0.15..0.30
  p += MOOD_BOOST[ctx.mood] ?? 0;
  p += (ctx.intensity - 50) * 0.002; // higher mood-intensity nudges up

  // Anti-repetition: if topic name appears in recent outputs, suppress
  const topicLower = interest.topic.toLowerCase();
  const recentHits = ctx.recentBotMessages
    .slice(0, 5)
    .filter((m) => m.toLowerCase().includes(topicLower.split(/\s+/)[0])).length;
  if (recentHits > 0) p *= 0.2;

  p = Math.max(0, Math.min(0.8, p));
  return {
    mention: Math.random() < p,
    probability: p,
    reason: "computed",
  };
}

// ─── Prompt block ───────────────────────────────────────────────────────────

export function interestBlock(interest: Interest, willMention: boolean): string {
  if (willMention) {
    return `ТЕБЯ СЕЙЧАС ЗАЛИПАЕТ: ${interest.topic}${interest.flavor ? ` (${interest.flavor})` : ""}.
В этом ответе можешь ВВЕРНУТЬ эту тему — естественно, не за уши. Если контекст не позволяет — просто не упоминай, не натягивай.`;
  }
  // Silent mode — tone bias only, no mention permission
  return `(У тебя сейчас фоновая тема которая тебя задрала: ${interest.topic}. В этом ответе её НЕ упоминай — слишком часто была. Но настроение чуть с её отпечатком.)`;
}

// ─── Record a mention ───────────────────────────────────────────────────────
// Called after the response is generated, if the response actually contained
// the topic keyword. Updates last_mentioned + slightly decays intensity (so
// repeated mentions push her toward rotating soon).

export async function recordMention(env: Env, interestId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE interests SET last_mentioned = ?, intensity = MAX(0.1, intensity - 0.05) WHERE id = ?`,
  ).bind(Date.now(), interestId).run();
}
