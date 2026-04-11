// ─── User Facts — Long-term Memory ──────────────────────────────────────────

import type { Env, LLMMessage } from "./config";
import { callLLMLight } from "./ai";

const FACTS_TTL = 60 * 60 * 24 * 365; // 1 year
const MAX_FACTS = 10;

function factsKey(chatId: number, userId: number): string {
  return `facts:${chatId}:${userId}`;
}

// ─── Load / Save Facts ──────────────────────────────────────────────────────

export async function getFacts(env: Env, chatId: number, userId: number): Promise<string[]> {
  try {
    const raw = await env.KV.get(factsKey(chatId, userId));
    if (raw) return JSON.parse(raw) as string[];
  } catch { /* fall through */ }
  return [];
}

async function saveFacts(env: Env, chatId: number, userId: number, facts: string[]): Promise<void> {
  await env.KV.put(factsKey(chatId, userId), JSON.stringify(facts.slice(0, MAX_FACTS)), {
    expirationTtl: FACTS_TTL,
  });
}

// ─── Extract Facts from Message ─────────────────────────────────────────────

export async function extractAndSaveFacts(
  env: Env,
  chatId: number,
  userId: number,
  text: string,
): Promise<void> {
  if (text.length < 10) return; // too short to contain facts

  const systemPrompt = `Извлеки факты о пользователе из сообщения. Только КОНКРЕТНЫЕ личные факты: имя, город, работа, хобби, отношения, привычки, возраст, учёба.
НЕ извлекай: мнения, настроение, вопросы, команды боту.
Если фактов нет — верни пустой массив.
Верни ТОЛЬКО JSON массив строк, ничего больше.

Примеры:
"я живу в Алматы и работаю дизайнером" → ["живёт в Алматы", "работает дизайнером"]
"как дела?" → []
"я встала рано без будильника" → ["встаёт рано без будильника"]
"напомни позвонить маме" → []`;

  const messages: LLMMessage[] = [{ role: "user", content: text }];
  const result = await callLLMLight(env, messages, systemPrompt, 100, 0.1);

  if (!result) return;

  try {
    const newFacts = JSON.parse(result.trim()) as string[];
    if (!Array.isArray(newFacts) || newFacts.length === 0) return;

    const existing = await getFacts(env, chatId, userId);

    // Deduplicate: don't add facts that are semantically similar to existing ones
    const merged = [...existing];
    for (const fact of newFacts) {
      const isDuplicate = existing.some((e) =>
        e.toLowerCase().includes(fact.toLowerCase().slice(0, 15)) ||
        fact.toLowerCase().includes(e.toLowerCase().slice(0, 15)),
      );
      if (!isDuplicate) {
        merged.push(fact);
      }
    }

    // Keep only latest MAX_FACTS
    await saveFacts(env, chatId, userId, merged.slice(-MAX_FACTS));
  } catch { /* JSON parse failed, skip */ }
}

