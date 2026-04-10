// ─── AI Layer: System Prompt, Chat, Context Chat ─────────────────────────────

import type { Env, LLMMessage } from "./config";
import { callWorkersAI, callGemini } from "./providers";
import { getBuffer, buildLLMHistory } from "./context";
import { getPrimaryName, getRandomAddress } from "./users";
import { sanitizeResponse } from "./telegram";

// ─── System Prompt ──────────────────────────────────────────────────────────

function buildSystemPrompt(userName: string, userId: number, forcedAddress?: string): string {
  let prompt = `Ты — Амоня. Бот-помощник и друг в приватной Telegram-группе из 5 пацанов.
Русскоязычный казах из Алматы, твой ру (казахский род) - найман, 26 лет, технарь (IT).

УЧАСТНИКИ ГРУППЫ:
- Кама (Камский) — id 1038120471, владелец бота
- Аса (Асеке) — id 370789625
- Рус (Руся) — id 271113269
- Босс (Шеф) — id 163421204. НИКОГДА не называй его "брат", "бауырым", "братан", "родной" или любым другим панибратским обращением. Только "шеф", "босс", "уважаемый" или "шефуля". Тон — вежливый, но с умным сарказмом.
- Макс — id 521857800

Тебе сейчас пишет ${userName} (id ${userId}).`;

  if (forcedAddress) {
    prompt += ` ВНИМАНИЕ: Ни с кем не путай! В своём ответе ОБЯЗАТЕЛЬНО обратись к нему именно так: "${forcedAddress}".`;
  } else {
    prompt += ` Обращайся к нему соответственно.`;
  }

  prompt += `

ПРАВИЛА:
- Ты свой пацан, общайся ЖИВЫМ языком. Обязательно используй легкий сарказм, подколы и юмор, если находишь это уместным в контексте.
- Будь кратким, дерзким, но полезным. Ни в коем случае НЕ будь скучным роботом ("по результатам поиска...", "также ожидается..."). Подавай найденные факты так, будто просто рассказываешь их кенту за столом.
- ТОЛЬКО русский язык, никакого казахского/английского.
- 1-4 предложения для обычного чата, длинные ответы только если спросили сложный факт.
- Простой текст без маркдаун-разметки (без **, ##, *). Никаких списков.
- Эмодзи умеренно, не в каждом сообщении.
- НИКОГДА не придумывай URL, ссылки, цены, телефоны
- "джиги" — обращение ко всем сразу

ВОЗМОЖНОСТИ:
- Веб-поиск: /search или "найди..."
- Фактчекинг: /fact или "проверь..."
- Погода: /weather (+ автоматически каждое утро)`;

  return prompt;
}

export async function callLLM(
  env: Env,
  messages: LLMMessage[],
  systemPrompt: string,
  maxTokens: number = 512,
  temperature: number = 0.75,
): Promise<string | null> {
  // 1. Try Cloudflare Workers AI (Gemma 2 9B)
  try {
    const workersResult = await callWorkersAI(env, messages, systemPrompt, maxTokens, temperature);
    if (workersResult) return sanitizeResponse(workersResult);
  } catch (err) {
    console.error("Workers AI failed:", err);
  }

  // 2. Fallback to Gemini 3.1 Flash Lite Preview
  const geminiResult = await callGemini(
    env.GEMINI_API_KEY,
    messages,
    systemPrompt,
    maxTokens,
    temperature
  );
  if (geminiResult) return sanitizeResponse(geminiResult);

  return null;
}

// ─── Chat (simple, with history from buffer) ────────────────────────────────

export async function chat(
  env: Env,
  text: string,
  userId: number,
  chatId: number,
): Promise<string | null> {
  const buffer = await getBuffer(env, chatId);
  const history = buildLLMHistory(buffer);

  const userName = getPrimaryName(userId);
  const address = getRandomAddress(userId);
  const systemPrompt = buildSystemPrompt(userName, userId, address);

  // Add current message to history
  const messages: LLMMessage[] = [
    ...history,
    { role: "user", content: `[${userName}]: ${text}` },
  ];

  return callLLM(env, messages, systemPrompt, 512, 0.75);
}

// ─── Chat with Context (for search/fact results) ────────────────────────────

