// ─── Mood Engine (D1-backed) ─────────────────────────────────────────────────

import type { Env, MoodState, MoodData } from "./config";

// ─── All Possible Moods ──────────────────────────────────────────────────────

const ALL_MOODS: MoodState[] = [
  "happy", "playful", "chill", "flirty",
  "annoyed", "offended", "mean", "serious",
  "unhinged", "manic",
];

// Positive moods — more likely to swing TO when things are good
const POSITIVE_MOODS: MoodState[] = ["happy", "playful", "chill", "flirty", "manic"];

// Negative moods — more likely when things are bad
const NEGATIVE_MOODS: MoodState[] = ["annoyed", "mean", "serious", "unhinged"];

// Mood transition weights: which moods naturally flow into which
const MOOD_TRANSITIONS: Record<MoodState, { mood: MoodState; weight: number }[]> = {
  happy:    [{ mood: "playful", weight: 3 }, { mood: "chill", weight: 2 }, { mood: "flirty", weight: 2 }, { mood: "manic", weight: 1 }, { mood: "serious", weight: 1 }],
  playful:  [{ mood: "happy", weight: 2 }, { mood: "flirty", weight: 2 }, { mood: "manic", weight: 2 }, { mood: "unhinged", weight: 1 }, { mood: "chill", weight: 1 }],
  chill:    [{ mood: "happy", weight: 2 }, { mood: "playful", weight: 2 }, { mood: "serious", weight: 2 }, { mood: "flirty", weight: 1 }],
  flirty:   [{ mood: "playful", weight: 3 }, { mood: "happy", weight: 2 }, { mood: "chill", weight: 1 }, { mood: "unhinged", weight: 1 }],
  annoyed:  [{ mood: "mean", weight: 3 }, { mood: "offended", weight: 2 }, { mood: "serious", weight: 2 }, { mood: "chill", weight: 1 }],
  offended: [{ mood: "mean", weight: 3 }, { mood: "annoyed", weight: 2 }, { mood: "serious", weight: 2 }, { mood: "chill", weight: 1 }],
  mean:     [{ mood: "annoyed", weight: 2 }, { mood: "offended", weight: 2 }, { mood: "serious", weight: 2 }, { mood: "unhinged", weight: 1 }, { mood: "chill", weight: 1 }],
  serious:  [{ mood: "chill", weight: 3 }, { mood: "annoyed", weight: 1 }, { mood: "happy", weight: 1 }, { mood: "mean", weight: 1 }],
  unhinged: [{ mood: "manic", weight: 3 }, { mood: "playful", weight: 2 }, { mood: "mean", weight: 1 }, { mood: "happy", weight: 1 }],
  manic:    [{ mood: "unhinged", weight: 2 }, { mood: "playful", weight: 2 }, { mood: "happy", weight: 2 }, { mood: "annoyed", weight: 1 }],
};

// ─── In-Memory TTL Cache ─────────────────────────────────────────────────────

interface MoodCacheEntry {
  data: MoodData;
  expiresAt: number;
}

const moodCache = new Map<number, MoodCacheEntry>();
const MOOD_CACHE_TTL_MS = 30_000; // 30 seconds

function cloneMood(m: MoodData): MoodData {
  return { ...m };
}

// ─── Load / Save ─────────────────────────────────────────────────────────────

export async function getMood(env: Env, chatId: number): Promise<MoodData> {
  // Check cache first
  const cached = moodCache.get(chatId);
  if (cached && Date.now() < cached.expiresAt) {
    return cloneMood(cached.data);
  }

  const row = await env.DB.prepare(
    `SELECT * FROM mood WHERE chat_id = ?`,
  )
    .bind(chatId)
    .first<{
      chat_id: number; mood: string; intensity: number; volatility: number;
      last_change: number; offended_by: number | null; offense_reason: string | null;
      cool_period_until: number | null;
    }>();

  if (!row) return defaultMood();

  const mood: MoodData = {
    mood: row.mood as MoodState,
    intensity: row.intensity,
    volatility: row.volatility,
    lastChange: row.last_change,
    offendedBy: row.offended_by || undefined,
    offenseReason: row.offense_reason || undefined,
    coolPeriodUntil: row.cool_period_until || undefined,
  };

  // Populate cache
  moodCache.set(chatId, { data: cloneMood(mood), expiresAt: Date.now() + MOOD_CACHE_TTL_MS });
  return mood;
}

export async function saveMood(env: Env, chatId: number, mood: MoodData): Promise<void> {
  // Write-through: update cache immediately
  moodCache.set(chatId, { data: cloneMood(mood), expiresAt: Date.now() + MOOD_CACHE_TTL_MS });

  await env.DB.prepare(
    `INSERT INTO mood (chat_id, mood, intensity, volatility, last_change, offended_by, offense_reason, cool_period_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       mood = excluded.mood, intensity = excluded.intensity, volatility = excluded.volatility,
       last_change = excluded.last_change, offended_by = excluded.offended_by,
       offense_reason = excluded.offense_reason, cool_period_until = excluded.cool_period_until`,
  )
    .bind(
      chatId, mood.mood, mood.intensity, mood.volatility, mood.lastChange,
      mood.offendedBy || null, mood.offenseReason || null, mood.coolPeriodUntil || null,
    )
    .run();
}

function defaultMood(): MoodData {
  return {
    mood: "chill",
    intensity: 50,
    volatility: 0.4,
    lastChange: Date.now(),
  };
}

// ─── Maybe Swing Mood (on message receipt) ───────────────────────────────────

