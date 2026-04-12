// ─── Conversation Digests — Medium-Term Contextual Awareness ─────────────────
// Two-tier system:
//   Tier 1: Activity Digest (SQL-only, zero cost) — who's active, chat energy
//   Tier 2: LLM Topic Digest (periodic) — what was discussed, stored in D1

import type { Env, LLMMessage } from "./config";
import { callLLMLight } from "./ai";

// ─── Constants ───────────────────────────────────────────────────────────────

const DIGEST_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between digests
const MIN_MESSAGES_FOR_DIGEST = 5;
const MIN_UNIQUE_USERS = 2;
const MAX_DIGESTS_PER_CHAT = 5;
const DIGEST_MAX_AGE_MS = 6 * 60 * 60 * 1000; // only include digests < 6h old in prompt
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

// ─── Tier 1: Activity Digest (SQL-only, called per buildContext) ─────────────

export interface ActivityDigest {
  users: { name: string; msgCount: number; lastSeenAgo: string }[];
  totalRecent: number;
  uniqueUsers: number;
}

export async function buildActivityDigest(
  env: Env,
  chatId: number,
): Promise<string | null> {
  const sixHoursAgo = Date.now() - SIX_HOURS_MS;

  const rows = await env.DB.prepare(
    `SELECT user_name, COUNT(*) as msg_count, MAX(ts) as last_ts,
       AVG(LENGTH(content)) as avg_len
     FROM messages
     WHERE chat_id = ? AND role = 'user' AND is_bot = 0 AND ts > ?
     GROUP BY user_id ORDER BY last_ts DESC LIMIT 10`,
  )
    .bind(chatId, sixHoursAgo)
    .all<{ user_name: string; msg_count: number; last_ts: number; avg_len: number }>();

  if (!rows.results || rows.results.length === 0) {
    // Check if there's ANY recent activity in the last 24h
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const anyActivity = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM messages WHERE chat_id = ? AND role = 'user' AND is_bot = 0 AND ts > ?`,
    ).bind(chatId, dayAgo).first<{ cnt: number }>();

    if (!anyActivity || anyActivity.cnt === 0) return null;
    return `АКТИВНОСТЬ ЧАТА: тишина — никто не писал больше 6 часов.`;
  }

  const lines = rows.results.map((r) => {
    const ago = formatRelativeTime(r.last_ts);
    const lengthHint = r.avg_len > 150 ? " (длинные сообщения)" : r.avg_len < 20 ? " (короткие)" : "";
    return `- ${r.user_name}: ${r.msg_count} сообщ., последнее ${ago}${lengthHint}`;
  });

  const totalMsgs = rows.results.reduce((sum, r) => sum + r.msg_count, 0);
  const energy = totalMsgs > 15 ? "активный чат" : totalMsgs > 5 ? "средняя активность" : "тихий чат";

  return `АКТИВНОСТЬ ЧАТА (${energy}, за 6ч):\n${lines.join("\n")}`;
}

// ─── Tier 2: LLM Topic Digest ────────────────────────────────────────────────

export interface StoredDigest {
  summary: string;
  createdAt: number;
  periodStart: number;
  periodEnd: number;
}

// Check if digest should be generated (called by cron)
export async function shouldGenerateDigest(
  env: Env,
  chatId: number,
): Promise<boolean> {
  // Check cooldown — last digest must be >30 min ago
  const lastDigest = await env.DB.prepare(
    `SELECT created_at FROM digests WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(chatId).first<{ created_at: number }>();

  if (lastDigest && Date.now() - lastDigest.created_at < DIGEST_COOLDOWN_MS) {
    return false;
  }

  // Check if there are enough new messages from 2+ users since last digest
  const sinceTs = lastDigest?.created_at || (Date.now() - SIX_HOURS_MS);
  const stats = await env.DB.prepare(
    `SELECT COUNT(*) as cnt, COUNT(DISTINCT user_id) as unique_users
     FROM messages
     WHERE chat_id = ? AND role = 'user' AND is_bot = 0 AND ts > ?`,
  )
    .bind(chatId, sinceTs)
    .first<{ cnt: number; unique_users: number }>();

  if (!stats) return false;
  return stats.cnt >= MIN_MESSAGES_FOR_DIGEST && stats.unique_users >= MIN_UNIQUE_USERS;
}

// Generate and store a digest
export async function generateAndStoreDigest(
  env: Env,
  chatId: number,
): Promise<void> {
  // Get last digest timestamp to know where to start
  const lastDigest = await env.DB.prepare(
    `SELECT period_end FROM digests WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(chatId).first<{ period_end: number }>();

  const sinceTs = lastDigest?.period_end || (Date.now() - SIX_HOURS_MS);

  // Fetch messages since last digest
  const rows = await env.DB.prepare(
    `SELECT user_name, content, ts FROM messages
     WHERE chat_id = ? AND role = 'user' AND is_bot = 0 AND ts > ?
     ORDER BY ts ASC LIMIT 20`,
  )
    .bind(chatId, sinceTs)
    .all<{ user_name: string; content: string; ts: number }>();

  if (!rows.results || rows.results.length < MIN_MESSAGES_FOR_DIGEST) return;

  const messages = rows.results;
  const periodStart = messages[0].ts;
  const periodEnd = messages[messages.length - 1].ts;

  // Build context for LLM
  const chatLines = messages.map((m) => {
    const text = m.content.length > 100 ? m.content.slice(0, 100) + "…" : m.content;
    return `[${m.user_name}]: ${text}`;
  }).join("\n");

  const userIds = [...new Set(messages.map(m => m.user_name))].join(", ");

  const systemPrompt = `Ты помощник. Подведи КРАТКИЙ итог активности в групповом чате за недавний период.
Отвечай ТОЛЬКО на русском языке.
Формат: 1-2 предложения. Кратко, по делу. Не пиши "В чате обсуждалось..." — сразу суть.
Упомяни кто участвовал и о чём говорили. Если кто-то кидал статьи/новости которые никто не обсудил — отметь это.
Примеры:
- "Босс и Рус обсуждали диджейские сеты, Кама кидал стипендии но никто не отреагировал"
- "Рус спрашивал про саше для шкафа, Амоня ответил невпопад, Кама помог"
- "тишина, только Кама кидал новости из мира ИИ"`;

  const llmMessages: LLMMessage[] = [
    { role: "user", content: `Сообщения в чате:\n${chatLines}\n\nУчастники: ${userIds}` },
  ];

  const summary = await callLLMLight(env, llmMessages, systemPrompt, 100, 0.3);

  if (!summary || summary.length < 10 || summary.length > 200) return;

  // Store digest
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO digests (chat_id, summary, user_ids, msg_count, period_start, period_end, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    chatId,
    summary.trim(),
    JSON.stringify([...new Set(messages.map(m => m.user_name))]),
    messages.length,
    periodStart,
    periodEnd,
    now,
  ).run();

  // Prune old digests (keep last N)
  await env.DB.prepare(
    `DELETE FROM digests WHERE chat_id = ? AND id NOT IN (
       SELECT id FROM digests WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?
     )`,
  ).bind(chatId, chatId, MAX_DIGESTS_PER_CHAT).run();
}

// Load recent digests for inclusion in context/prompt
export async function loadRecentDigests(
  env: Env,
  chatId: number,
  limit: number = 3,
): Promise<StoredDigest[]> {
  const cutoff = Date.now() - DIGEST_MAX_AGE_MS;

  const rows = await env.DB.prepare(
    `SELECT summary, created_at, period_start, period_end FROM digests
     WHERE chat_id = ? AND created_at > ?
     ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(chatId, cutoff, limit)
    .all<{ summary: string; created_at: number; period_start: number; period_end: number }>();

  return (rows.results || []).map((r) => ({
    summary: r.summary,
    createdAt: r.created_at,
    periodStart: r.period_start,
    periodEnd: r.period_end,
  }));
}

// Format digests for prompt inclusion
export function formatDigestsForPrompt(digests: StoredDigest[]): string | null {
  if (digests.length === 0) return null;

  const lines = digests
    .reverse() // chronological order (oldest first)
    .map((d) => {
      const ago = formatRelativeTime(d.periodEnd);
      return `- ~${ago}: ${d.summary}`;
    });

  return `ЧТО ПРОИСХОДИЛО РАНЬШЕ:\n${lines.join("\n")}`;
}

// Prune digests older than 48h (called by cron)
export async function pruneOldDigests(env: Env): Promise<void> {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  await env.DB.prepare(`DELETE FROM digests WHERE created_at < ?`).bind(cutoff).run();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const minutes = Math.floor(diffMs / 60000);

  if (minutes < 5) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;

  const hours = Math.floor(minutes / 60);

  // Use Almaty time for "вчера вечером" style labels
  const almatyHour = (new Date(ts).getUTCHours() + 5) % 24;
  const almatyNowHour = (new Date().getUTCHours() + 5) % 24;
  const isYesterday = hours > 12 || (almatyNowHour < almatyHour && hours > 6);

  if (isYesterday) {
    if (almatyHour >= 0 && almatyHour < 6) return "вчера ночью";
    if (almatyHour < 12) return "вчера утром";
    if (almatyHour < 18) return "вчера днём";
    return "вчера вечером";
  }

  if (hours < 2) return `${hours}ч назад`;
  if (hours < 6) return `${hours}ч назад`;

  const days = Math.floor(hours / 24);
  if (days < 1) return `${hours}ч назад`;
  return `${days}д назад`;
}
