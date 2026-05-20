// ─── D1-Based Message Storage + Layered Context Builder ─────────────────────

import type { Env, BufferMessage, LLMMessage } from "./config";
import { AMONYA_USERNAME } from "./config";
import { buildActivityDigest, loadRecentDigests, formatDigestsForPrompt } from "./digests";

// ─── Save User Message ───────────────────────────────────────────────────────

export interface SaveMessageOptions {
  messageId?: number;
  isBot?: boolean;
  isForwarded?: boolean;
  forwardSource?: string | null;
  replyToMessageId?: number | null;
  threadId?: number | null;
  quoteText?: string | null;
}

export async function saveUserMessage(
  env: Env,
  chatId: number,
  userId: number,
  userName: string,
  text: string,
  options: SaveMessageOptions = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (chat_id, message_id, user_id, user_name, role, content, is_bot, is_forwarded, forward_source, reply_to_message_id, thread_id, quote_text, ts)
     VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      chatId,
      options.messageId || null,
      userId,
      userName,
      text,
      options.isBot ? 1 : 0,
      options.isForwarded ? 1 : 0,
      options.forwardSource || null,
      options.replyToMessageId || null,
      options.threadId || null,
      options.quoteText || null,
      Date.now(),
    )
    .run();
}

// ─── Save Bot Message ────────────────────────────────────────────────────────

