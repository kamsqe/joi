// ─── Rate Limiting (D1-backed) ───────────────────────────────────────────────

import type { Env } from "./config";
import { VIP_GROUP_ID, DAILY_RATE_LIMIT } from "./config";

// ─── Check & Increment Daily Rate ────────────────────────────────────────────

export async function checkRateLimit(env: Env, chatId: number): Promise<{ allowed: boolean; remaining: number }> {
  // VIP group is unlimited
  if (chatId === VIP_GROUP_ID) {
    return { allowed: true, remaining: Infinity };
  }

  const date = new Date().toISOString().slice(0, 10);
  const key = `rate:${chatId}:${date}`;
  const now = Date.now();
  const expiresAt = now + 25 * 60 * 60 * 1000; // 25 hours

  const row = await env.DB.prepare(
    `SELECT count FROM rate_limits WHERE key = ? AND expires_at > ?`,
  )
    .bind(key, now)
    .first<{ count: number }>();

  const count = row?.count || 0;

  if (count >= DAILY_RATE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  // Increment
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET count = count + 1`,
  )
    .bind(key, expiresAt)
    .run();

  return { allowed: true, remaining: DAILY_RATE_LIMIT - count - 1 };
}

// ─── Rate Limit Message ─────────────────────────────────────────────────────

export const RATE_LIMIT_MESSAGE = "Сорри, на сегодня у меня лимит 💅 Напиши https://t.me/kamsqe если хочешь безлимит";

// ─── RPM Throttle (Global Blackout) ─────────────────────────────────────────

const RPM_SOFT_LIMIT = 80;   // Start lazy mode (skip sentiment, shorter)
const RPM_HARD_LIMIT = 120;  // Full blackout — no LLM calls
const BLACKOUT_DURATION_MS = 100_000; // ~1.7 minutes

export type ThrottleLevel = "normal" | "lazy" | "blackout";

export async function checkRPMThrottle(env: Env): Promise<ThrottleLevel> {
  const bucket = Math.floor(Date.now() / 60000);
  const key = `rpm:${bucket}`;
  const now = Date.now();

  const row = await env.DB.prepare(
    `SELECT count FROM rate_limits WHERE key = ? AND expires_at > ?`,
  )
    .bind(key, now)
    .first<{ count: number }>();

  const count = row?.count || 0;

  if (count >= RPM_HARD_LIMIT) return "blackout";
  if (count >= RPM_SOFT_LIMIT) return "lazy";
  return "normal";
}

export async function trackLLMCall(env: Env): Promise<void> {
  const bucket = Math.floor(Date.now() / 60000);
  const key = `rpm:${bucket}`;
  const expiresAt = Date.now() + 120_000; // 2 minutes

  await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET count = count + 1`,
  )
    .bind(key, expiresAt)
    .run();
}

export async function enterBlackout(env: Env, chatId: number, missedCount: number = 1): Promise<void> {
  const key = `blackout:${chatId}`;
  const now = Date.now();
  const expiresAt = now + 300_000; // 5 minutes

  const row = await env.DB.prepare(
    `SELECT data FROM rate_limits WHERE key = ? AND expires_at > ?`,
  )
    .bind(key, now)
    .first<{ data: string | null }>();

  let state: { enteredAt: number; missedMessages: number };

  if (row?.data) {
    state = JSON.parse(row.data);
    state.missedMessages += missedCount;
  } else {
    state = { enteredAt: now, missedMessages: missedCount };
  }

  await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, data, expires_at) VALUES (?, 0, ?, ?)
     ON CONFLICT(key) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
  )
    .bind(key, JSON.stringify(state), expiresAt)
    .run();
}

export async function getBlackoutState(env: Env, chatId: number): Promise<{ inBlackout: boolean; missedMessages: number; recoveryReady: boolean }> {
  const key = `blackout:${chatId}`;
  const now = Date.now();

  const row = await env.DB.prepare(
    `SELECT data, expires_at FROM rate_limits WHERE key = ?`,
  )
    .bind(key)
    .first<{ data: string | null; expires_at: number }>();

  if (!row?.data) return { inBlackout: false, missedMessages: 0, recoveryReady: false };

  const state: { enteredAt: number; missedMessages: number } = JSON.parse(row.data);
  const elapsed = now - state.enteredAt;

  if (elapsed >= BLACKOUT_DURATION_MS) {
    // Blackout expired — ready for recovery
    await env.DB.prepare(`DELETE FROM rate_limits WHERE key = ?`).bind(key).run();
    return { inBlackout: false, missedMessages: state.missedMessages, recoveryReady: true };
  }

  return { inBlackout: true, missedMessages: state.missedMessages, recoveryReady: false };
}

// ─── Prune Expired Rate Limits (called by cron) ─────────────────────────────

export async function pruneExpiredRateLimits(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM rate_limits WHERE expires_at < ?`).bind(Date.now()).run();
}
