// ─── Relationship System (D1-backed + In-Memory Cache) ──────────────────────

import type { Env, UserProfile } from "./config";

const DECAY_RATE_PER_DAY = 1;
const MAX_DECAY_PER_CHECK = 5;
const MS_PER_DAY = 86400000;

// ─── In-Memory TTL Cache ─────────────────────────────────────────────────────
// Module-scope Map survives across requests within the same Worker isolate.
// TTL = 30s to keep data fresh while reducing D1 round-trips for hot paths
// (the same profile is often fetched 2-3 times per message: resolveUserName,
// handleActiveMessage, sentiment update).

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const profileCache = new Map<string, CacheEntry<UserProfile>>();
const CACHE_TTL_MS = 30_000; // 30 seconds

function cacheKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

function cloneProfile(p: UserProfile): UserProfile {
  return { ...p, activityHours: p.activityHours ? [...p.activityHours] : undefined };
}

function getCached(chatId: number, userId: number): UserProfile | null {
  const key = cacheKey(chatId, userId);
  const entry = profileCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    profileCache.delete(key);
    return null;
  }
  return cloneProfile(entry.data); // shallow copy to prevent cross-request mutation
}

function setCache(profile: UserProfile): void {
  const key = cacheKey(profile.chatId, profile.userId);
  profileCache.set(key, {
    data: cloneProfile(profile), // store a copy so mutations don't leak into cache
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  // Prevent memory leak: cap cache size
  if (profileCache.size > 100) {
    const oldest = profileCache.keys().next().value;
    if (oldest) profileCache.delete(oldest);
  }
}

function invalidateCache(chatId: number, userId: number): void {
  profileCache.delete(cacheKey(chatId, userId));
}

// ─── Load Profile ────────────────────────────────────────────────────────────

export async function getProfile(env: Env, chatId: number, userId: number): Promise<UserProfile> {
  // Check cache first
  const cached = getCached(chatId, userId);
  if (cached) return cached;

  const row = await env.DB.prepare(
    `SELECT * FROM profiles WHERE chat_id = ? AND user_id = ?`,
  )
    .bind(chatId, userId)
    .first<{
      chat_id: number; user_id: number; nickname: string | null;
      nickname_override: number; score: number; sentiment_avg: number;
      first_seen: number; last_interaction: number; is_first_contact: number;
      activity_hours: string | null;
    }>();

  if (!row) return defaultProfile(chatId, userId);

  const profile: UserProfile = {
    userId: row.user_id,
    chatId: row.chat_id,
    nickname: row.nickname || undefined,
    nicknameOverride: !!row.nickname_override,
    score: row.score,
    sentimentAvg: row.sentiment_avg ?? 0,
    lastInteraction: row.last_interaction,
    firstSeen: row.first_seen,
    isFirstContact: !!row.is_first_contact,
    activityHours: row.activity_hours ? JSON.parse(row.activity_hours) : undefined,
  };

  const decayed = applyDecay(profile);
  setCache(decayed);
  return decayed;
}

// ─── Save Profile ────────────────────────────────────────────────────────────

export async function saveProfile(env: Env, profile: UserProfile): Promise<void> {
  profile.lastInteraction = Date.now();

  // Update cache immediately
  setCache(profile);

  await env.DB.prepare(
    `INSERT INTO profiles (chat_id, user_id, nickname, nickname_override, score, sentiment_avg, first_seen, last_interaction, is_first_contact, activity_hours)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, user_id) DO UPDATE SET
       nickname = excluded.nickname,
       nickname_override = excluded.nickname_override,
       score = excluded.score,
       sentiment_avg = excluded.sentiment_avg,
       last_interaction = excluded.last_interaction,
       is_first_contact = excluded.is_first_contact,
       activity_hours = excluded.activity_hours`,
  )
    .bind(
      profile.chatId,
      profile.userId,
      profile.nickname || null,
      profile.nicknameOverride ? 1 : 0,
      profile.score,
      profile.sentimentAvg,
      profile.firstSeen,
      profile.lastInteraction,
      profile.isFirstContact ? 1 : 0,
      profile.activityHours ? JSON.stringify(profile.activityHours) : null,
    )
    .run();
}

function defaultProfile(chatId: number, userId: number): UserProfile {
  return {
    userId,
    chatId,
    nickname: undefined,
    nicknameOverride: false,
    score: 0,
    sentimentAvg: 0,
    lastInteraction: Date.now(),
    firstSeen: Date.now(),
    isFirstContact: true,
  };
}

// ─── Relationship Score Decay ────────────────────────────────────────────────

function applyDecay(profile: UserProfile): UserProfile {
  const elapsed = Date.now() - profile.lastInteraction;
  const daysInactive = elapsed / MS_PER_DAY;

  if (daysInactive < 1 || profile.score === 0) return profile;

  const decayAmount = Math.min(
    Math.floor(daysInactive) * DECAY_RATE_PER_DAY,
    MAX_DECAY_PER_CHECK,
  );

  if (profile.score > 0) {
    profile.score = Math.max(0, profile.score - decayAmount);
  } else {
    profile.score = Math.min(0, profile.score + decayAmount);
  }

  return profile;
}

// ─── Update Relationship Score ───────────────────────────────────────────────

export async function adjustScore(
  env: Env,
  chatId: number,
  userId: number,
  delta: number,
): Promise<UserProfile> {
  const profile = await getProfile(env, chatId, userId);
  profile.score = Math.max(-100, Math.min(100, profile.score + delta));
  await saveProfile(env, profile);
  return profile;
}

// ─── Update Sentiment Rolling Average ────────────────────────────────────────
// Exponential moving average: newAvg = α * newValue + (1 - α) * oldAvg
// α = 0.15 means recent messages have ~15% weight, smooth but responsive

const SENTIMENT_ALPHA = 0.15;

export async function updateSentimentAvg(
  env: Env,
  chatId: number,
  userId: number,
  sentiment: "positive" | "negative" | "neutral",
): Promise<void> {
  const mapping = { positive: 1.0, neutral: 0.0, negative: -1.0 };
  const newValue = mapping[sentiment];

  const profile = await getProfile(env, chatId, userId);
  profile.sentimentAvg = SENTIMENT_ALPHA * newValue + (1 - SENTIMENT_ALPHA) * profile.sentimentAvg;
  // Clamp to [-1, 1]
  profile.sentimentAvg = Math.max(-1, Math.min(1, profile.sentimentAvg));

  // Update cache + D1
  await saveProfile(env, profile);
}

// ─── Get Relationship Tier ───────────────────────────────────────────────────

export type RelationshipTier = "bestie" | "friendly" | "neutral" | "cold" | "hostile";

export function getRelationshipTier(score: number): RelationshipTier {
  if (score > 50) return "bestie";
  if (score > 20) return "friendly";
  if (score >= -20) return "neutral";
  if (score >= -50) return "cold";
  return "hostile";
}

// ─── Build Relationship Summary for System Prompt ────────────────────────────

export function buildRelationshipSummary(profile: UserProfile): string {
  const tier = getRelationshipTier(profile.score);
  const name = profile.nickname || "Незнакомец";

  const tierDescriptions: Record<RelationshipTier, string> = {
    bestie:   "Это твой лучший друг, ты его обожаешь. Будь тёплой, милой, можно пофлиртовать.",
    friendly: "Вы хорошо общаетесь, он тебе нравится. Будь дружелюбной и игривой.",
    neutral:  "Вы пока мало общаетесь. Будь дружелюбной и открытой — без наездов и агрессии. Дай человеку привыкнуть к тебе. Подкалывать можно, но лёгко, не зло.",
    cold:     "Он тебя раздражает. Будь холодной, отвечай коротко, можно подколоть.",
    hostile:  "Ты его терпеть не можешь. Будь грубой, саркастичной, можешь отказать в помощи.",
  };

  // Add sentiment vibe context when it diverges from relationship tier
  let sentimentHint = "";
  if (profile.sentimentAvg > 0.4 && tier !== "bestie") {
    sentimentHint = " В последнее время он к тебе тёпел — можешь быть чуть добрее.";
  } else if (profile.sentimentAvg < -0.4 && tier !== "hostile") {
    sentimentHint = " В последнее время он грубит — можешь быть холоднее.";
  }

  return `Тебе пишет ${name} (отношение: ${profile.score}/${tier}). ${tierDescriptions[tier]}${sentimentHint}`;
}

// ─── Set Nickname Override ───────────────────────────────────────────────────

export async function setNickname(
  env: Env,
  chatId: number,
  userId: number,
  nickname: string,
): Promise<UserProfile> {
  const profile = await getProfile(env, chatId, userId);
  profile.nickname = nickname;
  profile.nicknameOverride = true;
  await saveProfile(env, profile);
  return profile;
}

// ─── Mark First Contact Done ─────────────────────────────────────────────────

export async function markFirstContactDone(
  env: Env,
  chatId: number,
  userId: number,
): Promise<void> {
  const profile = await getProfile(env, chatId, userId);
  profile.isFirstContact = false;
  await saveProfile(env, profile);
}
