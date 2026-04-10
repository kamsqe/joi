// ─── Amonya Bot — Main Entry Point ──────────────────────────────────────────

import type { Env, RetryTask, TelegramMessage } from "./config";
import { BOT_USERNAME, BOT_NAME_VARIANTS } from "./config";
import { parseUpdate, sendMessage, setMessageReaction, formatForTelegram, sanitizeResponse } from "./telegram";
import { isKnownUser, getUserName, getPrimaryName } from "./users";
import { saveUserMessage, saveBotMessage } from "./context";
import { chat, chatWithContext, generateWeatherComment, generateSearchQuery, generateSpontaneousComment, llmDetectIntent } from "./ai";
import { searchWeb } from "./search";
import { fetchWeather } from "./weather";

// ─── Export Worker ──────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Webhook endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      const body = await request.json();
      const update = parseUpdate(body);

      if (update?.message) {
        ctx.waitUntil(handleMessage(env, ctx, update.message));
      }

      return new Response("OK", { status: 200 });
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("Amonya bot is running", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Daily weather at 07:30 Almaty time
    ctx.waitUntil(handleDailyWeather(env));

    // Process retry queue
    ctx.waitUntil(processRetryQueue(env));
  },
};

// ─── Message Handler ────────────────────────────────────────────────────────

async function handleMessage(env: Env, ctx: ExecutionContext, message: TelegramMessage): Promise<void> {
  const text = message.text?.trim();
  if (!text) return;

  const userId = message.from?.id;
  if (!userId) return;

  const chatId = message.chat.id;
  const messageId = message.message_id;
  const threadId = message.message_thread_id;

  const isKnown = isKnownUser(userId);
  const isCommand = text.startsWith("/");

  // Save message from known users to buffer (non-blocking)
  if (isKnown && !isCommand) {
    ctx.waitUntil(saveUserMessage(env, chatId, userId, text));
  }

  // Check if bot should respond
  const respond = shouldRespond(message, text);

  if (!respond) {
    // Spontaneous reactions for known users (non-commands only)
    if (isKnown) {
      ctx.waitUntil(handleSpontaneous(env, chatId, messageId, text, userId));
    }
    return;
  }

  // Save command messages to buffer too
  if (isKnown && isCommand) {
    ctx.waitUntil(saveUserMessage(env, chatId, userId, text));
  }

  // Clean text: strip bot mentions and command suffixes
  const cleanText = stripBotMention(text);

  // Route to appropriate handler
  try {
    await routeMessage(env, ctx, chatId, messageId, userId, cleanText, message, threadId);
  } catch (err) {
    console.error("Message handling error:", err);
    await sendMessage(env, chatId, "Что-то пошло не так, попробуй ещё раз", messageId, threadId);
  }
}

// ─── Should Respond ─────────────────────────────────────────────────────────

function shouldRespond(message: TelegramMessage, text: string): boolean {
  // Always respond to commands
  if (text.startsWith("/")) return true;

  // Reply to bot's message
  if (message.reply_to_message?.from?.is_bot) return true;

  // Bot name mentioned
  const lower = text.toLowerCase();
  return BOT_NAME_VARIANTS.some((variant) => lower.includes(variant));
}

// ─── Strip Bot Mention ──────────────────────────────────────────────────────

function stripBotMention(text: string): string {
  let result = text;

  // Strip @bot_username suffix from commands
  result = result.replace(new RegExp(`@${BOT_USERNAME}`, "gi"), "");

  // Strip bot name variants from text
  for (const variant of BOT_NAME_VARIANTS) {
    result = result.replace(new RegExp(variant, "gi"), "");
  }

  // Clean up extra spaces
  result = result.replace(/\s+/g, " ").trim();

  return result;
}

// ─── Route Message ──────────────────────────────────────────────────────────

