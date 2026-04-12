// ─── User Facts — Long-term Memory (D1-backed) ──────────────────────────────

import type { Env, LLMMessage } from "./config";
import { callLLMLight } from "./ai";

const MAX_FACTS = 15;

// ─── Fact Categories ────────────────────────────────────────────────────────
// identity:   name, age, city, nationality, profession
// preference:  likes, dislikes, music taste, food preferences
// habit:       routines, time patterns, behavioral quirks
// event:       life events, milestones, relationship updates
// general:     anything that doesn't fit above

export type FactCategory = "identity" | "preference" | "habit" | "event" | "general";

interface CategorizedFact {
  fact: string;
  category: FactCategory;
}

// ─── Load Facts ─────────────────────────────────────────────────────────────

export async function getFacts(env: Env, chatId: number, userId: number): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT fact, category FROM facts WHERE chat_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(chatId, userId, MAX_FACTS)
    .all<{ fact: string; category: string }>();

  return (rows.results || []).map((r) => r.fact);
}

// ─── Load Facts for Most Recently Active Group Member ────────────────────────

export async function getRecentActiveFacts(env: Env, chatId: number): Promise<string[]> {
  const recentUser = await env.DB.prepare(
    `SELECT user_id FROM messages WHERE chat_id = ? AND role = 'user' AND is_bot = 0
     ORDER BY ts DESC LIMIT 1`,
  ).bind(chatId).first<{ user_id: number }>();

  if (!recentUser) return [];
  return getFacts(env, chatId, recentUser.user_id);
}

// ─── Extract Facts from Message ─────────────────────────────────────────────

export async function extractAndSaveFacts(
  env: Env,
  chatId: number,
  userId: number,
  text: string,
): Promise<void> {
  if (text.length < 10) return; // too short to contain facts

  const systemPrompt = `Извлеки факты о пользователе из сообщения. Только КОНКРЕТНЫЕ личные факты.

Категории фактов:
- identity: имя, возраст, город, профессия, национальность, пол
- preference: вкусы, предпочтения в музыке/еде/фильмах, любимые вещи
- habit: привычки, рутины, режим дня
- event: жизненные события, отношения, достижения
- general: прочие факты

НЕ извлекай: мнения, настроение, вопросы, команды боту.
Если фактов нет — верни пустой массив.

Верни ТОЛЬКО JSON массив объектов {fact: string, category: string}, ничего больше.

Примеры:
"я живу в Алматы и работаю дизайнером" → [{"fact":"живёт в Алматы","category":"identity"},{"fact":"работает дизайнером","category":"identity"}]
"обожаю Скриптонита" → [{"fact":"обожает Скриптонита","category":"preference"}]
"как дела?" → []`;

  const messages: LLMMessage[] = [{ role: "user", content: text }];
  const result = await callLLMLight(env, messages, systemPrompt, 150, 0.1);

  if (!result) return;

  try {
    const parsed = JSON.parse(result.trim());
    if (!Array.isArray(parsed) || parsed.length === 0) return;

    // Normalize to CategorizedFact array (handle both old string[] and new object[] format)
    const newFacts: CategorizedFact[] = parsed.map((item: any) => {
      if (typeof item === "string") return { fact: item, category: "general" as FactCategory };
      return { fact: item.fact, category: (item.category || "general") as FactCategory };
    }).filter((f: CategorizedFact) => f.fact && f.fact.length > 0);

    if (newFacts.length === 0) return;

    // Load existing facts for dedup and reconciliation
    const existingRows = await env.DB.prepare(
      `SELECT id, fact, category FROM facts WHERE chat_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(chatId, userId, MAX_FACTS)
      .all<{ id: number; fact: string; category: string }>();

    const existing = existingRows.results || [];

    // ── Reconciliation: detect contradictions and updates ─────────────────
    const toInsert: CategorizedFact[] = [];
    const toDelete: number[] = []; // IDs of contradicted facts to remove

    for (const newFact of newFacts) {
      // Simple dedup: skip if substantially similar to existing
      const isDuplicate = existing.some((e) =>
        e.fact.toLowerCase().includes(newFact.fact.toLowerCase().slice(0, 15)) ||
        newFact.fact.toLowerCase().includes(e.fact.toLowerCase().slice(0, 15)),
      );
      if (isDuplicate) continue;

      // Contradiction detection: for identity/preference facts, check if new fact
      // contradicts an existing one on the same topic
      if (newFact.category === "identity" || newFact.category === "preference") {
        const contradicted = findContradiction(newFact.fact, existing);
        if (contradicted) {
          // New fact replaces old — mark old for deletion
          toDelete.push(contradicted.id);
        }
      }

      toInsert.push(newFact);
    }

    if (toInsert.length === 0 && toDelete.length === 0) return;

    // ── Batch operation: delete contradictions + insert new facts + trim ──
    const statements: D1PreparedStatement[] = [];

    // Delete contradicted facts
    for (const id of toDelete) {
      statements.push(
        env.DB.prepare(`DELETE FROM facts WHERE id = ?`).bind(id)
      );
    }

    // Insert new facts
    for (const fact of toInsert) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO facts (chat_id, user_id, fact, category, created_at) VALUES (?, ?, ?, ?, ?)`,
        ).bind(chatId, userId, fact.fact, fact.category, Date.now())
      );
    }

    // Trim to MAX_FACTS (keep newest)
    statements.push(
      env.DB.prepare(
        `DELETE FROM facts WHERE chat_id = ? AND user_id = ? AND id NOT IN (
           SELECT id FROM facts WHERE chat_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?
         )`,
      ).bind(chatId, userId, chatId, userId, MAX_FACTS)
    );

    // Execute all in a single batch round-trip
    await env.DB.batch(statements);
  } catch { /* JSON parse failed, skip */ }
}

