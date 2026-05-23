// ─── User Name Resolution (D1-backed) ────────────────────────────────────────
// Dynamic, D1-backed. VIP group members have pre-loaded defaults.

import type { Env } from "./config";
import { VIP_GROUP_ID, VIP_MEMBERS, AMONYA_BOT_ID } from "./config";
import { getProfile } from "./relationships";

// ─── Resolve Display Name ────────────────────────────────────────────────────
// Priority: D1 nickname override → VIP default name → Telegram first_name → "Незнакомец"

export async function resolveUserName(
  env: Env,
  chatId: number,
  userId: number,
  telegramFirstName?: string,
): Promise<string> {
  // 0. Peer bot — Amonya has a fixed identity. Hard-pin so he can't be
  //    overridden by Telegram first_name changes or accidentally fall through
  //    to "Незнакомец". Critical: without this, the system prompt says
  //    "Тебе пишет Незнакомец" while the message tag says [Амоня], and the
  //    LLM resolves the mismatch by picking a familiar VIP name (Rus).
  if (userId === AMONYA_BOT_ID) return "Амоня";

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
  await env.DB.prepare(
    `INSERT OR IGNORE INTO active_chats (chat_id, registered_at) VALUES (?, ?)`,
  )
    .bind(chatId, Date.now())
    .run();
}

export async function getActiveChats(env: Env): Promise<number[]> {
  const rows = await env.DB.prepare(
    `SELECT chat_id FROM active_chats`,
  )
    .all<{ chat_id: number }>();

  return (rows.results || []).map((r) => r.chat_id);
}

// ─── Prune Stale Active Chats (called by cron) ──────────────────────────────
// Drops active_chats rows where the chat has no messages in the last 30 days
// (and is older than 7d since registration so first-time chats aren't pruned
// before they get a chance). Per cost audit 2026-05-22: every active_chats
// row eats one cron iteration every 5min — that's 8,640 wasted iterations
// per month per stale chat. Catches the Boss DM (0 messages, registered Apr 12).

export async function pruneStaleActiveChats(env: Env): Promise<number> {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const result = await env.DB.prepare(
    `DELETE FROM active_chats
     WHERE registered_at < ?
       AND chat_id NOT IN (
         SELECT DISTINCT chat_id FROM messages WHERE ts > ?
       )`,
  ).bind(sevenDaysAgo, thirtyDaysAgo).run();

  const deleted = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  if (deleted > 0) {
    console.log(JSON.stringify({ event: "stale_chats_pruned", count: deleted }));
  }
  return deleted;
}