async function routeMessage(
  env: Env,
  ctx: ExecutionContext,
  chatId: number,
  messageId: number,
  userId: number,
  text: string,
  message: TelegramMessage,
  threadId?: number,
): Promise<void> {
  // Command routing
  const command = extractCommand(text);

  if (command) {
    switch (command.name) {
      case "fact":
      case "факт":
        await handleFact(env, ctx, chatId, messageId, userId, command.args, message, threadId);
        return;

      case "search":
      case "найди":
        await handleSearch(env, ctx, chatId, messageId, userId, command.args, message, threadId);
        return;

      case "weather":
      case "погода":
        await handleWeather(env, ctx, chatId, messageId, threadId);
        return;

      case "help":
      case "помощь":
        await handleHelp(env, chatId, messageId, threadId);
        return;
    }
  }

  // Reply to a message (forwarded or otherwise)
  if (message.reply_to_message?.text || message.reply_to_message?.caption) {
    await handleReply(env, ctx, chatId, messageId, userId, text, message, threadId);
    return;
  }

  // Natural language intent detection (fast Keyword matching)
  let intent = detectIntent(text);

  // If no simple keyword match but it could be a query, use Smart LLM Classification
  if (intent === "chat" && text.length > 8) {
    intent = await llmDetectIntent(env, text);
  }

  if (intent === "fact") {
    await handleFact(env, ctx, chatId, messageId, userId, text, message, threadId);
    return;
  }

  if (intent === "search") {
    await handleSearch(env, ctx, chatId, messageId, userId, text, message, threadId);
    return;
  }

  // Default: chat
  const response = await chat(env, text, userId, chatId);

  if (response) {
    const sent = await sendMessage(env, chatId, formatForTelegram(response), messageId, threadId);
    if (sent) ctx.waitUntil(saveBotMessage(env, chatId, response));
  } else {
    await handleProviderFailure(env, chatId, messageId, userId, text, "chat", threadId);
  }
}

// ─── Command Extraction ────────────────────────────────────────────────────

function extractCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith("/")) return null;

  const match = text.match(/^\/(\w+)\s*([\s\S]*)/);
  if (!match) return null;

  return {
    name: match[1].toLowerCase(),
    args: match[2].trim(),
  };
}

// ─── Intent Detection (keyword-only, NO LLM) ───────────────────────────────

const SEARCH_KEYWORDS = [
  "найди", "поищи", "загугли", "что такое", "кто такой",
  "расскажи про", "search", "гугл",
];

const FACT_KEYWORDS = [
  "правда ли", "правда что", "это правда", "верно ли",
  "проверь факт", "фактчек",
];

function detectIntent(text: string): "search" | "fact" | "chat" {
  const lower = text.toLowerCase();

  for (const kw of FACT_KEYWORDS) {
    if (lower.includes(kw)) return "fact";
  }

  for (const kw of SEARCH_KEYWORDS) {
    if (lower.includes(kw)) return "search";
  }

  return "chat";
}

// ─── Handle Fact Check ──────────────────────────────────────────────────────

async function handleFact(
  env: Env,
  ctx: ExecutionContext,
  chatId: number,
  messageId: number,
  userId: number,
  claim: string,
  message: TelegramMessage,
  threadId?: number,
): Promise<void> {
  // If no args but replying to a message, use that
  let factText = claim;
  if (!factText && message.reply_to_message?.text) {
    factText = message.reply_to_message.text;
  }

  if (!factText) {
    await sendMessage(env, chatId, "Напиши факт для проверки после /fact", messageId, threadId);
    return;
  }

  // Search for evidence
  const searchResults = await searchWeb(env, factText);
  const context = searchResults ?? "Не удалось найти информацию в интернете.";

  const prompt = `Пользователь задал вопрос/факт в чате. Используя найденную ниже справку, ответь ему четко, живо и по-пацански (без занудства "по результатам поиска"). Оцени достоверность:\n\nВопрос/Факт: ${factText}`;

  const response = await chatWithContext(env, prompt, context, userId, chatId);

  if (response) {
    const sent = await sendMessage(env, chatId, formatForTelegram(response), messageId, threadId);
    if (sent) ctx.waitUntil(saveBotMessage(env, chatId, response));
  } else {
    await handleProviderFailure(env, chatId, messageId, userId, factText, "fact", threadId);
  }
}

// ─── Handle Search ──────────────────────────────────────────────────────────

