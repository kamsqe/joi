// ─── Reminder System ─────────────────────────────────────────────────────────

import type { Env, Reminder } from "./config";

const REMINDER_TTL = 60 * 60 * 24 * 365; // 1 year max

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

  // Store the reminder
  await env.KV.put(`rem:${id}`, JSON.stringify(reminder), {
    expirationTtl: REMINDER_TTL,
  });

  // Add to chat index
  await addToIndex(env, chatId, id);

  return reminder;
}

// ─── Get Reminders for Chat ──────────────────────────────────────────────────

export async function getChatReminders(env: Env, chatId: number): Promise<Reminder[]> {
  const ids = await getIndex(env, chatId);
  const reminders: Reminder[] = [];

  for (const id of ids) {
    const raw = await env.KV.get(`rem:${id}`);
    if (raw) {
      reminders.push(JSON.parse(raw) as Reminder);
    }
  }

  return reminders;
}

// ─── Get Due Reminders (across all chats) ────────────────────────────────────

export async function getDueReminders(env: Env, chatIds: number[]): Promise<Reminder[]> {
  const now = Date.now();
  const due: Reminder[] = [];

  for (const chatId of chatIds) {
    const reminders = await getChatReminders(env, chatId);
    for (const r of reminders) {
      if (r.remindAt <= now && (!r.lastReminded || now - r.lastReminded > 60000)) {
        due.push(r);
      }
    }
  }

  return due;
}

// ─── Mark Reminded & Handle Recurrence ───────────────────────────────────────

export async function processReminder(env: Env, reminder: Reminder): Promise<void> {
  if (reminder.recurrence === "once") {
    // Delete one-time reminder
    await env.KV.delete(`rem:${reminder.id}`);
    await removeFromIndex(env, reminder.chatId, reminder.id);
    return;
  }

  // Reschedule recurring reminder
  const nextTime = getNextOccurrence(reminder.remindAt, reminder.recurrence!);
  reminder.remindAt = nextTime;
  reminder.lastReminded = Date.now();

  await env.KV.put(`rem:${reminder.id}`, JSON.stringify(reminder), {
    expirationTtl: REMINDER_TTL,
  });
}

// ─── Delete Reminder ─────────────────────────────────────────────────────────

export async function deleteReminder(env: Env, chatId: number, reminderId: string): Promise<boolean> {
  const raw = await env.KV.get(`rem:${reminderId}`);
  if (!raw) return false;

  await env.KV.delete(`rem:${reminderId}`);
  await removeFromIndex(env, chatId, reminderId);
  return true;
}

// ─── Find Reminder by Description (fuzzy) ────────────────────────────────────

export async function findReminderByDescription(
  env: Env,
  chatId: number,
  searchText: string,
): Promise<Reminder | null> {
  const reminders = await getChatReminders(env, chatId);
  const lower = searchText.toLowerCase();

  // Simple substring match
  for (const r of reminders) {
    if (r.description.toLowerCase().includes(lower) || lower.includes(r.description.toLowerCase())) {
      return r;
    }
  }

  return null;
}

// ─── Chat Index Management ───────────────────────────────────────────────────

async function getIndex(env: Env, chatId: number): Promise<string[]> {
  try {
    const raw = await env.KV.get(`rem_idx:${chatId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function addToIndex(env: Env, chatId: number, reminderId: string): Promise<void> {
  const ids = await getIndex(env, chatId);
  if (!ids.includes(reminderId)) {
    ids.push(reminderId);
    await env.KV.put(`rem_idx:${chatId}`, JSON.stringify(ids), {
      expirationTtl: 60 * 60 * 24 * 90,
    });
  }
}

async function removeFromIndex(env: Env, chatId: number, reminderId: string): Promise<void> {
  const ids = await getIndex(env, chatId);
  const filtered = ids.filter((id) => id !== reminderId);
  await env.KV.put(`rem_idx:${chatId}`, JSON.stringify(filtered), {
    expirationTtl: 60 * 60 * 24 * 90,
  });
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
