// ─── Joi Bot — Main Entry Point ─────────────────────────────────────────────

import type { Env, TelegramMessage } from "./config";
import { BOT_USERNAME, BOT_NAME_VARIANTS, VIP_GROUP_ID } from "./config";
import { parseUpdate, sendMessage, sendSticker, sendChatAction, setMessageReaction, formatForTelegram } from "./telegram";
import { resolveUserName, registerActiveChat, getActiveChats, isFirstContact, isThirdPartyNicknameRequest } from "./users";
import { saveUserMessage, saveBotMessage } from "./context";
import { buildSystemPrompt, chat, classifySentiment, detectNicknameRequest, detectReminderIntent, generateProactiveMessage } from "./ai";
import { getMood, maybeSwingMood, shiftMoodBySentiment, setOffended, clearOffense, cronMoodShift } from "./mood";
import { getProfile, adjustScore, setNickname, markFirstContactDone } from "./relationships";
import { checkRateLimit, RATE_LIMIT_MESSAGE, checkRPMThrottle, trackLLMCall, enterBlackout, getBlackoutState } from "./rate-limit";
import type { ThrottleLevel } from "./rate-limit";
import { shouldSendProactive, markProactiveSent, checkPendingFollowUp, scheduleFollowUp } from "./proactive";
import { createReminder, getChatReminders, getDueReminders, processReminder, parseRelativeTime, computeReminderDates, findReminderByDescription } from "./reminders";
import { pickStickerForMood, extractStickerTag } from "./stickers";

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
      return new Response("Joi bot is running 💅", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleCron(env));
  },
};

// ─── Message Handler ────────────────────────────────────────────────────────

async function handleMessage(env: Env, ctx: ExecutionContext, message: TelegramMessage): Promise<void> {
  const userId = message.from?.id;
  if (!userId) return;

  const chatId = message.chat.id;
  const chatType = message.chat.type;
  const messageId = message.message_id;
  const threadId = message.message_thread_id;
  const isPrivate = chatType === "private";
  const firstName = message.from?.first_name;

  // Extract text from message or caption, detect media
  const text = message.text?.trim() || message.caption?.trim() || "";
  const mediaType = detectMediaType(message);
  const hasMedia = mediaType !== null;

  // Nothing to work with — no text and no media
  if (!text && !hasMedia) return;

  // Register chat for cron proactive messaging
  ctx.waitUntil(registerActiveChat(env, chatId));

  // Rate limit check (before any LLM calls)
  const { allowed } = await checkRateLimit(env, chatId);
  if (!allowed) {
    await sendMessage(env, chatId, RATE_LIMIT_MESSAGE, messageId, threadId);
    return;
  }

  // Resolve user name
  const userName = await resolveUserName(env, chatId, userId, firstName);

  // Build display text for buffer (include media marker if present)
  const bufferText = hasMedia
    ? (text ? `[${mediaType}] ${text}` : `[Отправил ${mediaType}]`)
    : text;

  // Save message to buffer
  if (bufferText) ctx.waitUntil(saveUserMessage(env, chatId, userId, userName, bufferText));

  // Determine if bot should respond
  const shouldReply = isPrivate || shouldRespondInGroup(message, text);

  if (!shouldReply) {
    // Passive processing: mood swing chance, spontaneous reactions
    const mood = await maybeSwingMood(env, chatId);
    ctx.waitUntil(handlePassiveInteraction(env, chatId, messageId, mood));

    // Maybe schedule a delayed follow-up
    const buffer = await import("./context").then((m) => m.getBuffer(env, chatId));
    if (Math.random() < 0.08 && text) {
      ctx.waitUntil(scheduleFollowUp(env, chatId, text, buffer.length));
    }
    return;
  }

  // ─── RPM Throttle Check ─────────────────────────────────────────────────────
  const throttle = await checkRPMThrottle(env);
  if (throttle === "blackout") {
    // Silently save to buffer but don't respond
    ctx.waitUntil(enterBlackout(env, chatId));
    return;
  }

  // ─── Bare Name Call Detection ("джой" without context) ────────────────────
  if (text && isBareNameCall(text)) {
    const bareResponses = ["ау?", "ау", "да?", "че", "м?", "слушаю", "хм?", "ну?"];
    const pick = bareResponses[Math.floor(Math.random() * bareResponses.length)];
    await sendMessage(env, chatId, pick, messageId, threadId);
    ctx.waitUntil(saveBotMessage(env, chatId, pick));
    return;
  }

  // ─── Media-only message (no text, addressed to Joi) ─────────────────
  // For media with caption, we continue to full handling with the caption as text.
  // For media WITHOUT text, we send media context to the LLM.
  const effectiveText = text || (hasMedia ? describeMedia(message) : "");
  if (!effectiveText) return;

  // Active response path
  try {
    await handleActiveMessage(env, ctx, chatId, chatType, messageId, userId, userName, effectiveText, message, threadId, isPrivate, throttle);
  } catch (err) {
    console.error("Message handling error:", err);
    await sendMessage(env, chatId, "Что-то пошло не так... 😅", messageId, threadId);
  }
}