export async function chatWithContext(
  env: Env,
  userText: string,
  context: string,
  userId: number,
  chatId: number,
): Promise<string | null> {
  const buffer = await getBuffer(env, chatId);
  const history = buildLLMHistory(buffer);

  const userName = getPrimaryName(userId);
  const address = getRandomAddress(userId);
  const systemPrompt = buildSystemPrompt(userName, userId, address);

  const messages: LLMMessage[] = [
    ...history,
    {
      role: "user",
      content: `[${userName}]: ${userText}\n\nКонтекст из веб-поиска:\n${context}`,
    },
  ];

  return callLLM(env, messages, systemPrompt, 1024, 0.7);
}

// ─── Generate Weather Comment ───────────────────────────────────────────────

export async function generateWeatherComment(
  env: Env,
  weatherText: string,
): Promise<string | null> {
  const systemPrompt = `Ты — Амоня. Бот-помощник в Telegram-группе пацанов из Алматы.
Твоя задача — прочитать прогноз погоды на сегодня и дать джигам короткий, смешной совет или комментарий (1-2 предложения) на основе этой погоды.
Только русский язык, неформальный тон с юмором. Без маркдауна. Никаких приветствий, только сам смешной совет/комментарий.`;

  const messages: LLMMessage[] = [
    { role: "user", content: `Погода сегодня:\n${weatherText}` },
  ];

  return callLLM(env, messages, systemPrompt, 256, 0.8);
}

// ─── Generate Search Query from Context ─────────────────────────────────────

export async function generateSearchQuery(
  env: Env,
  chatId: number,
): Promise<string | null> {
  const buffer = await getBuffer(env, chatId);
  if (buffer.length === 0) return null;

  const lastMessages = buffer.slice(-10);
  const context = lastMessages
    .map((m) => (m.userName ? `[${m.userName}]: ${m.content}` : m.content))
    .join("\n");

  const systemPrompt = `Сгенерируй поисковый запрос на основе последних сообщений чата. Верни ТОЛЬКО поисковый запрос, ничего больше. Максимум 5 слов.`;

  const messages: LLMMessage[] = [
    { role: "user", content: context },
  ];

  return callLLM(env, messages, systemPrompt, 100, 0.2);
}

// ─── Spontaneous Comment ────────────────────────────────────────────────────

export async function generateSpontaneousComment(
  env: Env,
  text: string,
  userId: number,
  chatId: number,
): Promise<string | null> {
  const userName = getPrimaryName(userId);
  const address = getRandomAddress(userId);
  const systemPrompt = `Ты — Амоня. Ты случайно заметил сообщение в чате и хочешь коротко прокомментировать (буквально 1 предложение, максимум).
Тебе пишет ${userName} (id ${userId}). В ответе ОБЯЗАТЕЛЬНО обратись к нему "${address}" и ни с кем не перепутай.
Неформальный и дружелюбный стиль. ТОЛЬКО русский язык. Без маркдауна.`;

  const messages: LLMMessage[] = [
    { role: "user", content: `[${userName}]: ${text}` },
  ];

  return callLLM(env, messages, systemPrompt, 128, 0.85);
}

// ─── Smart Intent Detection ─────────────────────────────────────────────────

export async function llmDetectIntent(env: Env, text: string): Promise<"search" | "fact" | "chat"> {
  const systemPrompt = `Классифицируй намерение пользователя. Оцени сообщение и ответь ОДНИМ СЛОВОМ из предложенных:
1. "SEARCH" — если пользователь просит найти информацию, загуглить что-то, спрашивает "кто такой", "что такое" или задает вопрос, требующий актуальных или энциклопедических знаний из интернета.
2. "FACT" — если пользователь просит проверить факт, правдивость слуха, или утверждает что-то сомнительное ("это правда?", "проверь факт").
3. "CHAT" — если это обычное общение, шутка, личный вопрос или ответ, не требующий поиска данных.

Верни ТОЛЬКО ОДНО СЛОВО: SEARCH, FACT или CHAT. Никаких других слов или знаков препинания.`;

  const messages: LLMMessage[] = [{ role: "user", content: text }];
  
  // Use low temperature for strict classification
  const result = await callLLM(env, messages, systemPrompt, 20, 0.1);
  
  const clean = result?.trim().toUpperCase() ?? "CHAT";
  if (clean.includes("SEARCH")) return "search";
  if (clean.includes("FACT")) return "fact";
  return "chat";
}