async function handleSearch(
  env: Env,
  ctx: ExecutionContext,
  chatId: number,
  messageId: number,
  userId: number,
  query: string,
  message: TelegramMessage,
  threadId?: number,
): Promise<void> {
  let searchQuery = query;

  // If replying to a message, use that as query
  if (!searchQuery && message.reply_to_message?.text) {
    searchQuery = message.reply_to_message.text;
  }

  // If still no query, generate from chat context
  if (!searchQuery) {
    const generated = await generateSearchQuery(env, chatId);
    if (!generated) {
      await sendMessage(env, chatId, "Напиши что искать после /search", messageId, threadId);
      return;
    }
    searchQuery = generated;
  }

  const searchResults = await searchWeb(env, searchQuery);

  if (!searchResults) {
    await sendMessage(env, chatId, "Ничего не нашел по этому запросу", messageId, threadId);
    return;
  }

  const response = await chatWithContext(
    env,
    `Используя найденную ниже информацию (поисковый запрос "${searchQuery}"), расскажи ответ живо, кратко и с уместным сарказмом. Ни в коем случае не пиши скучно или как робот.`,
    searchResults,
    userId,
    chatId,
  );

  if (response) {
    const sent = await sendMessage(env, chatId, formatForTelegram(response), messageId, threadId);
    if (sent) ctx.waitUntil(saveBotMessage(env, chatId, response));
  } else {
    await handleProviderFailure(env, chatId, messageId, userId, searchQuery, "search", threadId);
  }
}

// ─── Handle Weather ─────────────────────────────────────────────────────────

async function handleWeather(
  env: Env,
  ctx: ExecutionContext,
  chatId: number,
  messageId?: number,
  threadId?: number,
): Promise<void> {
  const weatherText = await fetchWeather(env);

  // Send raw weather data
  await sendMessage(env, chatId, formatForTelegram(weatherText), messageId, threadId);

  // Generate and send comment
  const comment = await generateWeatherComment(env, weatherText);
  if (comment) {
    const sent = await sendMessage(env, chatId, formatForTelegram(comment), undefined, threadId);
    if (sent) ctx.waitUntil(saveBotMessage(env, chatId, comment));
  }
}

// ─── Handle Help ────────────────────────────────────────────────────────────

async function handleHelp(
  env: Env,
  chatId: number,
  messageId: number,
  threadId?: number,
): Promise<void> {
  const helpText = `Доступные команды:

/search (или /найди) — поиск в интернете
/fact (или /факт) — проверка фактов
/weather (или /погода) — погода в Алматы
/help (или /помощь) — эта справка

Также можно просто написать "Амоня, найди..." или "Амоня, проверь..."`;

  await sendMessage(env, chatId, helpText, messageId, threadId);
}

// ─── Handle Reply to Message ────────────────────────────────────────────────

async function handleReply(
  env: Env,
  ctx: ExecutionContext,
  chatId: number,
  messageId: number,
  userId: number,
  text: string,
  message: TelegramMessage,
  threadId?: number,
): Promise<void> {
  const repliedText = message.reply_to_message!.text || message.reply_to_message!.caption || "";

  // Build context from forwarded message
  let forwardContext = "";
  if (message.reply_to_message!.forward_from_chat) {
    const channelTitle = message.reply_to_message!.forward_from_chat.title ?? "неизвестный канал";
    forwardContext = `пересланный пост из канала "${channelTitle}"`;
  } else if (message.reply_to_message!.forward_sender_name) {
    forwardContext = `пересланное сообщение от ${message.reply_to_message!.forward_sender_name}`;
  } else if (message.reply_to_message!.forward_from) {
    forwardContext = `пересланное сообщение от ${message.reply_to_message!.forward_from.first_name}`;
  } else {
    forwardContext = `сообщение`;
  }

  const intent = detectIntent(text);

  if (intent === "fact") {
    await handleFact(env, ctx, chatId, messageId, userId, repliedText, message, threadId);
    return;
  }

  if (intent === "search") {
    await handleSearch(env, ctx, chatId, messageId, userId, repliedText, message, threadId);
    return;
  }

  // Chat with reply context
  const combinedText = `[Я переслал тебе ${forwardContext} с текстом:\n"${repliedText}"]\n\nМой вопрос/комментарий к этому: ${text}`;
  const response = await chat(env, combinedText, userId, chatId);

  if (response) {
    const sent = await sendMessage(env, chatId, formatForTelegram(response), messageId, threadId);
    if (sent) ctx.waitUntil(saveBotMessage(env, chatId, response));
  } else {
    await handleProviderFailure(env, chatId, messageId, userId, text, "chat", threadId);
  }
}

