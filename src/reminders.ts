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

export function parseRelativeTime(whenStr: string): number | null {
  if (!whenStr || whenStr.trim().length === 0) return null;

  const lower = whenStr.toLowerCase().trim();
  const now = new Date();

  // Common patterns
  if (lower === "завтра" || lower === "tomorrow") {
    now.setDate(now.getDate() + 1);
    now.setHours(10, 0, 0, 0);
    return now.getTime();
  }

  if (lower === "послезавтра") {
    now.setDate(now.getDate() + 2);
    now.setHours(10, 0, 0, 0);
    return now.getTime();
  }

  // Days of week
  const days: Record<string, number> = {
    "понедельник": 1, "вторник": 2, "среда": 3, "среду": 3,
    "четверг": 4, "пятница": 5, "пятницу": 5,
    "суббота": 6, "субботу": 6, "воскресенье": 0,
  };

  for (const [name, dayNum] of Object.entries(days)) {
    if (lower.includes(name)) {
      const currentDay = now.getDay();
      let daysUntil = dayNum - currentDay;
      if (daysUntil <= 0) daysUntil += 7;
      now.setDate(now.getDate() + daysUntil);
      now.setHours(10, 0, 0, 0);
      return now.getTime();
    }
  }

  // "через N минут/часов/дней"
  const inMatch = lower.match(/через\s+(\d+)\s+(минут|час|дн|день|дней)/);
  if (inMatch) {
    const num = parseInt(inMatch[1], 10);
    const unit = inMatch[2];
    if (unit.startsWith("минут")) return Date.now() + num * 60 * 1000;
    if (unit.startsWith("час")) return Date.now() + num * 60 * 60 * 1000;
    if (unit.startsWith("дн") || unit.startsWith("день")) {
      now.setDate(now.getDate() + num);
      now.setHours(10, 0, 0, 0);
      return now.getTime();
    }
  }

  return null;
}
