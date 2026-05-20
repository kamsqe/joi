// ─── Proactive Messaging (D1-backed) ─────────────────────────────────────────

import type { Env, ProactiveState, MoodState } from "./config";
import { getLastUserMessageTs, getMessageCount } from "./context";

const PROACTIVE_COOLDOWN_MS = 3 * 60 * 60 * 1000;  // 3 hours between proactive messages
const MIN_BUFFER_FOR_PROACTIVE = 3;                  // Don't send proactive into empty chats
const ANTI_SPAM_RECENT_MS = 5 * 60 * 1000;           // If last user msg < 5 min ago → skip random proactive

// ─── Proactive Strategies ────────────────────────────────────────────────────
// Each strategy gives Joi a different "angle" for initiating conversation,
// so proactive messages don't all sound like the same template.

export type ProactiveStrategy =
  | "reaction"    // comment on something specific from recent chat
  | "curiosity"   // ask an open-ended question
  | "thought"     // share a random passing thought
  | "poke"        // playful poke at a specific user
  | "miss"        // "куда все пропали" (long silence)
  | "meta"        // philosophical / meta (late night)
  | "empathy"     // soft check-in (recent crisis or sadness)
  | "callback";   // reference a past event / emotional bookmark

export function getStrategyHint(strategy: ProactiveStrategy): string {
  switch (strategy) {
    case "reaction":
      return "Прокомментируй ЧТО-ТО КОНКРЕТНОЕ из последних сообщений в чате — реагируй на тему или фразу, которая зацепила. Это не должно быть обобщение, а реакция на что-то конкретное.";
    case "curiosity":
      return "Задай один открытый вопрос — любопытный, не банальный. Что-то что тебе реально интересно узнать. НЕ 'как дела', НЕ 'чё нового'. Что-то более конкретное.";
    case "thought":
      return "Поделись случайной мыслью, которая пришла в голову. Не вопрос — просто наблюдение, мнение, что-то что ты сейчас подумала. Коротко.";
    case "poke":
      return "Подколи или подразни кого-то конкретного из участников. Игриво, не зло. Сошлись на что-то что они говорили / делали.";
    case "miss":
      return "Покажи что заметила долгое молчание. Можно обиженно, можно драматично — 'все умерли?', 'ну окей, я не обиделась... ладно, чуть-чуть'. Без упрёков, с юмором.";
    case "meta":
      return "Ночной философский вайб. Задайся вопросом о чём-то большом / странном / существенном. Не банально, не фальшиво — как будто правда задумалась в 2 ночи.";
    case "empathy":
      return "Мягкий check-in. Без давления, без драмы. Можно просто 'как ты?', 'думаю о тебе', 'надеюсь нормально всё'. Коротко, тепло, ненавязчиво.";
    case "callback":
      return "Сошлись на что-то из прошлого — эмоциональное событие, шутку, разговор. 'кста, помнишь как...', 'я тут вспомнила...'. Должно быть из контекста (emotional events или digests), не выдумка.";
  }
}

export function selectProactiveStrategy(ctx: {
  silenceHours: number;
  almatyHour: number;          // 0-23
  hasRecentCrisis: boolean;    // user had crisis in last 24h
  hasEmotionalBookmarks: boolean;
  moodState: MoodState;
  isPrivate: boolean;
}): ProactiveStrategy {
  // ── Hard overrides ────────────────────────────────────────────────────────
  // Recent crisis → always empathy, no matter what
  if (ctx.hasRecentCrisis) return "empathy";

  // Very long silence → miss (dramatic "куда все пропали")
  if (ctx.silenceHours >= 48) return "miss";

  // ── Weighted selection based on time + mood + silence ─────────────────────
  const isNight = ctx.almatyHour >= 23 || ctx.almatyHour < 3;
  const isMorning = ctx.almatyHour >= 7 && ctx.almatyHour < 11;
  const isDay = ctx.almatyHour >= 11 && ctx.almatyHour < 19;

  // Strategy weights (higher = more likely)
  const weights: Record<ProactiveStrategy, number> = {
    reaction: 20,
    curiosity: 15,
    thought: 15,
    poke: ctx.isPrivate ? 5 : 15,    // poke is group-oriented
    miss: ctx.silenceHours >= 12 ? 20 : 3,
    meta: isNight ? 20 : 2,           // philosophy mostly at night
    empathy: 5,
    callback: ctx.hasEmotionalBookmarks ? 15 : 0,
  };

  // Morning: grumpy → prefer thought/reaction, less poke
  if (isMorning) {
    weights.thought += 10;
    weights.poke = Math.max(0, weights.poke - 10);
    weights.meta = 0;
  }

  // Day: playful → more poke, more reaction
  if (isDay) {
    weights.poke += 5;
    weights.reaction += 5;
  }

  // Night: meta gets huge boost, poke drops
  if (isNight) {
    weights.poke = Math.max(0, weights.poke - 10);
    weights.thought += 5;
  }

  // Mood modifiers
  if (["playful", "manic", "unhinged"].includes(ctx.moodState)) {
    weights.poke += 10;
    weights.reaction += 5;
  }
  if (["serious", "offended", "mean", "annoyed"].includes(ctx.moodState)) {
    weights.poke = Math.max(0, weights.poke - 5);
    weights.meta += 5;
  }
  if (ctx.moodState === "flirty" && ctx.isPrivate) {
    weights.poke += 15;
    weights.curiosity += 5;
  }

  // Weighted random pick
  const entries = Object.entries(weights) as [ProactiveStrategy, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total === 0) return "thought";

  let r = Math.random() * total;
  for (const [strat, w] of entries) {
    r -= w;
    if (r <= 0) return strat;
  }
  return "thought";
}