export async function saveBotMessage(
  env: Env,
  chatId: number,
  text: string,
  messageId?: number,
  threadId?: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (chat_id, message_id, user_id, user_name, role, content, is_bot, is_forwarded, thread_id, ts)
     VALUES (?, ?, NULL, 'Джой', 'assistant', ?, 0, 0, ?, ?)`,
  )
    .bind(chatId, messageId || null, text, threadId || null, Date.now())
    .run();
}

// ─── Layered Context Builder ─────────────────────────────────────────────────
// Replaces the flat 60-message KV buffer with 4-layer D1 queries:
//   Layer 1 — Thread: reply chain walk
//   Layer 2 — Ambient: last N human-only messages
//   Layer 3 — Self: last M bot messages (don't repeat)
//   Layer 4 — Forwarded: summarized forwarded content

export async function buildContext(
  env: Env,
  chatId: number,
  replyToMessageId?: number | null,
  userId?: number | null,
  replyFallbackText?: string | null,
  threadId?: number | null,
): Promise<LLMMessage[]> {
  const messages: LLMMessage[] = [];

  // D1: For VIP forum topics — filter most layers by thread_id so Joi's context
  // stays within the current topic. Digests remain global (cross-topic awareness).
  // Private chats and regular groups pass threadId=null and get unfiltered behavior.
  const useTopicFilter = !!threadId;
  const topicFilter = useTopicFilter ? "AND thread_id = ?" : "";

  // ── Layer 1: Thread (walk reply chain) ────────────────────────────────────
  const threadMessages: { role: string; user_name: string; content: string; message_id: number; reply_to_message_id: number | null }[] = [];

  if (replyToMessageId) {
    let currentMsgId: number | null = replyToMessageId;
    let hops = 0;
    const MAX_HOPS = 10;

    while (currentMsgId && hops < MAX_HOPS) {
      type ThreadRow = { role: string; user_name: string; content: string; message_id: number; reply_to_message_id: number | null; is_forwarded: number; forward_source: string | null };
      const row: ThreadRow | null = await env.DB.prepare(
        `SELECT role, user_name, content, message_id, reply_to_message_id, is_forwarded, forward_source
         FROM messages WHERE chat_id = ? AND message_id = ? LIMIT 1`,
      )
        .bind(chatId, currentMsgId)
        .first<ThreadRow>();

      if (!row) break;

      threadMessages.unshift(row);
      currentMsgId = row.reply_to_message_id;
      hops++;
    }
  }

  // A4: If thread walker found nothing but we have a fallback text from the
  // Telegram payload (reply_to_message.text), inject it as a synthetic thread
  // message so Joi can see what the user was replying to.
  if (threadMessages.length === 0 && replyFallbackText && replyToMessageId) {
    messages.push({
      role: "user",
      content: `СООБЩЕНИЕ НА КОТОРОЕ ОТВЕЧАЮТ (не найдено в истории):\n${truncate(replyFallbackText, 500)}`,
    });
  }

  if (threadMessages.length > 0) {
    const threadContent = threadMessages
      .map((m) => {
        const name = m.role === "assistant" ? "Джой" : (m.user_name || "?");
        return `[${name}]: ${truncate(m.content, 400)}`;
      })
      .join("\n");

    messages.push({
      role: "user",
      content: `ТРЕД НА КОТОРЫЙ ТЫ ОТВЕЧАЕШЬ:\n${threadContent}`,
    });
  }

  // ── Layer 2: Ambient (recent messages, bots tagged, dead articles compressed) ──
  // Include up to 3 recent forwards alongside 18 organic messages.
  // D1: Filter by thread_id for VIP topic scoping.
  const ambientQuery = `SELECT user_name, content, is_bot, message_id, ts, user_id, reply_to_message_id, is_forwarded, forward_source FROM messages
     WHERE chat_id = ? AND role = 'user' AND is_forwarded = 0 ${topicFilter}
     ORDER BY ts DESC LIMIT 18`;
  const ambientStmt = useTopicFilter
    ? env.DB.prepare(ambientQuery).bind(chatId, threadId)
    : env.DB.prepare(ambientQuery).bind(chatId);
  const ambientRows = await ambientStmt.all<{ user_name: string; content: string; is_bot: number; message_id: number; ts: number; user_id: number; reply_to_message_id: number | null; is_forwarded: number; forward_source: string | null }>();

  // Also load recent forwards (capped at 3) so Joi can see shared content
  const forwardQuery = `SELECT user_name, content, is_bot, message_id, ts, user_id, reply_to_message_id, is_forwarded, forward_source FROM messages
     WHERE chat_id = ? AND role = 'user' AND is_forwarded = 1 ${topicFilter}
     ORDER BY ts DESC LIMIT 3`;
  const forwardStmt = useTopicFilter
    ? env.DB.prepare(forwardQuery).bind(chatId, threadId)
    : env.DB.prepare(forwardQuery).bind(chatId);
  const forwardRows = await forwardStmt.all<{ user_name: string; content: string; is_bot: number; message_id: number; ts: number; user_id: number; reply_to_message_id: number | null; is_forwarded: number; forward_source: string | null }>();

  // Merge and sort chronologically
  const allAmbient = [
    ...(ambientRows.results || []),
    ...(forwardRows.results || []),
  ].sort((a, b) => a.ts - b.ts);

  if (allAmbient.length > 0) {
    const ambientContent = allAmbient
      .map((m, i) => {
        // Forwarded messages — show source channel
        if (m.is_forwarded) {
          const source = m.forward_source ? ` от ${m.forward_source}` : "";
          return `[${m.user_name || "?"} переслал${source}]: ${truncate(m.content, 200)}`;
        }

        // Tag bot messages instead of filtering them
        const prefix = m.is_bot ? `[БОТ ${m.user_name || "?"}]` : `[${m.user_name || "?"}]`;

        // Engagement heuristic: compress long messages that nobody responded to.
        // A message counts as "engaged" if a subsequent message from a DIFFERENT user
        // is a reply to it, or appeared within 5 minutes of it.
        if (m.content.length > 200 && !m.is_bot) {
          const gotEngagement = allAmbient.some((other, j) =>
            j > i &&
            other.user_id !== m.user_id &&
            (other.reply_to_message_id === m.message_id ||
             (other.ts - m.ts < 300_000 && other.ts > m.ts))
          );

          if (!gotEngagement) {
            const topic = truncate(m.content, 60);
            return `[${m.user_name || "?"} кинул сообщение: "${topic}" — никто не обсудил]`;
          }
        }

        return `${prefix}: ${truncate(m.content, 300)}`;
      })
      .join("\n");

    messages.push({
      role: "user",
      content: `ПОСЛЕДНИЕ СООБЩЕНИЯ В ЧАТЕ:\n${ambientContent}`,
    });
  }

  // ── Layer 2b: Focus — recent messages from the addressing user ────────────
  // Ensures Joi has context about who she's actually talking to, even if their
  // messages are buried in group noise. Only adds if user has messages not
  // already in ambient.
  if (userId) {
    const focusQuery = `SELECT content FROM messages
       WHERE chat_id = ? AND user_id = ? AND role = 'user' AND is_bot = 0 AND is_forwarded = 0 ${topicFilter}
       ORDER BY ts DESC LIMIT 5`;
    const focusStmt = useTopicFilter
      ? env.DB.prepare(focusQuery).bind(chatId, userId, threadId)
      : env.DB.prepare(focusQuery).bind(chatId, userId);
    const focusRows = await focusStmt.all<{ content: string }>();

    if (focusRows.results && focusRows.results.length > 2) {
      // Only add if user has more than 2 recent messages (otherwise ambient covers it)
      const focusContent = focusRows.results
        .reverse()
        .map((m) => `- ${truncate(m.content, 200)}`)
        .join("\n");

      messages.push({
        role: "user",
        content: `ПОСЛЕДНИЕ СООБЩЕНИЯ ОТ ЭТОГО ЧЕЛОВЕКА:\n${focusContent}`,
      });
    }
  }

  // ── Layer 3: Self-awareness (last 5 bot messages) ─────────────────────────
  // D1: Filter by topic so dedup is topic-scoped (bot can reuse themes across topics)
  const selfQuery = `SELECT content FROM messages
     WHERE chat_id = ? AND role = 'assistant' ${topicFilter}
     ORDER BY ts DESC LIMIT 5`;
  const selfStmt = useTopicFilter
    ? env.DB.prepare(selfQuery).bind(chatId, threadId)
    : env.DB.prepare(selfQuery).bind(chatId);
  const selfRows = await selfStmt.all<{ content: string }>();

  if (selfRows.results && selfRows.results.length > 0) {
    const selfContent = selfRows.results
      .reverse()
      .map((m) => `- "${truncate(m.content, 150)}"`)
      .join("\n");

    messages.push({
      role: "user",
      content: `ТВОИ ПОСЛЕДНИЕ СООБЩЕНИЯ (не повторяйся):\n${selfContent}`,
    });
  }

  // ── Layer 4: Forwarded content awareness ──────────────────────────────────
  // D1: Filter by topic so forwarded articles from other topics don't bleed in
  const forwardedQuery = `SELECT user_name, forward_source, content FROM messages
     WHERE chat_id = ? AND is_forwarded = 1 ${topicFilter}
     ORDER BY ts DESC LIMIT 10`;
  const forwardedStmt = useTopicFilter
    ? env.DB.prepare(forwardedQuery).bind(chatId, threadId)
    : env.DB.prepare(forwardedQuery).bind(chatId);
  const forwardedRows = await forwardedStmt.all<{ user_name: string; forward_source: string | null; content: string }>();

  if (forwardedRows.results && forwardedRows.results.length > 0) {
    const forwardedContent = forwardedRows.results
      .reverse()
      .map((m) => {
        const source = m.forward_source ? ` от ${m.forward_source}` : "";
        return `- ${m.user_name || "?"} переслал${source}: "${truncate(m.content, 60)}"`;
      })
      .join("\n");

    messages.push({
      role: "user",
      content: `ЧТО ШАРИЛИ В ЧАТЕ:\n${forwardedContent}`,
    });
  }
  // ── Layer 5: Activity Digest (group-only, SQL aggregate — zero LLM cost) ──
  const isGroupChat = chatId < 0;
  if (isGroupChat) {
    const activityDigest = await buildActivityDigest(env, chatId);
    if (activityDigest) {
      messages.push({
        role: "user",
        content: activityDigest,
      });
    }
  }

  // ── Layer 6: Topic Digests (group-only, LLM-generated summaries) ───────────
  if (isGroupChat) {
    const digests = await loadRecentDigests(env, chatId, 3);
    const digestBlock = formatDigestsForPrompt(digests);
    if (digestBlock) {
      messages.push({
        role: "user",
        content: digestBlock,
      });
    }
  }

  return messages;
}

// ─── Private Chat Context Builder (session-aware, flat alternating turns) ────

interface MessageRow {
  role: string;
  user_name: string | null;
  content: string;
  ts: number;
}

interface Session {
  messages: MessageRow[];
  startTs: number;
  endTs: number;
}

export interface PrivateContextResult {
  messages: LLMMessage[];
  contextNote: string;
}

const SESSION_GAP_MS = 2 * 60 * 60 * 1000; // 2 hours = new session

export async function buildPrivateContext(
  env: Env,
  chatId: number,
  currentText: string,
): Promise<PrivateContextResult> {
  // Fetch last 30 messages (enough for 2-3 sessions)
  const rows = await env.DB.prepare(
    `SELECT role, user_name, content, ts FROM messages
     WHERE chat_id = ?
     ORDER BY ts DESC LIMIT 30`,
  )
    .bind(chatId)
    .all<MessageRow>();

  if (!rows.results || rows.results.length === 0) {
    return { messages: [], contextNote: "" };
  }

  const allMessages = rows.results.reverse(); // chronological order

  // Split into sessions (2hr gap threshold)
  const sessions = splitIntoSessions(allMessages, SESSION_GAP_MS);
  const currentSession = sessions[sessions.length - 1];
  const prevSession = sessions.length > 1 ? sessions[sessions.length - 2] : null;

  // ── Build context note ──────────────────────────────────────────────────
  const notes: string[] = [];

  // Previous session summary
  if (prevSession) {
    const gapMs = currentSession.startTs - prevSession.endTs;
    const gap = formatGap(gapMs);
    const lastBotMsg = prevSession.messages.filter(m => m.role === "assistant").pop();
    const hadUnansweredQ = lastBotMsg?.content.includes("?") ?? false;

    // Extract a brief topic summary from previous session
    const prevUserMsgs = prevSession.messages
      .filter(m => m.role === "user")
      .map(m => m.content)
      .slice(-3)
      .join(", ");
    const topicHint = prevUserMsgs ? truncate(prevUserMsgs, 80) : "общение";

    notes.push(`Предыдущий разговор (${gap} назад): ${topicHint}`);

    if (hadUnansweredQ) {
      notes.push(`Ты спросила "${truncate(lastBotMsg!.content, 60)}" — ответа не было`);
    }
  }

  // Time gap from last message in current session to now
  const lastMsgTs = currentSession.endTs;
  const sinceLastMsg = Date.now() - lastMsgTs;
  if (sinceLastMsg > 60 * 60 * 1000) { // > 1 hour
    notes.push(`Прошло ${formatGap(sinceLastMsg)} с последнего сообщения`);
  }

  // Energy hint based on user's average message length
  // (Time of day is handled by timeOfDayBlock in system prompt — no duplication)
  const recentUserLens = currentSession.messages
    .filter(m => m.role === "user")
    .slice(-5)
    .map(m => m.content.length);
  const avgLen = recentUserLens.length > 0
    ? recentUserLens.reduce((a, b) => a + b, 0) / recentUserLens.length
    : 30;

  if (isGreeting(currentText) && sinceLastMsg > 2 * 60 * 60 * 1000) {
    notes.push("Собеседник возвращается с приветствием — поздоровайся нормально, не задавай вопросы сразу");
  } else if (avgLen < 10) {
    notes.push("Собеседник пишет очень коротко — будь тоже краткой, 1-2 предложения");
  } else if (avgLen < 25) {
    notes.push("Собеседник пишет коротко — отвечай кратко, 1-3 предложения");
  } else if (avgLen > 100) {
    notes.push("Собеседник пишет развёрнуто — можешь ответить подробнее");
  }

  // ── Build flat alternating turns ──────────────────────────────────────────
  // Cap context to prevent bloating: 3 messages from previous session + 15 from current

  // If there's a previous session, include its tail (last 3 messages) with gap marker
  const llmMessages: LLMMessage[] = [];

  if (prevSession && prevSession.messages.length > 0) {
    const tail = prevSession.messages.slice(-3); // cap: 3 messages from previous session
    for (const m of tail) {
      llmMessages.push({
        role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
        content: m.role === "user" && m.user_name
          ? `[${m.user_name}]: ${truncate(m.content, 300)}`
          : truncate(m.content, 300),
      });
    }
    // Insert gap marker as a user message
    const gapMs = currentSession.startTs - prevSession.endTs;
    llmMessages.push({
      role: "user",
      content: `--- ${formatGap(gapMs)} тишина ---`,
    });
  }

  // Current session — cap at last 15 messages for context window efficiency
  const sessionMessages = currentSession.messages.slice(-15);
  for (const m of sessionMessages) {
    llmMessages.push({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: m.role === "user" && m.user_name
        ? `[${m.user_name}]: ${truncate(m.content, 500)}`
        : truncate(m.content, 500),
    });
  }

  const contextNote = notes.length > 0
    ? "\n\nСИТУАЦИЯ:\n" + notes.map(n => `• ${n}`).join("\n")
    : "";

  return { messages: llmMessages, contextNote };
}

// ─── Get Message Count (for buffer checks) ──────────────────────────────────

export async function getMessageCount(env: Env, chatId: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM messages WHERE chat_id = ?`,
  )
    .bind(chatId)
    .first<{ count: number }>();
  return row?.count || 0;
}

