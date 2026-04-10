// ─── User Name Resolution ────────────────────────────────────────────────────
// Dynamic, KV-backed. VIP group members have pre-loaded defaults.

import type { Env } from "./config";
import { VIP_GROUP_ID, VIP_MEMBERS } from "./config";
import { getProfile } from "./relationships";

// ─── Resolve Display Name ────────────────────────────────────────────────────
// Priority: KV nickname override → VIP default name → Telegram first_name → "Незнакомец"

export async function resolveUserName(
  env: Env,
  chatId: number,
  userId: number,
  telegramFirstName?: string,
): Promise<string> {
  const profile = await getProfile(env, chatId, userId);

  // 1. User-set nickname override (highest priority)
  if (profile.nicknameOverride && profile.nickname) {
    return profile.nickname;
  }

  // 2. VIP group: use pre-loaded member names
  if (chatId === VIP_GROUP_ID) {
    const vip = VIP_MEMBERS.find((m) => m.id === userId);
    if (vip) return vip.defaultName;
  }

  // 3. Stored nickname (set during first contact flow)
  if (profile.nickname) {
    return profile.nickname;
  }

  // 4. Telegram first_name fallback
  return telegramFirstName || "Незнакомец";
}

// ─── Get VIP Member Info ─────────────────────────────────────────────────────

export function getVipMemberName(userId: number): string | null {
  const vip = VIP_MEMBERS.find((m) => m.id === userId);
  return vip?.defaultName ?? null;
}

export function getVipMemberAliases(userId: number): string[] {
  const vip = VIP_MEMBERS.find((m) => m.id === userId);
  return vip ? [vip.defaultName, ...vip.aliases] : [];
}

// ─── Check if First Contact (private chat) ───────────────────────────────────

export async function isFirstContact(
  env: Env,
  chatId: number,
  userId: number,
): Promise<boolean> {
  const profile = await getProfile(env, chatId, userId);
  return profile.isFirstContact;
}

// ─── Check if Message is a Nickname Change Request for Someone Else ──────────

export function isThirdPartyNicknameRequest(
  text: string,
  senderId: number,
  chatId: number,
): boolean {
  if (chatId !== VIP_GROUP_ID) return false;

  const lower = text.toLowerCase();
  // Patterns like "зови Руса ..." or "называй Камбара ..."
  for (const member of VIP_MEMBERS) {
    if (member.id === senderId) continue;
    const names = [member.defaultName.toLowerCase(), ...member.aliases.map((a) => a.toLowerCase())];
    for (const name of names) {
      if (lower.includes(`зови ${name}`) || lower.includes(`называй ${name}`)) {
        return true;
      }
    }
  }
  return false;
}

// ─── Register Active Chat ────────────────────────────────────────────────────

export async function registerActiveChat(env: Env, chatId: number): Promise<void> {
  const key = "chats:active";
  try {
    const raw = await env.KV.get(key);
    const chats: number[] = raw ? JSON.parse(raw) : [];
    if (!chats.includes(chatId)) {
      chats.push(chatId);
      await env.KV.put(key, JSON.stringify(chats));
    }
  } catch {
    await env.KV.put(key, JSON.stringify([chatId]));
  }
}

export async function getActiveChats(env: Env): Promise<number[]> {
  try {
    const raw = await env.KV.get("chats:active");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