export async function maybeSwingMood(env: Env, chatId: number): Promise<MoodData> {
  const mood = await getMood(env, chatId);

  const swingChance = getSwingChance(mood.volatility);
  const roll = Math.random();

  if (roll < swingChance) {
    const newMood = pickWeightedTransition(mood.mood);
    const newIntensity = 30 + Math.floor(Math.random() * 50);

    mood.mood = newMood;
    mood.intensity = newIntensity;
    mood.lastChange = Date.now();

    await saveMood(env, chatId, mood);
  }

  return mood;
}

// ─── Swing Chance Based on Volatility ────────────────────────────────────────

function getSwingChance(volatility: number): number {
  if (volatility < 0.3) return 0.03 + volatility * 0.067;
  if (volatility < 0.7) return 0.08 + (volatility - 0.3) * 0.1;
  return 0.15 + (volatility - 0.7) * 0.167;
}

// ─── Weighted Random Transition ──────────────────────────────────────────────

function pickWeightedTransition(currentMood: MoodState): MoodState {
  const transitions = MOOD_TRANSITIONS[currentMood];
  const totalWeight = transitions.reduce((sum, t) => sum + t.weight, 0);
  let roll = Math.random() * totalWeight;

  for (const t of transitions) {
    roll -= t.weight;
    if (roll <= 0) return t.mood;
  }

  return transitions[0].mood;
}

// ─── Shift Mood by Sentiment ─────────────────────────────────────────────────

export async function shiftMoodBySentiment(
  env: Env,
  chatId: number,
  sentiment: "positive" | "negative" | "neutral",
): Promise<MoodData> {
  const mood = await getMood(env, chatId);

  if (sentiment === "positive") {
    if (NEGATIVE_MOODS.includes(mood.mood)) {
      if (Math.random() < 0.4) {
        mood.mood = POSITIVE_MOODS[Math.floor(Math.random() * POSITIVE_MOODS.length)];
        mood.intensity = 40 + Math.floor(Math.random() * 30);
        mood.lastChange = Date.now();
      } else {
        mood.intensity = Math.max(10, mood.intensity - 15);
      }
    } else {
      mood.intensity = Math.min(100, mood.intensity + 10);
    }
  } else if (sentiment === "negative") {
    if (POSITIVE_MOODS.includes(mood.mood)) {
      if (Math.random() < 0.5) {
        mood.mood = NEGATIVE_MOODS[Math.floor(Math.random() * NEGATIVE_MOODS.length)];
        mood.intensity = 50 + Math.floor(Math.random() * 30);
        mood.lastChange = Date.now();
      } else {
        mood.intensity = Math.max(10, mood.intensity - 20);
      }
    } else {
      mood.intensity = Math.min(100, mood.intensity + 15);
    }
  }

  await saveMood(env, chatId, mood);
  return mood;
}

// ─── Set Offended State ──────────────────────────────────────────────────────

export async function setOffended(
  env: Env,
  chatId: number,
  offenderId: number,
  reason: string,
): Promise<MoodData> {
  const mood = await getMood(env, chatId);

  mood.mood = "offended";
  mood.intensity = 80 + Math.floor(Math.random() * 20);
  mood.offendedBy = offenderId;
  mood.offenseReason = reason;
  mood.coolPeriodUntil = Date.now() + (2 + Math.random() * 2) * 60 * 60 * 1000;
  mood.lastChange = Date.now();

  await saveMood(env, chatId, mood);
  return mood;
}

// ─── Clear Offense (on apology) ──────────────────────────────────────────────

export async function clearOffense(env: Env, chatId: number): Promise<MoodData> {
  const mood = await getMood(env, chatId);

  mood.mood = "chill";
  mood.intensity = 40;
  mood.offendedBy = undefined;
  mood.offenseReason = undefined;
  mood.coolPeriodUntil = undefined;
  mood.lastChange = Date.now();

  await saveMood(env, chatId, mood);
  return mood;
}

// ─── Check if Cool Period Active ─────────────────────────────────────────────

export function isInCoolPeriod(mood: MoodData): boolean {
  if (!mood.coolPeriodUntil) return false;
  if (Date.now() > mood.coolPeriodUntil) return false;
  return mood.mood === "offended";
}

// ─── Drift Volatility (called by cron) ───────────────────────────────────────

export async function driftVolatility(env: Env, chatId: number): Promise<void> {
  const mood = await getMood(env, chatId);

  const target = 0.4;
  const pull = (target - mood.volatility) * 0.15;
  const noise = (Math.random() - 0.5) * 0.06;
  mood.volatility = Math.max(0.05, Math.min(1, mood.volatility + pull + noise));

  if (mood.coolPeriodUntil && Date.now() > mood.coolPeriodUntil) {
    mood.mood = "annoyed";
    mood.intensity = 40;
    mood.coolPeriodUntil = undefined;
    mood.lastChange = Date.now();
  }

  await saveMood(env, chatId, mood);
}

// ─── Cron: Random Mood Shift ─────────────────────────────────────────────────

export async function cronMoodShift(env: Env, chatId: number): Promise<void> {
  const mood = await getMood(env, chatId);

  if (isInCoolPeriod(mood)) {
    await driftVolatility(env, chatId);
    return;
  }

  if (Math.random() < 0.2) {
    const newMood = pickWeightedTransition(mood.mood);
    mood.mood = newMood;
    mood.intensity = 30 + Math.floor(Math.random() * 40);
    mood.lastChange = Date.now();
  }

  const target = 0.4;
  const pull = (target - mood.volatility) * 0.15;
  const noise = (Math.random() - 0.5) * 0.06;
  mood.volatility = Math.max(0.05, Math.min(1, mood.volatility + pull + noise));

  await saveMood(env, chatId, mood);
}