// ─── Detect Media Type ────────────────────────────────────────────────────────

function detectMediaType(message: TelegramMessage): string | null {
  if (message.photo && message.photo.length > 0) return "фото";
  if (message.video) return "видео";
  if (message.animation) return "гифку";
  if (message.voice) return "голосовое";
  if (message.video_note) return "кругляш";
  if (message.audio) return "аудио";
  if (message.document) return "файл";
  if (message.sticker) return `стикер${message.sticker.emoji ? " " + message.sticker.emoji : ""}`;
  return null;
}

// ─── Describe Media for LLM ───────────────────────────────────────────────────

function describeMedia(message: TelegramMessage): string {
  if (message.photo) return "[Отправил фото]";
  if (message.video) return "[Отправил видео]";
  if (message.animation) return "[Отправил гифку]";
  if (message.voice) return `[Отправил голосовое (${message.voice.duration}с)]`;
  if (message.video_note) return "[Отправил кругляш]";
  if (message.audio) return `[Отправил аудио${message.audio.title ? ": " + message.audio.title : ""}]`;
  if (message.document) return `[Отправил файл${message.document.file_name ? ": " + message.document.file_name : ""}]`;
  if (message.sticker) return `[Отправил стикер${message.sticker.emoji ? " " + message.sticker.emoji : ""}]`;
  return "[Отправил медиа]";
}

// ─── Bare Name Call Detection ───────────────────────────────────────────────

const BARE_GREETINGS = ["\u043f\u0440\u0438\u0432\u0435\u0442", "хе\u0439", "х\u0430\u0439", "з\u0434\u0430\u0440\u043e\u0432\u0430", "\u043f\u0440\u0438\u0432", "\u0445\u0435\u043b\u043b\u043e", "hi", "hey"];

function isBareNameCall(text: string): boolean {
  const lower = text.toLowerCase().trim();

  // Just the bot's name: "джой", "жой", "joi", "@joicanfixthat_bot"
  for (const variant of BOT_NAME_VARIANTS) {
    if (lower === variant) return true;
  }

  // Name + simple greeting: "джой привет", "привет джой"
  let stripped = lower;
  for (const variant of BOT_NAME_VARIANTS) {
    stripped = stripped.replace(variant, "").trim();
  }
  // After removing bot name, only a greeting or nothing remains
  if (stripped === "") return true;
  if (BARE_GREETINGS.includes(stripped)) return true;
  // Handle comma/excl: "джой, привет" → "привет"
  const cleanStripped = stripped.replace(/^[,!\s]+|[,!\s]+$/g, "");
  if (BARE_GREETINGS.includes(cleanStripped)) return true;

  return false;
}

// ─── Should Respond in Group ─────────────────────────────────────────────────

function shouldRespondInGroup(message: TelegramMessage, text: string): boolean {
  // Commands
  if (text.startsWith("/")) return true;

  // Reply to Joi's own message
  if (message.reply_to_message?.from?.username === BOT_USERNAME) return true;

  // Bot name mentioned
  const lower = text.toLowerCase();
  return BOT_NAME_VARIANTS.some((variant) => lower.includes(variant));
}

// ─── Strip Bot Mention ──────────────────────────────────────────────────────

function stripBotMention(text: string): string {
  let result = text;

  result = result.replace(new RegExp(`@${BOT_USERNAME}`, "gi"), "");

  for (const variant of BOT_NAME_VARIANTS) {
    result = result.replace(new RegExp(variant, "gi"), "");
  }

  result = result.replace(/\s+/g, " ").trim();
  return result;
}

// ─── Active Message Handling ─────────────────────────────────────────────────