// ─── Get Last User Message Timestamp ─────────────────────────────────────────

export async function getLastUserMessageTs(env: Env, chatId: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT ts FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY ts DESC LIMIT 1`,
  )
    .bind(chatId)
    .first<{ ts: number }>();
  return row?.ts || 0;
}

// ─── Check if Amonya is Active in Recent Messages ───────────────────────────

export async function isAmonyaActive(env: Env, chatId: number, limit: number = 10): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM (
       SELECT user_name FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT ?
     ) WHERE user_name LIKE '%амоня%' OR user_name LIKE '%amonya%'`,
  )
    .bind(chatId, limit)
    .first<{ count: number }>();
  return (row?.count || 0) > 0;
}

// ─── Get Recent Bot Messages (for proactive dedup) ──────────────────────────

export async function getRecentBotMessages(env: Env, chatId: number, limit: number = 8, threadId?: number): Promise<string[]> {
  // When threadId is provided (VIP topic), only dedup within that topic so Joi
  // can reuse themes across different topics without sounding repetitive.
  const query = threadId
    ? `SELECT content FROM messages WHERE chat_id = ? AND role = 'assistant' AND thread_id = ? ORDER BY ts DESC LIMIT ?`
    : `SELECT content FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY ts DESC LIMIT ?`;

  const stmt = threadId
    ? env.DB.prepare(query).bind(chatId, threadId, limit)
    : env.DB.prepare(query).bind(chatId, limit);

  const rows = await stmt.all<{ content: string }>();

  return (rows.results || []).map((r) => r.content.slice(0, 100));
}

