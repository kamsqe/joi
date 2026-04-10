// ─── Mood Engine ─────────────────────────────────────────────────────────────

import type { Env, MoodState, MoodData } from "./config";

const MOOD_TTL = 60 * 60 * 24 * 7; // 7 days

function moodKey(chatId: number): string {
  return `mood:${chatId}`;
}

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
// Key = current mood, value = weighted pool of next moods
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

// ─── Load / Save ─────────────────────────────────────────────────────────────

export async function getMood(env: Env, chatId: number): Promise<MoodData> {
  try {
    const raw = await env.KV.get(moodKey(chatId));
    if (raw) return JSON.parse(raw) as MoodData;
  } catch { /* fall through to default */ }

  return defaultMood();
}

export async function saveMood(env: Env, chatId: number, mood: MoodData): Promise<void> {
  await env.KV.put(moodKey(chatId), JSON.stringify(mood), {
    expirationTtl: MOOD_TTL,
  });
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

  // Calculate swing chance based on volatility
  const swingChance = getSwingChance(mood.volatility);
  const roll = Math.random();

  if (roll < swingChance) {
    // Swing! Pick a new mood from weighted transitions
    const newMood = pickWeightedTransition(mood.mood);
    const newIntensity = 30 + Math.floor(Math.random() * 50); // 30-80

    mood.mood = newMood;
    mood.intensity = newIntensity;
    mood.lastChange = Date.now();

    await saveMood(env, chatId, mood);
  }

  return mood;
}

// ─── Swing Chance Based on Volatility ────────────────────────────────────────

function getSwingChance(volatility: number): number {
  // Low volatility (0.0-0.3): 3-5% chance
  // Medium (0.3-0.7): 8-12% chance
  // High (0.7-1.0): 15-20% chance
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
// Called after LLM classifies user sentiment toward Joi

export async function shiftMoodBySentiment(
  env: Env,
  chatId: number,
  sentiment: "positive" | "negative" | "neutral",
): Promise<MoodData> {
  const mood = await getMood(env, chatId);

  if (sentiment === "positive") {
    // Nudge toward positive moods
    if (NEGATIVE_MOODS.includes(mood.mood)) {
      // If currently negative, chance to recover
      if (Math.random() < 0.4) {
        mood.mood = POSITIVE_MOODS[Math.floor(Math.random() * POSITIVE_MOODS.length)];
        mood.intensity = 40 + Math.floor(Math.random() * 30);
        mood.lastChange = Date.now();
      } else {
        // Just reduce intensity
        mood.intensity = Math.max(10, mood.intensity - 15);
      }
    } else {
      // Already positive, boost intensity
      mood.intensity = Math.min(100, mood.intensity + 10);
    }
  } else if (sentiment === "negative") {
    // Nudge toward negative moods
    if (POSITIVE_MOODS.includes(mood.mood)) {
      if (Math.random() < 0.5) {
        mood.mood = NEGATIVE_MOODS[Math.floor(Math.random() * NEGATIVE_MOODS.length)];
        mood.intensity = 50 + Math.floor(Math.random() * 30);
        mood.lastChange = Date.now();
      } else {
        mood.intensity = Math.max(10, mood.intensity - 20);
      }
    } else {
      // Already negative, intensify
      mood.intensity = Math.min(100, mood.intensity + 15);
    }
  }
  // neutral: no mood change

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
  mood.intensity = 80 + Math.floor(Math.random() * 20); // 80-100
  mood.offendedBy = offenderId;
  mood.offenseReason = reason;
  // Cool period: 2-4 hours
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

  // Random nudge ±0.05–0.15
  const nudge = (Math.random() * 0.1 + 0.05) * (Math.random() < 0.5 ? -1 : 1);
  mood.volatility = Math.max(0, Math.min(1, mood.volatility + nudge));

  // Auto-expire cool period
  if (mood.coolPeriodUntil && Date.now() > mood.coolPeriodUntil) {
    mood.mood = "annoyed"; // downgrade from offended to annoyed
    mood.intensity = 40;
    mood.coolPeriodUntil = undefined;
    mood.lastChange = Date.now();
  }

  await saveMood(env, chatId, mood);
}

// ─── Cron: Random Mood Shift ─────────────────────────────────────────────────

export async function cronMoodShift(env: Env, chatId: number): Promise<void> {
  const mood = await getMood(env, chatId);

  // Don't override offended state during cool period
  if (isInCoolPeriod(mood)) {
    await driftVolatility(env, chatId);
    return;
  }

  // 20% chance of a mood shift on cron
  if (Math.random() < 0.2) {
    const newMood = pickWeightedTransition(mood.mood);
    mood.mood = newMood;
    mood.intensity = 30 + Math.floor(Math.random() * 40);
    mood.lastChange = Date.now();
  }

  // Always drift volatility on cron
  const nudge = (Math.random() * 0.1 + 0.05) * (Math.random() < 0.5 ? -1 : 1);
  mood.volatility = Math.max(0, Math.min(1, mood.volatility + nudge));

  await saveMood(env, chatId, mood);
}