async function handleActiveMessage(
  env: Env,
  ctx: ExecutionContext,
  chatId: number,
  chatType: string,
  messageId: number,
  userId: number,
  userName: string,
  rawText: string,
  message: TelegramMessage,
  threadId?: number,
  isPrivate?: boolean,
  throttle: ThrottleLevel = "normal",
): Promise<void> {
  const text = stripBotMention(rawText);

  // Load mood & profile
  const mood = await maybeSwingMood(env, chatId);
  const profile = await getProfile(env, chatId, userId);

  // Check blackout recovery
  const blackout = await getBlackoutState(env, chatId);
  let missedMessages = 0;
  if (blackout.recoveryReady) {
    missedMessages = blackout.missedMessages;
  }

  // Classify sentiment toward Joi — skip in lazy mode to save RPM
  let sentimentResult: { sentiment: "positive" | "negative" | "neutral"; delta: number } = { sentiment: "neutral", delta: 0 };
  if (throttle !== "lazy") {
    sentimentResult = await classifySentiment(env, text);
    ctx.waitUntil(trackLLMCall(env));
  }

  // Update relationship score
  if (sentimentResult.delta !== 0) {
    ctx.waitUntil(adjustScore(env, chatId, userId, sentimentResult.delta));
  }

  // Update mood based on sentiment
  if (sentimentResult.sentiment !== "neutral") {
    ctx.waitUntil(shiftMoodBySentiment(env, chatId, sentimentResult.sentiment));

    // Check for offense (big negative delta)
    if (sentimentResult.delta <= -10) {
      ctx.waitUntil(setOffended(env, chatId, userId, text));
    }

    // Check for apology clearing offense
    if (sentimentResult.sentiment === "positive" && mood.offendedBy === userId) {
      ctx.waitUntil(clearOffense(env, chatId));
    }
  }

  // ─── Command Routing ─────────────────────────────────────────────────────

  const command = extractCommand(text);
  if (command) {
    switch (command.name) {
      case "help":
      case "помощь":
        await handleHelp(env, chatId, messageId, threadId);
        return;
      case "reminders":
      case "напоминания":
        await handleListReminders(env, chatId, messageId, threadId);
        return;
      case "start":
        if (isPrivate) {
          await handleFirstContact(env, chatId, userId, messageId, threadId);
          return;
        }
    }
  }

  // ─── First Contact (private chat) ────────────────────────────────────────

  if (isPrivate && profile.isFirstContact) {
    await handleFirstContact(env, chatId, userId, messageId, threadId);
    return;
  }

  // ─── Nickname Change Detection ───────────────────────────────────────────

  // Check if someone is trying to change someone ELSE's nickname (VIP only)
  if (isThirdPartyNicknameRequest(text, userId, chatId)) {
    const systemPrompt = buildSystemPrompt(mood, profile, userName, chatType as any, chatId);
    const response = await chat(env, `[${userName} пытается изменить чужое имя]: ${text}\n\n(Откажи мягко, скажи "пусть сам попросит" в своём стиле)`, userName, systemPrompt, chatId);
    if (response) {
      await sendAndSave(env, ctx, chatId, response, messageId, threadId, mood);
    }
    return;
  }

  // Check for own nickname change request
  const nicknameRequest = await detectNicknameRequest(env, text);
  if (nicknameRequest) {
    await setNickname(env, chatId, userId, nicknameRequest);
    const systemPrompt = buildSystemPrompt(mood, profile, nicknameRequest, chatType as any, chatId);
    const response = await chat(env, `[Пользователь попросил называть его "${nicknameRequest}"]. Подтверди что будешь так называть, скажи что-нибудь милое/игривое про новое имя.`, nicknameRequest, systemPrompt, chatId);
    if (response) {
      await sendAndSave(env, ctx, chatId, response, messageId, threadId, mood);
    }
    return;
  }

  // ─── Reminder Detection ──────────────────────────────────────────────────

  const reminderKeywords = ["напомни", "напоминай", "напоминание", "remind"];
  if (reminderKeywords.some((kw) => text.toLowerCase().includes(kw))) {
    const reminderIntent = await detectReminderIntent(env, text);
    if (reminderIntent.isReminder) {
      await handleReminderCreation(env, ctx, chatId, userId, userName, messageId, threadId, mood, profile, chatType, reminderIntent, text);
      return;
    }
  }

  // ─── Cancel Reminder Detection ───────────────────────────────────────────

  const cancelKeywords = ["отмени напоминание", "удали напоминание", "cancel reminder"];
  if (cancelKeywords.some((kw) => text.toLowerCase().includes(kw))) {
    await handleReminderCancel(env, chatId, userId, messageId, threadId, text, mood, profile, userName, chatType);
    return;
  }

  // ─── Default: Chat ───────────────────────────────────────────────────────

  const systemPrompt = buildSystemPrompt(mood, profile, userName, chatType as any, chatId, { missedMessages });

  // Send "typing" indicator before LLM call
  await sendChatAction(env, chatId, "typing", threadId);

  // Include reply context if replying to something
  let chatText = text;
  if (message.reply_to_message?.text || message.reply_to_message?.caption) {
    const repliedText = message.reply_to_message!.text || message.reply_to_message!.caption || "";
    chatText = `[Ответ на сообщение: "${repliedText.slice(0, 300)}"]\n\n${text}`;
  }

  const response = await chat(env, chatText, userName, systemPrompt, chatId);
  ctx.waitUntil(trackLLMCall(env));

  if (response) {
    await sendAndSave(env, ctx, chatId, response, messageId, threadId, mood);
  } else {
    await sendMessage(env, chatId, "Не могу сейчас ответить... попробуй позже 😔", messageId, threadId);
  }
}

