// ─── Proactive Messaging ─────────────────────────────────────────────────────

import type { Env, ProactiveState, MoodData } from "./config";
import { VIP_GROUP_ID } from "./config";
import { getMood, isInCoolPeriod } from "./mood";
import { getBuffer } from "./context";

const PROACTIVE_TTL = 60 * 60 * 24 * 7; // 7 days
const MIN_PROACTIVE_INTERVAL = 30 * 60 * 1000; // 30 min between proactive messages

function proactiveKey(chatId: number): string {
  return `proactive:${chatId}`;
}

// ─── Load / Save State ───────────────────────────────────────────────────────

export async function getProactiveState(env: Env, chatId: number): Promise<ProactiveState> {
  try {
    const raw = await env.KV.get(proactiveKey(chatId));
    if (raw) return JSON.parse(raw) as ProactiveState;
  } catch { /* fall through */ }

  return { lastProactiveTs: 0 };
}

async function saveProactiveState(env: Env, chatId: number, state: ProactiveState): Promise<void> {
  await env.KV.put(proactiveKey(chatId), JSON.stringify(state), {
    expirationTtl: PROACTIVE_TTL,
  });
}

// ─── Should Send Proactive Message? ──────────────────────────────────────────

export async function shouldSendProactive(
  env: Env,
  chatId: number,
  isPrivate: boolean,
): Promise<boolean> {
  const state = await getProactiveState(env, chatId);
  const mood = await getMood(env, chatId);

  // Don't spam — respect minimum interval
  if (Date.now() - state.lastProactiveTs < MIN_PROACTIVE_INTERVAL) {
    return false;
  }

  // Need some buffer history to have context
  const buffer = await getBuffer(env, chatId);
  if (buffer.length < 3) return false;

  // Calculate probability based on mood + chat type + per-chat boost
  const chance = getProactiveChance(mood, isPrivate, chatId);
  return Math.random() < chance;
}

// ─── Proactive Chance by Mood ────────────────────────────────────────────────

// Per-chat proactive multipliers (overrides default ×1.5 for private)
const PROACTIVE_MULTIPLIERS: Record<number, number> = {
  5314954143: 3,   // Дина — ×2 от дефолта (3 / 1.5 = 2x boost)
  163421204:  9,   // Алишер — ×6 от дефолта (9 / 1.5 = 6x boost)
};

function getProactiveChance(mood: MoodData, isPrivate: boolean, chatId?: number): number {
  const baseMoodChances: Record<string, number> = {
    happy:    0.10,
    playful:  0.12,
    chill:    0.04,
    flirty:   0.08,
    annoyed:  0.03,
    offended: 0.02, // only snarky stuff
    mean:     0.03,
    serious:  0.03,
    unhinged: 0.10,
    manic:    0.12,
  };

  let chance = baseMoodChances[mood.mood] ?? 0.05;

  // Per-chat multiplier or default private boost
  const perChatMultiplier = chatId ? PROACTIVE_MULTIPLIERS[chatId] : undefined;
  if (perChatMultiplier) {
    chance *= perChatMultiplier;
  } else if (isPrivate) {
    chance *= 1.5;
  }

  // Offended with cool period: very low
  if (isInCoolPeriod(mood)) chance = 0.02;

  // Cap at 95% to avoid guaranteed spam
  return Math.min(chance, 0.95);
}

// ─── Mark Proactive Message Sent ─────────────────────────────────────────────

export async function markProactiveSent(env: Env, chatId: number): Promise<void> {
  const state = await getProactiveState(env, chatId);
  state.lastProactiveTs = Date.now();
  state.pendingFollowUp = undefined;
  await saveProactiveState(env, chatId, state);
}

// ─── Schedule Delayed Follow-up ──────────────────────────────────────────────

export async function scheduleFollowUp(
  env: Env,
  chatId: number,
  topicSnapshot: string,
  bufferLength: number,
): Promise<void> {
  const state = await getProactiveState(env, chatId);

  state.pendingFollowUp = {
    topicSnapshot,
    scheduledAt: Date.now() + (5 + Math.random() * 25) * 60 * 1000, // 5-30 min
    bufferLengthAtSchedule: bufferLength,
  };

  await saveProactiveState(env, chatId, state);
}

// ─── Check if Follow-up is Still Relevant ────────────────────────────────────

export async function checkPendingFollowUp(
  env: Env,
  chatId: number,
): Promise<{ shouldSend: boolean; topicSnapshot?: string }> {
  const state = await getProactiveState(env, chatId);
  const followUp = state.pendingFollowUp;

  if (!followUp) return { shouldSend: false };

  // Not yet time
  if (Date.now() < followUp.scheduledAt) return { shouldSend: false };

  // Check if conversation moved on
  const buffer = await getBuffer(env, chatId);
  const newMessages = buffer.length - followUp.bufferLengthAtSchedule;

  // If 5+ new messages since scheduling, topic probably moved on → skip
  if (newMessages >= 5) {
    state.pendingFollowUp = undefined;
    await saveProactiveState(env, chatId, state);
    return { shouldSend: false };
  }

  // Clear the follow-up
  state.pendingFollowUp = undefined;
  state.lastProactiveTs = Date.now();
  await saveProactiveState(env, chatId, state);

  return { shouldSend: true, topicSnapshot: followUp.topicSnapshot };
}
