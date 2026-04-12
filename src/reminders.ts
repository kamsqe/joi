// ─── Reminder System (D1-backed) ─────────────────────────────────────────────

import type { Env, Reminder } from "./config";

// ─── Create Reminder ─────────────────────────────────────────────────────────

export async function createReminder(
  env: Env,
  chatId: number,
  userId: number,
  description: string,
  remindAt: number,
  recurrence?: "once" | "daily" | "weekly" | "monthly" | "yearly",
): Promise<Reminder> {
  const id = `rem_${chatId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const reminder: Reminder = {
    id,
    chatId,
    userId,
    description,
    remindAt,
    recurrence: recurrence || "once",
    createdAt: Date.now(),
  };

  await env.DB.prepare(
    `INSERT INTO reminders (id, chat_id, user_id, description, remind_at, recurrence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, chatId, userId, description, remindAt, reminder.recurrence, reminder.createdAt)
    .run();

  return reminder;
}

// ─── Get Reminders for Chat ──────────────────────────────────────────────────

export async function getChatReminders(env: Env, chatId: number): Promise<Reminder[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM reminders WHERE chat_id = ?`,
  )
    .bind(chatId)
    .all<{
      id: string; chat_id: number; user_id: number; description: string;
      remind_at: number; recurrence: string; created_at: number; last_reminded: number | null;
    }>();

  return (rows.results || []).map(rowToReminder);
}

// ─── Get Due Reminders (across all chats) ────────────────────────────────────

export async function getDueReminders(env: Env): Promise<Reminder[]> {
  const now = Date.now();

  const rows = await env.DB.prepare(
    `SELECT * FROM reminders WHERE remind_at <= ? AND (last_reminded IS NULL OR ? - last_reminded > 60000)`,
  )
    .bind(now, now)
    .all<{
      id: string; chat_id: number; user_id: number; description: string;
      remind_at: number; recurrence: string; created_at: number; last_reminded: number | null;
    }>();

  return (rows.results || []).map(rowToReminder);
}

// ─── Mark Reminded & Handle Recurrence ───────────────────────────────────────

export async function processReminder(env: Env, reminder: Reminder): Promise<void> {
  if (reminder.recurrence === "once") {
    await env.DB.prepare(`DELETE FROM reminders WHERE id = ?`).bind(reminder.id).run();
    return;
  }

  // Reschedule recurring reminder
  const nextTime = getNextOccurrence(reminder.remindAt, reminder.recurrence!);
  await env.DB.prepare(
    `UPDATE reminders SET remind_at = ?, last_reminded = ? WHERE id = ?`,
  )
    .bind(nextTime, Date.now(), reminder.id)
    .run();
}

// ─── Delete Reminder ─────────────────────────────────────────────────────────

export async function deleteReminder(env: Env, _chatId: number, reminderId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `DELETE FROM reminders WHERE id = ?`,
  )
    .bind(reminderId)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

// ─── Find Reminder by Description (fuzzy) ────────────────────────────────────

export async function findReminderByDescription(
  env: Env,
  chatId: number,
  searchText: string,
): Promise<Reminder | null> {
  // Try SQL LIKE first
  const row = await env.DB.prepare(
    `SELECT * FROM reminders WHERE chat_id = ? AND description LIKE ? LIMIT 1`,
  )
    .bind(chatId, `%${searchText}%`)
    .first<{
      id: string; chat_id: number; user_id: number; description: string;
      remind_at: number; recurrence: string; created_at: number; last_reminded: number | null;
    }>();

  if (row) return rowToReminder(row);

  // Fallback: reverse match (search text contains description)
  const all = await getChatReminders(env, chatId);
  const lower = searchText.toLowerCase();
  for (const r of all) {
    if (lower.includes(r.description.toLowerCase())) return r;
  }

  return null;
}

// ─── Row → Reminder Mapper ───────────────────────────────────────────────────

function rowToReminder(row: {
  id: string; chat_id: number; user_id: number; description: string;
  remind_at: number; recurrence: string; created_at: number; last_reminded: number | null;
}): Reminder {
  return {
    id: row.id,
    chatId: row.chat_id,
    userId: row.user_id,
    description: row.description,
    remindAt: row.remind_at,
    recurrence: row.recurrence as Reminder["recurrence"],
    createdAt: row.created_at,
    lastReminded: row.last_reminded || undefined,
  };
}

// ─── Calculate Next Occurrence ───────────────────────────────────────────────

function getNextOccurrence(
  current: number,
  recurrence: "daily" | "weekly" | "monthly" | "yearly",
): number {
  const date = new Date(current);

  switch (recurrence) {
    case "daily":
      date.setDate(date.getDate() + 1);
      break;
    case "weekly":
      date.setDate(date.getDate() + 7);
      break;
    case "monthly":
      date.setMonth(date.getMonth() + 1);
      break;
    case "yearly":
      date.setFullYear(date.getFullYear() + 1);
      break;
  }

  return date.getTime();
}

// ─── Parse Time from Natural Language ────────────────────────────────────────

const MONTH_MAP: Record<string, number> = {
  "январ": 0, "феврал": 1, "март": 2, "марта": 2,
  "апрел": 3, "ма": 4, "мая": 4, "май": 4,
  "июн": 5, "июл": 6, "август": 7,
  "сентябр": 8, "октябр": 9, "ноябр": 10, "декабр": 11,
};

function parseMonthName(str: string): number | null {
  const lower = str.toLowerCase();
  for (const [prefix, month] of Object.entries(MONTH_MAP)) {
    if (lower.startsWith(prefix)) return month;
  }
  return null;
}

export function parseRelativeTime(whenStr: string, defaultHour: number = 14): number | null {
  if (!whenStr || whenStr.trim().length === 0) return null;

  const lower = whenStr.toLowerCase().trim();
  const now = new Date();
  // Work in Almaty time (UTC+5)
  const almatyOffset = 5 * 60;
  const localNow = new Date(now.getTime() + (almatyOffset + now.getTimezoneOffset()) * 60000);

  // ─── Absolute date: "DD month" or "DD.MM" ────────────────────────────
  // Pattern: "28 апреля", "19 мая", "25 мая в 14:00"
  const absMatch = lower.match(/(\d{1,2})\s+([а-яё]+)/);
  if (absMatch) {
    const day = parseInt(absMatch[1], 10);
    const month = parseMonthName(absMatch[2]);
    if (month !== null && day >= 1 && day <= 31) {
      // Extract optional time "в HH:MM" or "в HH"
      const timeMatch = lower.match(/в\s+(\d{1,2})(?::(\d{2}))?/);
      const hour = timeMatch ? parseInt(timeMatch[1], 10) : defaultHour;
      const minute = timeMatch && timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;

      let year = localNow.getFullYear();
      const target = new Date(year, month, day, hour, minute, 0, 0);
      // If the date is in the past, assume next year
      if (target.getTime() < localNow.getTime()) {
        year++;
        target.setFullYear(year);
      }
      // Convert Almaty time back to UTC
      return target.getTime() - almatyOffset * 60000;
    }
  }

  // Pattern: "DD.MM" or "DD.MM.YYYY"
  const dotMatch = lower.match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/);
  if (dotMatch) {
    const day = parseInt(dotMatch[1], 10);
    const month = parseInt(dotMatch[2], 10) - 1;
    let year = dotMatch[3] ? parseInt(dotMatch[3], 10) : localNow.getFullYear();
    if (year < 100) year += 2000;

    const timeMatch = lower.match(/в\s+(\d{1,2})(?::(\d{2}))?/);
    const hour = timeMatch ? parseInt(timeMatch[1], 10) : defaultHour;
    const minute = timeMatch && timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;

    const target = new Date(year, month, day, hour, minute, 0, 0);
    if (!dotMatch[3] && target.getTime() < localNow.getTime()) {
      target.setFullYear(target.getFullYear() + 1);
    }
    return target.getTime() - almatyOffset * 60000;
  }

  // ─── Relative: "завтра", "послезавтра" ────────────────────────────────
  if (lower === "завтра" || lower === "tomorrow") {
    const target = new Date(localNow);
    target.setDate(target.getDate() + 1);
    target.setHours(defaultHour, 0, 0, 0);
    return target.getTime() - almatyOffset * 60000;
  }

  if (lower === "послезавтра") {
    const target = new Date(localNow);
    target.setDate(target.getDate() + 2);
    target.setHours(defaultHour, 0, 0, 0);
    return target.getTime() - almatyOffset * 60000;
  }

  // ─── Days of week ─────────────────────────────────────────────────────
  const days: Record<string, number> = {
    "понедельник": 1, "вторник": 2, "среда": 3, "среду": 3,
    "четверг": 4, "пятница": 5, "пятницу": 5,
    "суббота": 6, "субботу": 6, "воскресенье": 0,
  };

  for (const [name, dayNum] of Object.entries(days)) {
    if (lower.includes(name)) {
      const currentDay = localNow.getDay();
      let daysUntil = dayNum - currentDay;
      if (daysUntil <= 0) daysUntil += 7;
      const target = new Date(localNow);
      target.setDate(target.getDate() + daysUntil);
      target.setHours(defaultHour, 0, 0, 0);
      return target.getTime() - almatyOffset * 60000;
    }
  }

  // ─── "через N минут/часов/дней" ───────────────────────────────────────
  const inMatch = lower.match(/через\s+(\d+)\s+(минут|час|дн|день|дней)/);
  if (inMatch) {
    const num = parseInt(inMatch[1], 10);
    const unit = inMatch[2];
    if (unit.startsWith("минут")) return Date.now() + num * 60 * 1000;
    if (unit.startsWith("час")) return Date.now() + num * 60 * 60 * 1000;
    if (unit.startsWith("дн") || unit.startsWith("день")) {
      const target = new Date(localNow);
      target.setDate(target.getDate() + num);
      target.setHours(defaultHour, 0, 0, 0);
      return target.getTime() - almatyOffset * 60000;
    }
  }

  return null;
}

// ─── Compute Offset Reminders ────────────────────────────────────────────────
// Given a target date, returns reminder timestamps for "week before, day before, day of"
export function computeReminderDates(targetTs: number): { label: string; ts: number }[] {
  const weekBefore = targetTs - 7 * 24 * 60 * 60 * 1000;
  const dayBefore = targetTs - 1 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const dates: { label: string; ts: number }[] = [];
  if (weekBefore > now) dates.push({ label: "за неделю", ts: weekBefore });
  if (dayBefore > now) dates.push({ label: "за день", ts: dayBefore });
  dates.push({ label: "в этот день", ts: targetTs });

  return dates;
}
