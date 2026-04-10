// ─── Rate Limiting ───────────────────────────────────────────────────────────

import type { Env } from "./config";
import { VIP_GROUP_ID, DAILY_RATE_LIMIT } from "./config";

const RATE_TTL = 60 * 60 * 25; // 25 hours

function rateKey(chatId: number): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `rate:${chatId}:${date}`;
}

// ─── Check & Increment ──────────────────────────────────────────────────────

export async function checkRateLimit(env: Env, chatId: number): Promise<{ allowed: boolean; remaining: number }> {
  // VIP group is unlimited
  if (chatId === VIP_GROUP_ID) {
    return { allowed: true, remaining: Infinity };
  }

  const key = rateKey(chatId);
  const raw = await env.KV.get(key);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= DAILY_RATE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  // Increment
  await env.KV.put(key, String(count + 1), { expirationTtl: RATE_TTL });

  return { allowed: true, remaining: DAILY_RATE_LIMIT - count - 1 };
}

// ─── Rate Limit Message ─────────────────────────────────────────────────────

export const RATE_LIMIT_MESSAGE = "Сорри, на сегодня у меня лимит 💅 Напиши https://t.me/kamsqe если хочешь безлимит";

// ─── RPM Throttle (Global Blackout) ─────────────────────────────────────────

const RPM_SOFT_LIMIT = 8;   // Start lazy mode (skip sentiment, shorter)
const RPM_HARD_LIMIT = 12;  // Full blackout — no LLM calls
const BLACKOUT_DURATION_MS = 100_000; // ~1.7 minutes

function rpmKey(): string {
  const bucket = Math.floor(Date.now() / 60000);
  return `rpm:${bucket}`;
}

function blackoutKey(chatId: number): string {
  return `blackout:${chatId}`;
}

export type ThrottleLevel = "normal" | "lazy" | "blackout";

export async function checkRPMThrottle(env: Env): Promise<ThrottleLevel> {
  const key = rpmKey();
  const raw = await env.KV.get(key);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= RPM_HARD_LIMIT) return "blackout";
  if (count >= RPM_SOFT_LIMIT) return "lazy";
  return "normal";
}

export async function trackLLMCall(env: Env): Promise<void> {
  const key = rpmKey();
  const raw = await env.KV.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  await env.KV.put(key, String(count + 1), { expirationTtl: 120 });
}

export async function enterBlackout(env: Env, chatId: number, missedCount: number = 1): Promise<void> {
  const key = blackoutKey(chatId);
  const raw = await env.KV.get(key);
  let state: { enteredAt: number; missedMessages: number };

  if (raw) {
    state = JSON.parse(raw);
    state.missedMessages += missedCount;
  } else {
    state = { enteredAt: Date.now(), missedMessages: missedCount };
  }

  await env.KV.put(key, JSON.stringify(state), { expirationTtl: 300 });
}

export async function getBlackoutState(env: Env, chatId: number): Promise<{ inBlackout: boolean; missedMessages: number; recoveryReady: boolean }> {
  const key = blackoutKey(chatId);
  const raw = await env.KV.get(key);

  if (!raw) return { inBlackout: false, missedMessages: 0, recoveryReady: false };

  const state: { enteredAt: number; missedMessages: number } = JSON.parse(raw);
  const elapsed = Date.now() - state.enteredAt;

  if (elapsed >= BLACKOUT_DURATION_MS) {
    // Blackout expired — ready for recovery
    await env.KV.delete(key);
    return { inBlackout: false, missedMessages: state.missedMessages, recoveryReady: true };
  }

  return { inBlackout: true, missedMessages: state.missedMessages, recoveryReady: false };
}