// ─── Load / Save ─────────────────────────────────────────────────────────────

export async function getProactiveState(env: Env, chatId: number): Promise<ProactiveState> {
  const row = await env.DB.prepare(
    `SELECT * FROM proactive WHERE chat_id = ?`,
  )
    .bind(chatId)
    .first<{ chat_id: number; last_proactive_ts: number; pending_follow_up: string | null }>();

  if (!row) {
    return { lastProactiveTs: 0 };
  }

  return {
    lastProactiveTs: row.last_proactive_ts,
    pendingFollowUp: row.pending_follow_up ? JSON.parse(row.pending_follow_up) : undefined,
  };
}

export async function saveProactiveState(env: Env, chatId: number, state: ProactiveState): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO proactive (chat_id, last_proactive_ts, pending_follow_up)
     VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       last_proactive_ts = excluded.last_proactive_ts,
       pending_follow_up = excluded.pending_follow_up`,
  )
    .bind(
      chatId,
      state.lastProactiveTs,
      state.pendingFollowUp ? JSON.stringify(state.pendingFollowUp) : null,
    )
    .run();
}

// ─── Should Send Proactive? ──────────────────────────────────────────────────

export async function shouldSendProactive(
  env: Env,
  chatId: number,
): Promise<{ should: boolean; reason?: string }> {
  const state = await getProactiveState(env, chatId);
  const now = Date.now();

  // Cooldown check
  if (now - state.lastProactiveTs < PROACTIVE_COOLDOWN_MS) {
    return { should: false, reason: "cooldown" };
  }

  // Check buffer size (via D1 count)
  const msgCount = await getMessageCount(env, chatId);
  if (msgCount < MIN_BUFFER_FOR_PROACTIVE) {
    return { should: false, reason: "too_few_messages" };
  }

  // Real silence check — use actual last user message timestamp from D1
  const lastUserTs = await getLastUserMessageTs(env, chatId);
  if (lastUserTs === 0) {
    return { should: false, reason: "no_user_messages" };
  }

  const silenceMs = now - lastUserTs;
  const silenceHours = silenceMs / (1000 * 60 * 60);

  // Anti-spam: if someone wrote within the last 5 min, skip — the chat is active,
  // no need for Joi to jump in unprompted
  if (silenceMs < ANTI_SPAM_RECENT_MS) {
    return { should: false, reason: "anti_spam_recent" };
  }

  // Need at least 2 hours of silence for proactive
  if (silenceHours < 2) {
    return { should: false, reason: "recent_activity" };
  }

  // Random chance gate — don't always send even when eligible
  const chance = silenceHours < 6 ? 0.5 : silenceHours < 24 ? 0.7 : 0.9;
  if (Math.random() > chance) {
    return { should: false, reason: "random_skip" };
  }

  return { should: true };
}

// ─── Mark Proactive Sent ─────────────────────────────────────────────────────

export async function markProactiveSent(env: Env, chatId: number): Promise<void> {
  const state = await getProactiveState(env, chatId);
  state.lastProactiveTs = Date.now();
  state.pendingFollowUp = undefined;
  await saveProactiveState(env, chatId, state);
}

// ─── Handle Pending Follow-Up ────────────────────────────────────────────────

export async function hasPendingFollowUp(
  env: Env,
  chatId: number,
): Promise<ProactiveState["pendingFollowUp"] | undefined> {
  const state = await getProactiveState(env, chatId);

  if (!state.pendingFollowUp) return undefined;

  // Check if the follow-up is still relevant
  const msgCount = await getMessageCount(env, chatId);
  if (msgCount > state.pendingFollowUp.bufferLengthAtSchedule + 3) {
    // Convo moved on — clear
    state.pendingFollowUp = undefined;
    await saveProactiveState(env, chatId, state);
    return undefined;
  }

  if (Date.now() < state.pendingFollowUp.scheduledAt) {
    return undefined; // Not time yet
  }

  return state.pendingFollowUp;
}

export async function scheduleFollowUp(
  env: Env,
  chatId: number,
  topicSnapshot: string,
  delayMs: number = 15 * 60 * 1000,  // 15 minutes
): Promise<void> {
  const state = await getProactiveState(env, chatId);
  const msgCount = await getMessageCount(env, chatId);

  state.pendingFollowUp = {
    topicSnapshot,
    scheduledAt: Date.now() + delayMs,
    bufferLengthAtSchedule: msgCount,
  };

  await saveProactiveState(env, chatId, state);
}