// ─── Send Response + Handle Stickers + Message Splitting ─────────────────────

const REACTION_ONLY_TAG = "[REACTION_ONLY]";
const SKIP_TAG = "[SKIP]";

async function sendAndSave(
  env: Env,
  ctx: ExecutionContext,
  chatId: number,
  response: string,
  messageId?: number,
  threadId?: number,
  mood?: import("./config").MoodData,
): Promise<void> {
  const trimmed = response.trim();

  // Check for skip — true silence
  if (trimmed === SKIP_TAG || trimmed.startsWith(SKIP_TAG)) {
    return;
  }

  // Check for reaction-only response
  if (trimmed.startsWith(REACTION_ONLY_TAG) || trimmed.length <= 2) {
    // Just react with emoji, no text
    await setMessageReaction(env, chatId, messageId || 0, mood?.mood);
    return;
  }

  // Extract sticker tag if present
  const { cleanText, emotion } = extractStickerTag(response);

  // Split by --- separator (LLM-generated message splits)
  const parts = cleanText.split(/\n?---\n?/).map((p) => p.trim()).filter((p) => p.length > 0);

  // Send each part as a separate message
  for (let i = 0; i < parts.length; i++) {
    const isFirst = i === 0;
    const formatted = formatForTelegram(parts[i]);

    // Send typing indicator between split messages
    if (i > 0) {
      await sendChatAction(env, chatId, "typing", threadId);
      // Small delay between split messages (200-600ms)
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
    }

    const sent = await sendMessage(
      env, chatId, formatted,
      isFirst ? messageId : undefined,
      threadId,
    );
    if (sent) ctx.waitUntil(saveBotMessage(env, chatId, parts[i]));
  }

  // Send sticker if tagged (works in VIP group; sticker-only = no text parts)
  if (emotion && chatId === VIP_GROUP_ID) {
    const sticker = pickStickerForMood(emotion as any);
    if (sticker) {
      await sendSticker(env, chatId, sticker.fileId, undefined, threadId);
    }
  }

  // If no text and no sticker was sent, fall back to reaction
  if (parts.length === 0 && !emotion) {
    await setMessageReaction(env, chatId, messageId || 0, mood?.mood);
  }
}

// ─── Passive Interaction (not addressed) ─────────────────────────────────────

async function handlePassiveInteraction(
  env: Env,
  chatId: number,
  messageId: number,
  mood: import("./config").MoodData,
): Promise<void> {
  const roll = Math.random() * 100;

  if (roll < 10) {
    // 10% chance: mood-influenced emoji reaction
    await setMessageReaction(env, chatId, messageId, mood.mood);
  }
}

// ─── First Contact Flow ──────────────────────────────────────────────────────

async function handleFirstContact(
  env: Env,
  chatId: number,
  userId: number,
  messageId: number,
  threadId?: number,
): Promise<void> {
  await markFirstContactDone(env, chatId, userId);
  await sendMessage(
    env,
    chatId,
    "Привет! 😊 Я Джой. Как мне тебя называть?",
    messageId,
    threadId,
  );
}

// ─── Help ────────────────────────────────────────────────────────────────────

