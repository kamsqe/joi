// ─── Hardcoded User Registry ─────────────────────────────────────────────────

interface UserEntry {
  names: string[];
  primaryName: string;
}

const USERS: Record<number, UserEntry> = {
  1038120471: { names: ["Кама", "Камский"], primaryName: "Кама" },
  370789625:  { names: ["Аса", "Асеке"],    primaryName: "Аса" },
  271113269:  { names: ["Рус", "Руся"],     primaryName: "Рус" },
  163421204:  { names: ["босс", "шеф"],     primaryName: "босс" },
  521857800:  { names: ["Макс"],            primaryName: "Макс" },
};

export function isKnownUser(userId: number): boolean {
  return userId in USERS;
}

export function getPrimaryName(userId: number): string {
  return USERS[userId]?.primaryName ?? "Незнакомец";
}

export function getUserName(userId: number): string {
  const user = USERS[userId];
  if (!user) return "Незнакомец";
  return user.names[Math.floor(Math.random() * user.names.length)];
}

const BOSS_ID = 163421204;
const BOSS_ADDRESSES = ["шеф", "босс", "уважаемый", "шефуля"];

export function getRandomAddress(userId: number): string {
  if (userId === BOSS_ID) {
    return BOSS_ADDRESSES[Math.floor(Math.random() * BOSS_ADDRESSES.length)];
  }

  const user = USERS[userId];
  const genericTerms = ["брат", "бауырым", "родной", "братан"];

  if (!user || Math.random() < 0.5) {
    return genericTerms[Math.floor(Math.random() * genericTerms.length)];
  }
  return user.names[Math.floor(Math.random() * user.names.length)];
}
