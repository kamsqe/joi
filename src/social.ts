// ─── Social Intelligence — Group Dynamics & Chat Mood ────────────────────────
// SQL-based extraction of social graph from the messages table. Tracks:
//   - Reply-edges: who replies to whom, aggregated bidirectionally as "pairs"
//   - Chat mood: aggregate of recent emotional events (warmth vs tension)
//
// Used in VIP group prompts (both active and proactive) to give Joi awareness
// of who's close, who's clashing, and the overall temperature of the chat.

import type { Env } from "./config";

// ─── Social Graph ────────────────────────────────────────────────────────────

export interface SocialEdge {
  fromUserId: number;
  toUserId: number;
  fromName: string;
  toName: string;
  count: number;
}

export interface SocialPair {
  users: [string, string];     // display names
  userIds: [number, number];   // sorted ascending for dedup
  total: number;               // sum of both directions
  imbalance: number;           // |a→b - b→a| / total (0 = mutual, 1 = one-sided)
}

/**
 * Fetches top reply-edges in a chat for the given window. Joins the messages
 * table on reply_to_message_id to resolve reply targets. Only counts
 * human-to-human replies (bots excluded).
 */
export async function buildSocialGraph(
  env: Env,
  chatId: number,
  windowDays: number = 7,
): Promise<SocialEdge[]> {
  const cutoff = Date.now() - windowDays * 86_400_000;

  const rows = await env.DB.prepare(
    `SELECT
       m.user_id   AS from_id,
       m.user_name AS from_name,
       orig.user_id   AS to_id,
       orig.user_name AS to_name,
       COUNT(*) AS cnt
     FROM messages m
     JOIN messages orig
       ON orig.chat_id = m.chat_id
      AND orig.message_id = m.reply_to_message_id
     WHERE m.chat_id = ?
       AND m.reply_to_message_id IS NOT NULL
       AND m.is_bot = 0
       AND orig.is_bot = 0
       AND m.user_id != orig.user_id
       AND m.user_id IS NOT NULL
       AND orig.user_id IS NOT NULL
       AND m.ts > ?
     GROUP BY m.user_id, orig.user_id
     HAVING cnt >= 3
     ORDER BY cnt DESC
     LIMIT 20`,
  )
    .bind(chatId, cutoff)
    .all<{
      from_id: number; from_name: string;
      to_id: number; to_name: string;
      cnt: number;
    }>();

  return (rows.results || []).map((r) => ({
    fromUserId: r.from_id,
    toUserId: r.to_id,
    fromName: r.from_name || "?",
    toName: r.to_name || "?",
    count: r.cnt,
  }));
}

/**
 * Folds directed edges into bidirectional pairs so we can say "A и B часто
 * переписываются" without double-counting. Tracks imbalance (if one side
 * replies 10x and the other 1x, that's a one-sided dynamic).
 */
export function aggregatePairs(edges: SocialEdge[]): SocialPair[] {
  const pairMap = new Map<string, SocialPair>();

  for (const edge of edges) {
    const [lo, hi] = edge.fromUserId < edge.toUserId
      ? [edge.fromUserId, edge.toUserId]
      : [edge.toUserId, edge.fromUserId];
    const key = `${lo}-${hi}`;

    const existing = pairMap.get(key);
    if (existing) {
      const fromLoSide = edge.fromUserId === lo ? edge.count : 0;
      const fromHiSide = edge.fromUserId === hi ? edge.count : 0;
      const total = existing.total + edge.count;
      // Recompute imbalance across both directions
      const aToB = (existing.imbalance >= 0 ? existing.total : 0) + fromLoSide;
      const bToA = fromHiSide;
      existing.total = total;
      existing.imbalance = total > 0 ? Math.abs(aToB - bToA) / total : 0;
    } else {
      const [n1, n2] = edge.fromUserId === lo
        ? [edge.fromName, edge.toName]
        : [edge.toName, edge.fromName];
      pairMap.set(key, {
        users: [n1, n2],
        userIds: [lo, hi],
        total: edge.count,
        imbalance: 1, // only one direction seen so far → fully one-sided
      });
    }
  }

  return [...pairMap.values()].sort((a, b) => b.total - a.total);
}