async function handleHelp(
  env: Env,
  chatId: number,
  messageId: number,
  threadId?: number,
): Promise<void> {
  await sendMessage(env, chatId, `Я Джой 💅

Просто пиши мне — я отвечу (в личке всегда, в группе когда позовёшь).

Напоминания:
"напомни мне позвонить маме завтра"
/reminders — список напоминаний

Называй как хочешь — скажи "зови меня [имя]" и я запомню ✨`, messageId, threadId);
}

// ─── Reminder Creation ───────────────────────────────────────────────────────

async function handleReminderCreation(
  env: Env,
  ctx: ExecutionContext,
  chatId: number,
  userId: number,
  userName: string,
  messageId: number,
  threadId: number | undefined,
  mood: import("./config").MoodData,
  profile: import("./config").UserProfile,
  chatType: string,
  intent: { description?: string; when?: string; recurrence?: string },
  originalText?: string,
): Promise<void> {
  const systemPrompt = buildSystemPrompt(mood, profile, userName, chatType as any, chatId);

  if (!intent.description) {
    const response = await chat(env, "[Пользователь хочет создать напоминание но не указал о чём]. Спроси что напомнить.", userName, systemPrompt, chatId);
    if (response) await sendAndSave(env, ctx, chatId, response, messageId, threadId, mood);
    return;
  }

  // Try to parse the time
  const remindAt = intent.when ? parseRelativeTime(intent.when) : null;

  if (!remindAt) {
    const response = await chat(env, `[Пользователь хочет напоминание: "${intent.description}" но не указал когда или дату не удалось распознать: "${intent.when || "не указано"}"]. Спроси когда именно напомнить (дату и время).`, userName, systemPrompt, chatId);
    if (response) await sendAndSave(env, ctx, chatId, response, messageId, threadId, mood);
    return;
  }

  // Check if user wants multi-reminders ("за неделю, за день и в этот день")
  const fullText = (originalText || intent.description || "").toLowerCase();
  const wantsMulti = fullText.includes("за неделю") || fullText.includes("за день") ||
    fullText.includes("напомни нам за") || fullText.includes("напомни за");

  const formatDate = (ts: number) => new Date(ts).toLocaleString("ru-RU", {
    timeZone: "Asia/Almaty", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  });

  if (wantsMulti) {
    // Create multiple reminders: week before, day before, day of
    const dates = computeReminderDates(remindAt);
    const createdDates: string[] = [];

    for (const d of dates) {
      await createReminder(env, chatId, userId, `${intent.description} (${d.label})`, d.ts, "once");
      createdDates.push(`${d.label}: ${formatDate(d.ts)}`);
    }

    const dateList = createdDates.join(", ");
    const response = await chat(
      env,
      `[Создано ${dates.length} напоминаний: ${dateList}]. Подтверди создание, перечисли ТОЧНЫЕ даты которые я тебе дал. НЕ придумывай другие даты.`,
      userName, systemPrompt, chatId,
    );
    if (response) await sendAndSave(env, ctx, chatId, response, messageId, threadId, mood);
  } else {
    // Single reminder
    await createReminder(
      env, chatId, userId,
      intent.description,
      remindAt,
      (intent.recurrence as any) || "once",
    );

    const response = await chat(
      env,
      `[Напоминание создано: "${intent.description}" на ${formatDate(remindAt)}${intent.recurrence && intent.recurrence !== "once" ? `, повтор: ${intent.recurrence}` : ""}]. Подтверди создание, назови ТОЧНУЮ дату которую я тебе дал. НЕ придумывай другую дату.`,
      userName, systemPrompt, chatId,
    );
    if (response) await sendAndSave(env, ctx, chatId, response, messageId, threadId, mood);
  }
}

// ─── List Reminders ──────────────────────────────────────────────────────────

async function handleListReminders(
  env: Env,
  chatId: number,
  messageId: number,
  threadId?: number,
): Promise<void> {
  const reminders = await getChatReminders(env, chatId);

  if (reminders.length === 0) {
    await sendMessage(env, chatId, "Напоминаний пока нет 🤷‍♀️", messageId, threadId);
    return;
  }

  const lines = reminders.map((r, i) => {
    const date = new Date(r.remindAt).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" });
    const rec = r.recurrence !== "once" ? ` (${r.recurrence})` : "";
    return `${i + 1}. ${r.description} — ${date}${rec}`;
  });

  await sendMessage(env, chatId, `📋 Напоминания:\n${lines.join("\n")}`, messageId, threadId);
}

// ─── Cancel Reminder ─────────────────────────────────────────────────────────

