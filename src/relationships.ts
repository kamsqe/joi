// ─── Relationship System ─────────────────────────────────────────────────────

import type { Env, UserProfile } from "./config";

const PROFILE_TTL = 60 * 60 * 24 * 90; // 90 days
const DECAY_RATE_PER_DAY = 1;
const MAX_DECAY_PER_CHECK = 5;
const MS_PER_DAY = 86400000;

function profileKey(chatId: number, userId: number): string {
  return `user:${chatId}:${userId}`;
}

// ─── Load / Save Profile ─────────────────────────────────────────────────────

export async function getProfile(env: Env, chatId: number, userId: number): Promise<UserProfile> {
  try {
    const raw = await env.KV.get(profileKey(chatId, userId));
    if (raw) {
      const profile = JSON.parse(raw) as UserProfile;
      // Apply decay on load
      return applyDecay(profile);
    }
  } catch { /* fall through */ }

  return defaultProfile(chatId, userId);
}

export async function saveProfile(env: Env, profile: UserProfile): Promise<void> {
  profile.lastInteraction = Date.now();
  await env.KV.put(
    profileKey(profile.chatId, profile.userId),
    JSON.stringify(profile),
    { expirationTtl: PROFILE_TTL },
  );
}

function defaultProfile(chatId: number, userId: number): UserProfile {
  return {
    userId,
    chatId,
    nickname: undefined,
    nicknameOverride: false,
    score: 0,
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

  return `Тебе пишет ${name} (отношение: ${profile.score}/${tier}). ${tierDescriptions[tier]}`;
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