// ─── Contradiction Detection ────────────────────────────────────────────────
// Detects when a new fact contradicts an existing one on the same topic.
// Uses keyword overlap to find facts about the same subject, then checks
// for negation patterns or value changes.

function findContradiction(
  newFact: string,
  existing: { id: number; fact: string; category: string }[],
): { id: number; fact: string } | null {
  const newLower = newFact.toLowerCase();
  const newWords = newLower.split(/\s+/).filter(w => w.length > 3);

  for (const e of existing) {
    const eLower = e.fact.toLowerCase();

    // Check if facts share significant keywords (same topic)
    const sharedWords = newWords.filter(w => eLower.includes(w));
    if (sharedWords.length < 1) continue;

    // Negation patterns: "не умеет X" vs "умеет X", "не любит" vs "любит"
    const hasNegation =
      (newLower.includes("не ") && !eLower.includes("не ")) ||
      (!newLower.includes("не ") && eLower.includes("не "));

    if (hasNegation && sharedWords.length >= 1) {
      return { id: e.id, fact: e.fact };
    }

    // City/profession change: "живёт в X" vs "живёт в Y"
    const locationMatch = newLower.match(/(?:живёт|работает|учится)\s+(?:в|на|у)\s+(\S+)/);
    const existingMatch = eLower.match(/(?:живёт|работает|учится)\s+(?:в|на|у)\s+(\S+)/);
    if (locationMatch && existingMatch && locationMatch[1] !== existingMatch[1]) {
      return { id: e.id, fact: e.fact };
    }

    // Age change: "ему 25" vs "ему 26"
    const newAge = newLower.match(/(\d+)\s*(?:лет|год)/);
    const existingAge = eLower.match(/(\d+)\s*(?:лет|год)/);
    if (newAge && existingAge && newAge[1] !== existingAge[1]) {
      return { id: e.id, fact: e.fact };
    }
  }

  return null;
}

// ─── Save Pre-Extracted Facts (from batch analyze) ──────────────────────────
// Saves facts that were already extracted by batchAnalyzeMessage, without
// needing another LLM call. Reuses the same dedup/contradiction logic.

export async function saveBatchFacts(
  env: Env,
  chatId: number,
  userId: number,
  facts: Array<{ fact: string; category: string }>,
): Promise<void> {
  if (facts.length === 0) return;

  try {
    const newFacts = facts.map(f => ({
      fact: f.fact,
      category: (f.category || "general") as FactCategory,
    })).filter(f => f.fact.length > 0);

    if (newFacts.length === 0) return;

    // Load existing facts for dedup and reconciliation
    const existingRows = await env.DB.prepare(
      `SELECT id, fact, category FROM facts WHERE chat_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(chatId, userId, MAX_FACTS)
      .all<{ id: number; fact: string; category: string }>();

    const existing = existingRows.results || [];

    const toInsert: CategorizedFact[] = [];
    const toDelete: number[] = [];

    for (const newFact of newFacts) {
      // Simple dedup
      const isDuplicate = existing.some((e) =>
        e.fact.toLowerCase().includes(newFact.fact.toLowerCase().slice(0, 15)) ||
        newFact.fact.toLowerCase().includes(e.fact.toLowerCase().slice(0, 15)),
      );
      if (isDuplicate) continue;

      // Contradiction detection
      if (newFact.category === "identity" || newFact.category === "preference") {
        const contradicted = findContradiction(newFact.fact, existing);
        if (contradicted) {
          toDelete.push(contradicted.id);
        }
      }

      toInsert.push(newFact);
    }

    if (toInsert.length === 0 && toDelete.length === 0) return;

    const statements: D1PreparedStatement[] = [];

    for (const id of toDelete) {
      statements.push(env.DB.prepare(`DELETE FROM facts WHERE id = ?`).bind(id));
    }

    for (const fact of toInsert) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO facts (chat_id, user_id, fact, category, created_at) VALUES (?, ?, ?, ?, ?)`,
        ).bind(chatId, userId, fact.fact, fact.category, Date.now())
      );
    }

    statements.push(
      env.DB.prepare(
        `DELETE FROM facts WHERE chat_id = ? AND user_id = ? AND id NOT IN (
           SELECT id FROM facts WHERE chat_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?
         )`,
      ).bind(chatId, userId, chatId, userId, MAX_FACTS)
    );

    await env.DB.batch(statements);
  } catch (e) {
    console.error("[saveBatchFacts] error:", e);
  }
}
