// ─── Proactive Messaging (D1-backed) ─────────────────────────────────────────

import type { Env, ProactiveState } from "./config";
import { getLastUserMessageTs, getMessageCount } from "./context";

const PROACTIVE_COOLDOWN_MS = 3 * 60 * 60 * 1000;  // 3 hours between proactive messages
const MIN_BUFFER_FOR_PROACTIVE = 3;                  // Don't send proactive into empty chats

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