async function handleReminderCancel(
  env: Env,
  chatId: number,
  userId: number,
  messageId: number,
  threadId: number | undefined,
  text: string,
  mood: import("./config").MoodData,
  profile: import("./config").UserProfile,
  userName: string,
  chatType: string,
): Promise<void> {
  // Extract what to cancel
  const searchText = text.replace(/отмени напоминание|удали напоминание|cancel reminder/gi, "").trim();

  if (!searchText) {
    await sendMessage(env, chatId, "Какое напоминание отменить? 🤔", messageId, threadId);
    return;
  }

  const found = await findReminderByDescription(env, chatId, searchText);
  if (found) {
    await import("./reminders").then((m) => m.deleteReminder(env, chatId, found.id));
    await sendMessage(env, chatId, `Ок, отменила напоминание "${found.description}" ✅`, messageId, threadId);
  } else {
    await sendMessage(env, chatId, `Не нашла такое напоминание 🤷‍♀️`, messageId, threadId);
  }
}

// ─── Command Extraction ──────────────────────────────────────────────────────

function extractCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith("/")) return null;

  const match = text.match(/^\/(\w+)\s*([\s\S]*)/);
  if (!match) return null;

  return {
    name: match[1].toLowerCase(),
    args: match[2].trim(),
  };
}

// ─── Cron Handler ────────────────────────────────────────────────────────────

async function handleCron(env: Env): Promise<void> {
  const chatIds = await getActiveChats(env);

  for (const chatId of chatIds) {
    // 1. Drift mood + volatility
    await cronMoodShift(env, chatId);

    // 2. Check pending follow-ups
    const followUp = await checkPendingFollowUp(env, chatId);
    if (followUp.shouldSend && followUp.topicSnapshot) {
      const mood = await getMood(env, chatId);
      // Build a generic system prompt for proactive message
      const profile = await getProfile(env, chatId, 0);
      const systemPrompt = buildSystemPrompt(mood, profile, "", "group", chatId);
      const response = await generateProactiveMessage(env, chatId, mood, systemPrompt);
      if (response) {
        const { cleanText } = extractStickerTag(response);
        if (cleanText) {
          await sendMessage(env, chatId, formatForTelegram(cleanText));
          await saveBotMessage(env, chatId, cleanText);
          await markProactiveSent(env, chatId);
        }
      }
    }

    // 3. Random proactive message (suppress at night 00:00-07:00 Almaty)
    const almatyHour = (new Date().getUTCHours() + 5) % 24;
    const isNight = almatyHour >= 0 && almatyHour < 7;
    const isPrivate = chatId > 0; // Telegram: positive IDs = private, negative = group
    if (!isNight && await shouldSendProactive(env, chatId, isPrivate)) {
      const mood = await getMood(env, chatId);
      const profile = await getProfile(env, chatId, 0);
      const chatType = isPrivate ? "private" : "supergroup";
      const systemPrompt = buildSystemPrompt(mood, profile, "", chatType, chatId);
      const response = await generateProactiveMessage(env, chatId, mood, systemPrompt);
      if (response) {
        const { cleanText, emotion } = extractStickerTag(response);
        if (cleanText) {
          await sendMessage(env, chatId, formatForTelegram(cleanText));
          await saveBotMessage(env, chatId, cleanText);
        }
        if (emotion && chatId === VIP_GROUP_ID) {
          const sticker = pickStickerForMood(emotion as any);
          if (sticker) await sendSticker(env, chatId, sticker.fileId);
        }
        await markProactiveSent(env, chatId);
      }
    }

    // 4. Check due reminders
    const dueReminders = await getDueReminders(env, [chatId]);
    for (const reminder of dueReminders) {
      const mood = await getMood(env, chatId);
      const profile = await getProfile(env, chatId, reminder.userId);
      const userName = await resolveUserName(env, chatId, reminder.userId);
      const chatType = chatId > 0 ? "private" : "supergroup";
      const systemPrompt = buildSystemPrompt(mood, profile, userName, chatType as any, chatId);

      const response = await chat(
        env,
        `[НАПОМИНАНИЕ для ${userName}: "${reminder.description}"]. Напомни в своём стиле, обращаясь к ${userName}.`,
        userName, systemPrompt, chatId,
      );

      if (response) {
        await sendMessage(env, chatId, formatForTelegram(response));
        await saveBotMessage(env, chatId, response);
      }

      await processReminder(env, reminder);
    }
  }
}