// ─── Prune Old Messages (called by cron) ─────────────────────────────────────

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function pruneOldMessages(env: Env): Promise<void> {
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  await env.DB.prepare(`DELETE FROM messages WHERE ts < ?`).bind(cutoff).run();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

function splitIntoSessions(messages: MessageRow[], gapMs: number): Session[] {
  if (messages.length === 0) return [];

  const sessions: Session[] = [];
  let current: MessageRow[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const gap = messages[i].ts - messages[i - 1].ts;
    if (gap > gapMs) {
      sessions.push({
        messages: current,
        startTs: current[0].ts,
        endTs: current[current.length - 1].ts,
      });
      current = [];
    }
    current.push(messages[i]);
  }

  sessions.push({
    messages: current,
    startTs: current[0].ts,
    endTs: current[current.length - 1].ts,
  });

  return sessions;
}

function formatGap(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}ч`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}д`;
  const weeks = Math.floor(days / 7);
  return `${weeks} нед`;
}

const GREETING_PATTERNS = /^(привет|привеет|хей|хай|здарова|прив|хеллоу?|ку|йоу|доброе утро|добрый (вечер|день)|hi|hey|hello|yo)[\s!.)]*$/i;

function isGreeting(text: string): boolean {
  // Strip bot name variants first
  const cleaned = text.replace(/(джой|жой|joi|@\w+)/gi, "").trim();
  return GREETING_PATTERNS.test(cleaned);
}