/**
 * Formats the top social pairs as a prompt block. Labels heavy + balanced
 * pairs as "close", heavy + one-sided pairs as "one-sided" (useful signal:
 * one person chasing attention).
 */
export function formatSocialGraph(edges: SocialEdge[]): string {
  if (edges.length === 0) return "";

  const pairs = aggregatePairs(edges).slice(0, 5);
  if (pairs.length === 0) return "";

  const lines = pairs.map((p) => {
    const dynamic = p.imbalance < 0.3
      ? "общаются на равных"
      : p.imbalance < 0.6
      ? "общаются, но один активнее"
      : `${p.users[0]} чаще инициирует`;
    return `- ${p.users[0]} ↔ ${p.users[1]}: ${p.total} реплаев за неделю (${dynamic})`;
  });

  return `СОЦИАЛЬНАЯ ДИНАМИКА В ЧАТЕ (реплаи за последние 7 дней):
${lines.join("\n")}

Это просто контекст — не обязательно упоминать напрямую. Помогает тебе понимать кто с кем близок и как они общаются.`;
}

// ─── Chat Mood (Aggregate Emotional Weather) ─────────────────────────────────

export interface ChatMoodSignal {
  level: "warm" | "neutral" | "tense" | "mixed";
  positiveCount: number;
  negativeCount: number;
  totalEvents: number;
}

/**
 * Aggregates recent emotional_events in a chat to estimate overall temperature.
 * Returns null if there's no data (fresh chat or quiet period).
 */
export async function computeChatMood(
  env: Env,
  chatId: number,
  windowHours: number = 48,
): Promise<ChatMoodSignal | null> {
  const cutoff = Date.now() - windowHours * 3_600_000;

  const rows = await env.DB.prepare(
    `SELECT event_type, valence, COUNT(*) as cnt
     FROM emotional_events
     WHERE chat_id = ? AND ts > ?
     GROUP BY event_type, SIGN(valence)`,
  )
    .bind(chatId, cutoff)
    .all<{ event_type: string; valence: number; cnt: number }>();

  if (!rows.results || rows.results.length === 0) return null;

  let positiveCount = 0;
  let negativeCount = 0;
  for (const r of rows.results) {
    if (r.valence > 0) positiveCount += r.cnt;
    else if (r.valence < 0) negativeCount += r.cnt;
  }

  const totalEvents = positiveCount + negativeCount;
  if (totalEvents < 2) return null; // too sparse to say anything

  let level: ChatMoodSignal["level"];
  if (negativeCount >= 2 && positiveCount >= 2) {
    level = "mixed";
  } else if (negativeCount > positiveCount * 2) {
    level = "tense";
  } else if (positiveCount > negativeCount * 2) {
    level = "warm";
  } else {
    level = "neutral";
  }

  return { level, positiveCount, negativeCount, totalEvents };
}

/**
 * Formats chat mood signal as a prompt block. Returns empty string if null.
 */
export function formatChatMood(signal: ChatMoodSignal | null): string {
  if (!signal) return "";

  switch (signal.level) {
    case "warm":
      return `ЭНЕРГИЯ ЧАТА: тёплая (${signal.positiveCount} позитивных моментов за 48ч). Люди в хорошем настроении, шутят, делятся.`;
    case "tense":
      return `ЭНЕРГИЯ ЧАТА: напряжённая (${signal.negativeCount} тяжёлых моментов за 48ч). Будь внимательнее, не подливай масла, не шути жёстко.`;
    case "mixed":
      return `ЭНЕРГИЯ ЧАТА: смешанная (${signal.positiveCount} позитива, ${signal.negativeCount} негатива за 48ч). Читай момент — некоторым хорошо, другим тяжело.`;
    case "neutral":
      return ""; // no signal — skip
  }
}