// ─── Spontaneous Reactions ──────────────────────────────────────────────────

async function handleSpontaneous(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  userId: number,
): Promise<void> {
  const roll = Math.random() * 100;

  if (roll < 12) {
    // 12% chance: react with emoji
    await setMessageReaction(env, chatId, messageId);
  } else if (roll < 15) {
    // 3% chance (12-15% range): spontaneous comment
    const comment = await generateSpontaneousComment(env, text, userId, chatId);
    if (comment) {
      await sendMessage(env, chatId, formatForTelegram(comment), undefined, undefined);
    }
  }
}

// ─── Provider Failure Handling ──────────────────────────────────────────────

async function handleProviderFailure(
  env: Env,
  chatId: number,
  messageId: number,
  userId: number,
  text: string,
  intent: string,
  threadId?: number,
): Promise<void> {
  // Save retry task
  const retryTask: RetryTask = {
    chatId,
    messageId,
    userId,
    text,
    intent,
    threadId,
    attempt: 1,
  };

  const retryKey = `retry_task:${chatId}:${Date.now()}`;
  await env.KV.put(retryKey, JSON.stringify(retryTask), { expirationTtl: 300 }); // 5 min TTL

  await sendMessage(env, chatId, "⏳ Серверы перегружены, отвечу через минутку", messageId, threadId);
}

// ─── Daily Weather Cron ─────────────────────────────────────────────────────

async function handleDailyWeather(env: Env): Promise<void> {
  const chatId = parseInt(env.TELEGRAM_CHAT_ID, 10);
  if (!chatId || isNaN(chatId)) {
    console.error("Invalid TELEGRAM_CHAT_ID");
    return;
  }

  // Route to specific topic if thread ID is provided
  const threadId = env.WEATHER_THREAD_ID ? parseInt(env.WEATHER_THREAD_ID, 10) : undefined;

  await handleWeather(env, { waitUntil: () => {} } as unknown as ExecutionContext, chatId, undefined, threadId);
}

// ─── Process Retry Queue ───────────────────────────────────────────────────

async function processRetryQueue(env: Env): Promise<void> {
  try {
    const list = await env.KV.list({ prefix: "retry_task:" });

    if (list.keys.length === 0) return;

    // Process first retry task only
    const firstKey = list.keys[0];
    const raw = await env.KV.get(firstKey.name);
    if (!raw) return;

    const task = JSON.parse(raw) as RetryTask;

    // Delete the task immediately to prevent double-processing
    await env.KV.delete(firstKey.name);

    let response: string | null = null;

    switch (task.intent) {
      case "fact": {
        const searchResults = await searchWeb(env, task.text);
        const context = searchResults ?? "Не удалось найти информацию.";
        response = await chatWithContext(
          env,
          `Проверь факт: ${task.text}`,
          context,
          task.userId,
          task.chatId,
        );
        break;
      }

      case "search": {
        const searchResults = await searchWeb(env, task.text);
        if (searchResults) {
          response = await chatWithContext(
            env,
            `Суммаризируй: ${task.text}`,
            searchResults,
            task.userId,
            task.chatId,
          );
        }
        break;
      }

      default: {
        response = await chat(env, task.text, task.userId, task.chatId);
        break;
      }
    }

    if (response) {
      await sendMessage(env, task.chatId, formatForTelegram(response), task.messageId, task.threadId);
      await saveBotMessage(env, task.chatId, response);
    } else {
      await sendMessage(
        env,
        task.chatId,
        "Серверы все ещё недоступны, попробуйте позже",
        task.messageId,
        task.threadId,
      );
    }
  } catch (err) {
    console.error("Retry queue processing error:", err);
  }
}
