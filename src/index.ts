// ─── Joi Bot — Main Entry Point ─────────────────────────────────────────────

import type { Env, TelegramMessage } from "./config";
import { BOT_USERNAME, BOT_NAME_VARIANTS, VIP_GROUP_ID, VIP_PROACTIVE_TOPIC_ID, RUSTEM_USER_ID, AMONYA_BOT_ID } from "./config";
import { parseUpdate, sendMessage, sendSticker, sendChatAction, setMessageReaction, formatForTelegram } from "./telegram";
import { resolveUserName, registerActiveChat, getActiveChats, isFirstContact, isThirdPartyNicknameRequest } from "./users";
import { saveUserMessage, saveBotMessage, pruneOldMessages } from "./context";
import { detectCrisis, hasRecentCrisis, saveCrisisEvent } from "./crisis";
import type { CrisisDetection } from "./crisis";
import { buildSystemPrompt, buildProactiveSystemPrompt, chat, classifySentiment, batchAnalyzeMessage, detectNicknameRequest, detectReminderIntent, generateProactiveMessage } from "./ai";
import { getMood, maybeSwingMood, shiftMoodBySentiment, setOffended, clearOffense, cronMoodShift } from "./mood";
import { getProfile, saveProfile, adjustScore, setNickname, markFirstContactDone, updateSentimentAvg } from "./relationships";
import { checkRateLimit, checkRPMThrottle, trackLLMCall, enterBlackout, getBlackoutState, pruneExpiredRateLimits } from "./rate-limit";
import type { ThrottleLevel } from "./rate-limit";
import { shouldSendProactive, markProactiveSent, hasPendingFollowUp, scheduleFollowUp, selectProactiveStrategy, getStrategyHint } from "./proactive";
import { createReminder, getChatReminders, getDueReminders, processReminder, parseRelativeTime, computeReminderDates, findReminderByDescription } from "./reminders";
import { pickStickerForMood, extractStickerTag } from "./stickers";
import { getFacts, extractAndSaveFacts, getRecentActiveFacts, saveBatchFacts } from "./facts";
import { maybeBookmarkMoment, getEmotionalEvents } from "./memory";
import { buildSocialGraph, computeChatMood } from "./social";
import { shouldGenerateDigest, generateAndStoreDigest, pruneOldDigests } from "./digests";

// ─── Export Worker ──────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Webhook endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      const body = await request.json();
      const update = parseUpdate(body);

      if (update?.message) {
        ctx.waitUntil(
          handleMessage(env, ctx, update.message)
            .catch(err => console.error("[FATAL] handleMessage crashed:", err))
        );
      } else if (update?.edited_message) {
        ctx.waitUntil(
          handleEditedMessage(env, update.edited_message)
            .catch(err => console.error("[FATAL] handleEditedMessage crashed:", err))
        );
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
    const rateLimitResponses = [
      "всё, на сегодня я всё 💅 пиши @kamsqe если хочешь безлимит",
      "лимит на сегодня) напиши @kamsqe если что",
      "я устала на сегодня, сорри. @kamsqe для безлимита",
    ];
    const pick = rateLimitResponses[Math.floor(Math.random() * rateLimitResponses.length)];
    await sendMessage(env, chatId, pick, messageId, threadId);
    return;
  }

  // Resolve user name
  const userName = await resolveUserName(env, chatId, userId, firstName);

  // A2: Extract quote text (user selected specific text when replying)
  const quoteText = message.quote?.text || null;

  // Build display text for buffer (include media marker + quote if present)
  let bufferText = hasMedia
    ? (text ? `[${mediaType}] ${text}` : `[Отправил ${mediaType}]`)
    : text;
  // Prepend quote context so LLM sees what was specifically cited
  if (quoteText) {
    bufferText = `[цитата: "${quoteText.slice(0, 200)}"] ${bufferText}`;
  }

  // Extract forward/reply metadata for D1 context builder
  const isForwarded = !!(message.forward_from_chat || message.forward_from || message.forward_sender_name);
  const forwardSource = message.forward_from_chat?.title
    || message.forward_sender_name
    || message.forward_from?.first_name
    || null;
  const isSenderBot = message.from?.is_bot || message.from?.id === AMONYA_BOT_ID;
  const replyToMsgId = message.reply_to_message?.message_id || null;

  // Save message options (used later — we defer D1 save to avoid duplication in private context)
  const saveOpts: import("./context").SaveMessageOptions = {
    messageId: message.message_id,
    isBot: isSenderBot,
    isForwarded,
    forwardSource,
    replyToMessageId: replyToMsgId,
    threadId: threadId || null,
    quoteText,
  };

  // ─── Crisis Detection ────────────────────────────────────────────────────
  // Run before shouldReply so concern/crisis can force active response even if
  // the bot wasn't addressed directly. Skip for forwarded content (articles
  // about depression, etc. shouldn't trigger false positives).
  let crisis: CrisisDetection = { severity: "none", markers: [], confidence: "high", isJoking: false };
  if (text && !isForwarded && text.length >= 3) {
    try {
      crisis = await detectCrisis(env, text);
    } catch (err) {
      console.error("[crisis] detection failed:", err);
    }
  }
  const hasCrisis = crisis.severity === "concern" || crisis.severity === "crisis";

  // Determine if bot should respond
  // Crisis/concern forces active response even if not addressed (passive crisis)
  const normallyShouldReply = isPrivate || shouldRespondInGroup(message, text);
  const shouldReply = normallyShouldReply || hasCrisis;

  // C: Log crisis detection events (any non-none severity)
  if (crisis.severity !== "none") {
    console.log(JSON.stringify({
      event: "crisis_detected",
      chatId,
      userId,
      severity: crisis.severity,
      confidence: crisis.confidence,
      markers: crisis.markers.slice(0, 3),
      isJoking: crisis.isJoking,
      forceActive: !normallyShouldReply && hasCrisis,
      rustemBypass: userId === RUSTEM_USER_ID && chatId === VIP_GROUP_ID && hasCrisis,
    }));
  }

  if (!shouldReply) {
    // Save to D1 immediately for passive messages (won't cause duplication since no LLM call)
    if (bufferText) ctx.waitUntil(saveUserMessage(env, chatId, userId, userName, bufferText, saveOpts));

    // G2: Sample qualifying passive messages for full sentiment+facts analysis.
    // Without this, VIP sentimentAvg freezes (90%+ messages are passive, never sampled).
    // When sampled, we get sentiment (updates relationship) AND facts in one LLM call.
    // Bumped from len>=15 / 10% to len>=12 / 20% — month of prod showed only 11 facts
    // saved across 2 users, undersampling was starving memory.
    const shouldSample = text && text.length >= 12 && Math.random() < 0.2;
    if (shouldSample && text) {
      const repliedToBotPassive = message.reply_to_message?.from?.username === BOT_USERNAME;
      const botMsgIdPassive = repliedToBotPassive ? message.reply_to_message?.message_id : undefined;
      ctx.waitUntil(
        batchAnalyzeMessage(env, text).then(async (result) => {
          await trackLLMCall(env);
          // Update sentimentAvg (passive signal into relationship)
          if (result.sentiment.sentiment !== "neutral") {
            await updateSentimentAvg(env, chatId, userId, result.sentiment.sentiment);
          }
          // Save facts if any extracted
          if (result.facts.length > 0) {
            await saveBatchFacts(env, chatId, userId, result.facts);
          }
          // Bookmark life events / strong emotions from passive messages too —
          // gate is inside maybeBookmarkMoment (delta OR life-event keyword).
          if (text && text.length >= 6) {
            await maybeBookmarkMoment(env, chatId, userId, text, result.sentiment.sentiment, result.sentiment.delta)
              .catch((e) => console.error("[BG] passive bookmark:", e));
          }
          // D: Quality feedback when sampled passive is a reply to Joi's message
          if (repliedToBotPassive && result.sentiment.delta !== 0) {
            console.log(JSON.stringify({
              event: "quality_feedback",
              chatId,
              userId,
              botMessageId: botMsgIdPassive ?? null,
              userSentiment: result.sentiment.sentiment,
              userDelta: result.sentiment.delta,
              passive: true,
            }));
          }
        }).catch((e) => console.error("[BG] passive batch analyze:", e)),
      );
    } else if (text && text.length >= 25) {
      // Non-sampled: facts only (existing behavior)
      ctx.waitUntil(extractAndSaveFacts(env, chatId, userId, text).catch(e => console.error("[BG] extractFacts:", e)));
    }

    // Cheap life-event keyword check on EVERY passive message — bypasses the
    // 20% sample gate so we don't miss "развожусь" / "повысили" mentions just
    // because the dice roll went the other way. maybeBookmarkMoment handles
    // the LLM call internally only when the regex actually matches.
    if (text && text.length >= 6) {
      ctx.waitUntil(
        maybeBookmarkMoment(env, chatId, userId, text, "neutral", 0)
          .catch((e) => console.error("[BG] passive life-event bookmark:", e))
      );
    }

    // Passive processing: mood swing chance, spontaneous reactions
    const mood = await maybeSwingMood(env, chatId);
    ctx.waitUntil(handlePassiveInteraction(env, chatId, messageId, mood));

    // Maybe schedule a delayed follow-up
    if (Math.random() < 0.08 && text) {
      ctx.waitUntil(scheduleFollowUp(env, chatId, text));
    }
    return;
  }

  // ─── RPM Throttle Check ─────────────────────────────────────────────────────
  const throttle = await checkRPMThrottle(env);
  if (throttle === "blackout") {
    // Save user message so it's not lost from context, but don't respond
    if (bufferText) ctx.waitUntil(saveUserMessage(env, chatId, userId, userName, bufferText, saveOpts));
    ctx.waitUntil(enterBlackout(env, chatId));
    return;
  }

  // ─── Troll Cooldown (VIP group only) ────────────────────────────────────────
  if (chatId === VIP_GROUP_ID) {
    const isLowEffort = isLowEffortMessage(text, hasMedia, message);
    if (isLowEffort) {
      const streak = await getTrollStreak(env, chatId, userId);
      const threshold = userId === 271113269 ? 2 : 3; // Rustem gets shorter leash
      if (streak >= threshold) {
        // Skip entirely — she's done with this person's spam
        return;
      }
      ctx.waitUntil(incrementTrollStreak(env, chatId, userId));
    } else {
      // Real message — reset streak
      ctx.waitUntil(resetTrollStreak(env, chatId, userId));
    }
  }

  // ─── Bare Name Call Detection ("джой" without context) ────────────────────
  // Skip in private chats — every message is addressed to Joi, treat as real conversation
  if (!isPrivate && text && isBareNameCall(text)) {
    const bareResponses = ["ау?", "ау", "да?", "че", "м?", "слушаю", "хм?", "ну?"];
    const pick = bareResponses[Math.floor(Math.random() * bareResponses.length)];
    const sent = await sendMessage(env, chatId, pick, messageId, threadId);
    ctx.waitUntil(saveBotMessage(env, chatId, pick, sent?.message_id, threadId));
    return;
  }

  // ─── Media-only message (no text, addressed to Joi) ─────────────────
  // For media with caption, we continue to full handling with the caption as text.
  // For media WITHOUT text, we send media context to the LLM.
  const effectiveText = text || (hasMedia ? describeMedia(message) : "");
  if (!effectiveText) return;

  // ─── Rustem Mode (VIP group only) ────────────────────────────────────────
  // Crisis/concern bypasses Rustem Mode entirely — she should never be cold
  // to someone in genuine distress, even if that someone is Rustem.
  if (userId === RUSTEM_USER_ID && chatId === VIP_GROUP_ID) {
    // Save Rustem's message before handling so it's in context regardless of skip
    if (bufferText) ctx.waitUntil(saveUserMessage(env, chatId, userId, userName, bufferText, saveOpts));
    if (!hasCrisis) {
      const rustemResult = await handleRustemMessage(env, ctx, chatId, chatType, messageId, userId, userName, effectiveText, message, threadId, throttle);
      if (rustemResult) return; // handled (skipped or passive-aggressive reply sent)
    }
    // If crisis → fall through to normal active path (with crisis block injected)
  }

  // Save user message to D1 BEFORE the LLM call, but AFTER context is built.
  // For private chats: we must save AFTER buildPrivateContext to avoid duplication.
  // For group chats: the layered context builder uses separate layers, so saving first is fine.
  // Solution: save for group chats now, defer for private chats (handleActiveMessage does it).
  // (Rustem's message already saved above to avoid loss on skip)
  if (!isPrivate && bufferText && !(userId === RUSTEM_USER_ID && chatId === VIP_GROUP_ID)) {
    ctx.waitUntil(saveUserMessage(env, chatId, userId, userName, bufferText, saveOpts));
  }

  // Crisis event storage — dedupes by last-hour check internally
  if (hasCrisis) {
    ctx.waitUntil(saveCrisisEvent(env, chatId, userId, crisis).catch((e) => console.error("[crisis] save event:", e)));
  }

  // Active response path
  try {
    await handleActiveMessage(env, ctx, chatId, chatType, messageId, userId, userName, effectiveText, message, threadId, isPrivate, throttle, bufferText, saveOpts, crisis);
  } catch (err) {
    console.error("Message handling error:", err);
    // Make sure message is saved even on error
    if (isPrivate && bufferText) {
      ctx.waitUntil(saveUserMessage(env, chatId, userId, userName, bufferText, saveOpts));
    }
    const errorResponses = [
      "блин, мысль потеряла",
      "чёт я зависла, повтори",
      "секунду... а нет, забей, повтори ещё раз",
      "ой ну блин, что-то я туплю. повтори",
    ];
    const pick = errorResponses[Math.floor(Math.random() * errorResponses.length)];
    await sendMessage(env, chatId, pick, messageId, threadId);
  }
}

// ─── Edited Message Handler (A3) ──────────────────────────────────────────────
// When a user edits a message, silently update it in D1 so context stays accurate.
// No LLM call, no response — just keep the DB in sync.

async function handleEditedMessage(env: Env, message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const newText = message.text?.trim() || message.caption?.trim() || "";

  if (!newText || !messageId) return;

  await env.DB.prepare(
    `UPDATE messages SET content = ? WHERE chat_id = ? AND message_id = ?`,
  )
    .bind(newText, chatId, messageId)
    .run();
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

  // Bot name mentioned in text
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
  bufferText?: string,
  saveOpts?: import("./context").SaveMessageOptions,
  crisis?: CrisisDetection,
): Promise<void> {
  const text = stripBotMention(rawText);

  // Helper: save user message to D1 for private chats (called on early-return paths)
  const ensureSaved = () => {
    if (isPrivate && bufferText && saveOpts) {
      ctx.waitUntil(saveUserMessage(env, chatId, userId, userName, bufferText, saveOpts));
    }
  };

  // Load mood & profile
  const mood = await maybeSwingMood(env, chatId);
  const profile = await getProfile(env, chatId, userId);

  // Track activity hour for time patterns
  const currentHour = new Date().getUTCHours();
  profile.activityHours = [...(profile.activityHours || []).slice(-19), currentHour];
  
  // Check blackout recovery
  const blackout = await getBlackoutState(env, chatId);
  let missedMessages = 0;
  if (blackout.recoveryReady) {
    missedMessages = blackout.missedMessages;
  }

  // Batch analyze: sentiment + facts in ONE LLM call (skip in lazy mode)
  let sentimentResult: { sentiment: "positive" | "negative" | "neutral"; delta: number } = { sentiment: "neutral", delta: 0 };
  if (throttle !== "lazy" && text.length >= 10) {
    const batchResult = await batchAnalyzeMessage(env, text);
    sentimentResult = batchResult.sentiment;
    ctx.waitUntil(trackLLMCall(env));

    // Save facts from batch result (non-blocking)
    if (batchResult.facts.length > 0) {
      ctx.waitUntil(
        saveBatchFacts(env, chatId, userId, batchResult.facts).catch(e => console.error("[BG] batchFacts:", e))
      );
    }
  } else if (throttle !== "lazy") {
    // Short messages — just sentiment, no facts to extract
    sentimentResult = await classifySentiment(env, text);
    ctx.waitUntil(trackLLMCall(env));
  }

  // Apply sentiment changes to profile sequentially in memory
  if (sentimentResult.sentiment !== "neutral") {
    // 1. Update relationship score
    profile.score += sentimentResult.delta;
    
    // 2. Update sentiment rolling average (EMA alpha = 0.15)
    const val = sentimentResult.sentiment === "positive" ? 1.0 : -1.0;
    profile.sentimentAvg = profile.sentimentAvg === 0 ? val : (profile.sentimentAvg * 0.85) + (val * 0.15);
  }

  // Save profile ONCE after all modifications to prevent race conditions
  ctx.waitUntil(saveProfile(env, profile));

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

  // Bookmark significant emotional moments (non-blocking).
  // Always call when we have ANY text — the gate is inside maybeBookmarkMoment
  // (sentiment delta OR life-event keyword). Cheap regex pre-pass avoids LLM.
  if (text && text.length >= 6) {
    ctx.waitUntil(
      maybeBookmarkMoment(env, chatId, userId, text, sentimentResult.sentiment, sentimentResult.delta)
        .catch(e => console.error("[BG] bookmark:", e))
    );
  }

  // ─── Command Routing ─────────────────────────────────────────────────────

  const command = extractCommand(text);
  if (command) {
    switch (command.name) {
      case "help":
      case "помощь":
        ensureSaved();
        await handleHelp(env, chatId, messageId, threadId);
        return;
      case "reminders":
      case "напоминания":
        ensureSaved();
        await handleListReminders(env, chatId, messageId, threadId);
        return;
      case "start":
        if (isPrivate) {
          ensureSaved();
          await handleFirstContact(env, chatId, userId, messageId, threadId);
          return;
        }
    }
  }

  // ─── First Contact (private chat) ────────────────────────────────────────

  if (isPrivate && profile.isFirstContact) {
    ensureSaved();
    await handleFirstContact(env, chatId, userId, messageId, threadId);
    return;
  }

  // ─── Auto Name Capture (after first contact asked "как тебя зовут?") ─────
  if (isPrivate && !profile.nickname && !profile.nicknameOverride && text.length < 30 && !text.startsWith("/")) {
    const possibleName = text.trim()
      .replace(/^меня зовут\s*/i, "")
      .replace(/^я\s+/i, "")
      .replace(/^зови меня\s*/i, "")
      .replace(/[.!?,)(\s]+$/g, "")
      .trim();
    if (possibleName.length >= 2 && possibleName.length <= 20 && !possibleName.includes(" ")) {
      ensureSaved();
      await setNickname(env, chatId, userId, possibleName);
      const systemPrompt = buildSystemPrompt(mood, profile, possibleName, chatType as any, chatId, { currentUserId: userId });
      const response = await chat(env, `[Новый знакомый представился: "${possibleName}"]. Приветливо поздоровайся, используй имя, скажи что-нибудь приятное. Будь тёплой и дружелюбной.`, possibleName, systemPrompt, chatId, null, userId, null, threadId);
      if (response) await sendAndSave(env, ctx, chatId, response, messageId, threadId, mood);
      return;
    }
  }

  // ─── Nickname Change Detection ───────────────────────────────────────────

  // Check if someone is trying to change someone ELSE's nickname (VIP only)
  if (isThirdPartyNicknameRequest(text, userId, chatId)) {
    ensureSaved();
    const systemPrompt = buildSystemPrompt(mood, profile, userName, chatType as any, chatId, { currentUserId: userId });
    const response = await chat(env, `[${userName} пытается изменить чужое имя]: ${text}\n\n(Откажи мягко, скажи "пусть сам попросит" в своём стиле)`, userName, systemPrompt, chatId, null, userId, null, threadId);
    if (response) {
      await sendAndSave(env, ctx, chatId, response, messageId, threadId, mood);
    }
    return;
  }

  // Check for own nickname change request
  const nicknameRequest = await detectNicknameRequest(env, text);
  if (nicknameRequest) {
    ensureSaved();
    await setNickname(env, chatId, userId, nicknameRequest);
    const systemPrompt = buildSystemPrompt(mood, profile, nicknameRequest, chatType as any, chatId, { currentUserId: userId });
    const response = await chat(env, `[Пользователь попросил называть его "${nicknameRequest}"]. Подтверди что будешь так называть, скажи что-нибудь милое/игривое про новое имя.`, nicknameRequest, systemPrompt, chatId, null, userId, null, threadId);
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
      ensureSaved();
      await handleReminderCreation(env, ctx, chatId, userId, userName, messageId, threadId, mood, profile, chatType, reminderIntent, text);
      return;
    }
  }

  // ─── Cancel Reminder Detection ───────────────────────────────────────────

  const cancelKeywords = ["отмени напоминание", "удали напоминание", "cancel reminder"];
  if (cancelKeywords.some((kw) => text.toLowerCase().includes(kw))) {
    ensureSaved();
    await handleReminderCancel(env, chatId, userId, messageId, threadId, text, mood, profile, userName, chatType);
    return;
  }

  // ─── Default: Chat ───────────────────────────────────────────────────────

  const startChat = Date.now();
  // Load social intelligence + chat mood for VIP only (cost-gated — extra SQL).
  const isVip = chatId === VIP_GROUP_ID;
  const [facts, emotionalEvents, recentCrisis, socialGraph, chatMood, recentBotMessages] = await Promise.all([
    getFacts(env, chatId, userId),
    getEmotionalEvents(env, chatId, userId),
    hasRecentCrisis(env, chatId, userId),
    isVip ? buildSocialGraph(env, chatId, 7) : Promise.resolve([]),
    isVip ? computeChatMood(env, chatId, 48) : Promise.resolve(null),
    // Last 30 bot outputs power the anti-repetition guard (opener n-grams,
    // canon hobby mute, self-ref tic suppression).
    (await import("./context")).getRecentBotMessages(env, chatId, 30, threadId),
  ]);
  // Compute days since last message for rare speaker detection
  const daysSinceLastMessage = profile.lastInteraction
    ? Math.floor((Date.now() - profile.lastInteraction) / 86_400_000)
    : undefined;
  const systemPrompt = buildSystemPrompt(mood, profile, userName, chatType as any, chatId, { missedMessages, facts, currentUserId: userId, emotionalEvents, threadId, daysSinceLastMessage, crisis, recentCrisis, socialGraph, chatMood, currentMessage: text, recentBotMessages });

  // Send "typing" indicator before LLM call
  await sendChatAction(env, chatId, "typing", threadId);

  // The layered context builder in chat() handles reply chains via D1 thread walking
  const replyToMsgIdForContext = message.reply_to_message?.message_id || null;
  // A4: Pass reply text as fallback for when thread walker can't find the message in DB
  const replyFallbackText = message.reply_to_message?.text || message.reply_to_message?.caption || null;
  const response = await chat(env, text, userName, systemPrompt, chatId, replyToMsgIdForContext, userId, replyFallbackText, threadId);
  ctx.waitUntil(trackLLMCall(env));

  // Save user message to D1 AFTER context is built (prevents duplication in private chat context)
  if (isPrivate && bufferText && saveOpts) {
    ctx.waitUntil(saveUserMessage(env, chatId, userId, userName, bufferText, saveOpts));
  }

  if (response) {
    await sendAndSave(env, ctx, chatId, response, messageId, threadId, mood);
  } else {
    const fallbackResponses = [
      "хмм не могу сейчас сообразить, повтори попозже",
      "ой чёт я туплю, напиши ещё раз",
      "аа блин, мысль убежала. позже повтори",
    ];
    const pick = fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
    await sendMessage(env, chatId, pick, messageId, threadId);
  }

  // ─── Structured Logging ──────────────────────────────────────────────────
  console.log(JSON.stringify({
    event: "msg_processed",
    chatId,
    userId,
    chatType: isPrivate ? "private" : "group",
    threadId: threadId ?? null,
    mood: mood.mood,
    moodI: mood.intensity,
    sentiment: sentimentResult.sentiment,
    sentDelta: sentimentResult.delta,
    score: profile.score,
    sentAvg: Math.round(profile.sentimentAvg * 100) / 100,
    facts: facts.length,
    emoEvents: emotionalEvents.length,
    crisisSeverity: crisis?.severity ?? "none",
    recentCrisis: !!recentCrisis,
    socialEdges: socialGraph.length,
    responded: !!response,
    latency: Date.now() - startChat,
  }));

  // ─── Quality Feedback Signal ─────────────────────────────────────────────
  // If the user replied to Joi's message, their sentiment is feedback on how
  // well she handled the previous turn. Log so we can aggregate later.
  const repliedToBot = message.reply_to_message?.from?.username === BOT_USERNAME;
  if (repliedToBot && sentimentResult.delta !== 0) {
    const botMsgId = message.reply_to_message?.message_id;
    const botMsgTs = botMsgId
      ? await env.DB.prepare(
          `SELECT ts FROM messages WHERE chat_id = ? AND message_id = ? AND role = 'assistant' LIMIT 1`,
        ).bind(chatId, botMsgId).first<{ ts: number }>()
      : null;
    console.log(JSON.stringify({
      event: "quality_feedback",
      chatId,
      userId,
      botMessageId: botMsgId ?? null,
      userSentiment: sentimentResult.sentiment,
      userDelta: sentimentResult.delta,
      replyLatencyMs: botMsgTs ? Date.now() - botMsgTs.ts : null,
    }));
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

  // Send each part as a separate message, all replying to the original user message
  for (let i = 0; i < parts.length; i++) {
    const formatted = formatForTelegram(parts[i]);

    // Send typing indicator between split messages
    if (i > 0) {
      await sendChatAction(env, chatId, "typing", threadId);
      // Small delay between split messages (200-600ms)
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
    }

    const sent = await sendMessage(
      env, chatId, formatted,
      i === 0 ? messageId : undefined,
      threadId,
    );
    if (sent) {
      ctx.waitUntil(saveBotMessage(env, chatId, parts[i], sent.message_id, threadId));
    }
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
  const greeting = "Привет! 😊 Я Джой. Как мне тебя называть?";
  const sent = await sendMessage(env, chatId, greeting, messageId, threadId);
  // Save greeting to D1 so context builder can see it
  await saveBotMessage(env, chatId, greeting, sent?.message_id, threadId);
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
  const systemPrompt = buildSystemPrompt(mood, profile, userName, chatType as any, chatId, { currentUserId: userId });

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

// ─── Proactive Context Loader ────────────────────────────────────────────────
// Loads all context needed for a proactive message (facts, emotional events,
// digests, recent chat messages, crisis recency). Works for both private and
// group chats. Used by both follow-up and random-proactive branches of cron.

async function loadProactiveContext(
  env: Env,
  chatId: number,
  targetUserId: number,
  isPrivate: boolean,
): Promise<{
  facts: string[];
  emotionalEvents: Awaited<ReturnType<typeof getEmotionalEvents>>;
  recentCrisis: boolean;
  activityDigest?: string;
  latestDigest?: string;
  recentMessages?: string;
  socialGraph: Awaited<ReturnType<typeof buildSocialGraph>>;
  chatMood: Awaited<ReturnType<typeof computeChatMood>>;
}> {
  const isVip = chatId === VIP_GROUP_ID;
  const [facts, emotionalEvents, recentCrisis, socialGraph, chatMood] = await Promise.all([
    isPrivate ? getFacts(env, chatId, targetUserId) : getRecentActiveFacts(env, chatId),
    // For private: per-user events. For groups: load for userId=0 (synthetic "chat-wide" bucket,
    // will return empty since events are saved per real user — but keeps types consistent).
    isPrivate ? getEmotionalEvents(env, chatId, targetUserId) : Promise.resolve([]),
    isPrivate ? hasRecentCrisis(env, chatId, targetUserId) : Promise.resolve(false),
    isVip ? buildSocialGraph(env, chatId, 7) : Promise.resolve([]),
    isVip ? computeChatMood(env, chatId, 48) : Promise.resolve(null),
  ]);

  // Digests + recent messages: now loaded for BOTH private and group chats (G3 fix)
  const { buildActivityDigest, loadRecentDigests, formatDigestsForPrompt } = await import("./digests");
  const [activityDigest, latestDigest, recentRows] = await Promise.all([
    buildActivityDigest(env, chatId).then((d) => d || undefined),
    loadRecentDigests(env, chatId, 1).then((d) => formatDigestsForPrompt(d) || undefined),
    env.DB.prepare(
      `SELECT user_name, content FROM messages
       WHERE chat_id = ? AND role = 'user' AND is_bot = 0 AND is_forwarded = 0
       ORDER BY ts DESC LIMIT 8`,
    )
      .bind(chatId)
      .all<{ user_name: string; content: string }>(),
  ]);

  let recentMessages: string | undefined;
  if (recentRows.results && recentRows.results.length > 0) {
    const lines = recentRows.results.reverse().map(
      (m) => `[${m.user_name || "?"}]: ${m.content.slice(0, 150)}`,
    );
    recentMessages = `ПОСЛЕДНИЕ СООБЩЕНИЯ В ЧАТЕ (для контекста, чтобы ты не писала невпопад):\n${lines.join("\n")}`;
  }

  return { facts, emotionalEvents, recentCrisis, activityDigest, latestDigest, recentMessages, socialGraph, chatMood };
}

// ─── Cron Handler ────────────────────────────────────────────────────────────

async function handleCron(env: Env): Promise<void> {
  // Housekeeping: prune old messages (30-day retention) and expired rate limits
  await pruneOldMessages(env);
  await pruneExpiredRateLimits(env);
  await pruneOldDigests(env);

  const chatIds = await getActiveChats(env);

  for (const chatId of chatIds) {
    try {
    // 1. Drift mood + volatility
    await cronMoodShift(env, chatId);

    // 1b. Generate conversation digest (RPM-guarded) — for both group and private chats
    const isGroupChat = chatId < 0;
    {
      const throttle = await checkRPMThrottle(env);
      if (throttle !== "blackout") {
        const needsDigest = await shouldGenerateDigest(env, chatId, !isGroupChat);
        if (needsDigest) {
          await generateAndStoreDigest(env, chatId);
        }
      }
    }

    // 2. Check pending follow-ups
    const proactiveTopicId = chatId === VIP_GROUP_ID ? VIP_PROACTIVE_TOPIC_ID : undefined;
    const almatyHourNow = (new Date().getUTCHours() + 5) % 24;
    const followUp = await hasPendingFollowUp(env, chatId);
    if (followUp) {
      const mood = await getMood(env, chatId);
      const isPrivateChat = chatId > 0;
      const followUpUserId = isPrivateChat ? chatId : 0;
      const profile = await getProfile(env, chatId, followUpUserId);
      const chatType = isPrivateChat ? "private" : "supergroup";

      const proactiveCtx = await loadProactiveContext(env, chatId, followUpUserId, isPrivateChat);

      // Follow-up is always "reaction" — it's specifically continuing a conversation thread
      const strategyHint = getStrategyHint("reaction");

      const proactiveStartFollowUp = Date.now();
      const systemPrompt = buildProactiveSystemPrompt(mood, profile, profile.nickname || "", chatType as any, chatId, {
        facts: proactiveCtx.facts,
        activityDigest: proactiveCtx.activityDigest,
        latestDigest: proactiveCtx.latestDigest,
        recentMessages: proactiveCtx.recentMessages,
        emotionalEvents: proactiveCtx.emotionalEvents,
        recentCrisis: proactiveCtx.recentCrisis,
        strategyHint,
        socialGraph: proactiveCtx.socialGraph,
        chatMood: proactiveCtx.chatMood,
      });
      const response = await generateProactiveMessage(env, chatId, mood, systemPrompt, { threadId: proactiveTopicId });
      await trackLLMCall(env);
      if (response) {
        const { cleanText } = extractStickerTag(response);
        if (cleanText) {
          await sendMessage(env, chatId, formatForTelegram(cleanText), undefined, proactiveTopicId);
          await saveBotMessage(env, chatId, cleanText, undefined, proactiveTopicId);
          await markProactiveSent(env, chatId);
          // B: Log proactive sent
          console.log(JSON.stringify({
            event: "proactive_sent",
            chatId,
            threadId: proactiveTopicId ?? null,
            strategy: "reaction",
            isFollowUp: true,
            silenceHours: null,
            almatyHour: almatyHourNow,
            mood: mood.mood,
            responseLength: cleanText.length,
            latency: Date.now() - proactiveStartFollowUp,
          }));
        }
      }
    }

    // 3. Random proactive message (suppress at night 00:00-07:00 Almaty)
    const isNight = almatyHourNow >= 0 && almatyHourNow < 7;
    const { should: shouldProactive } = await shouldSendProactive(env, chatId);
    if (!isNight && shouldProactive) {
      const mood = await getMood(env, chatId);
      const isPrivate = chatId > 0;
      const proactiveUserId = isPrivate ? chatId : 0;
      const profile = await getProfile(env, chatId, proactiveUserId);
      const chatType = isPrivate ? "private" : "supergroup";

      const proactiveCtx = await loadProactiveContext(env, chatId, proactiveUserId, isPrivate);

      // Compute silence for strategy selection
      const { getLastUserMessageTs } = await import("./context");
      const lastUserTs = await getLastUserMessageTs(env, chatId);
      const silenceHours = lastUserTs ? (Date.now() - lastUserTs) / (1000 * 60 * 60) : 0;

      // C5+C7+C9: Select strategy based on context (time, mood, silence, emotional history)
      const strategy = selectProactiveStrategy({
        silenceHours,
        almatyHour: almatyHourNow,
        hasRecentCrisis: proactiveCtx.recentCrisis,
        hasEmotionalBookmarks: proactiveCtx.emotionalEvents.length > 0,
        moodState: mood.mood,
        isPrivate,
      });
      const strategyHint = getStrategyHint(strategy);

      const proactiveStartRandom = Date.now();
      const systemPrompt = buildProactiveSystemPrompt(mood, profile, profile.nickname || "", chatType, chatId, {
        facts: proactiveCtx.facts,
        activityDigest: proactiveCtx.activityDigest,
        latestDigest: proactiveCtx.latestDigest,
        recentMessages: proactiveCtx.recentMessages,
        emotionalEvents: proactiveCtx.emotionalEvents,
        recentCrisis: proactiveCtx.recentCrisis,
        strategyHint,
        socialGraph: proactiveCtx.socialGraph,
        chatMood: proactiveCtx.chatMood,
      });
      const response = await generateProactiveMessage(env, chatId, mood, systemPrompt, { threadId: proactiveTopicId });
      await trackLLMCall(env);
      if (response) {
        const { cleanText, emotion } = extractStickerTag(response);
        if (cleanText) {
          await sendMessage(env, chatId, formatForTelegram(cleanText), undefined, proactiveTopicId);
          await saveBotMessage(env, chatId, cleanText, undefined, proactiveTopicId);
        }
        if (emotion && chatId === VIP_GROUP_ID) {
          const sticker = pickStickerForMood(emotion as any);
          if (sticker) await sendSticker(env, chatId, sticker.fileId, undefined, proactiveTopicId);
        }
        await markProactiveSent(env, chatId);
        // B: Log proactive sent
        console.log(JSON.stringify({
          event: "proactive_sent",
          chatId,
          threadId: proactiveTopicId ?? null,
          strategy,
          isFollowUp: false,
          silenceHours: Math.round(silenceHours * 10) / 10,
          almatyHour: almatyHourNow,
          mood: mood.mood,
          responseLength: cleanText?.length ?? 0,
          hasEmotion: !!emotion,
          latency: Date.now() - proactiveStartRandom,
        }));
      }
    }
    } catch (err) {
      console.error(`[CRON] Error processing chat ${chatId}:`, err);
    }
  }

  // 4. Check due reminders (outside chat loop — getDueReminders is global)
  try {
    const dueReminders = await getDueReminders(env);
    for (const reminder of dueReminders) {
      const mood = await getMood(env, reminder.chatId);
      const profile = await getProfile(env, reminder.chatId, reminder.userId);
      const userName = await resolveUserName(env, reminder.chatId, reminder.userId);
      const chatType = reminder.chatId > 0 ? "private" : "supergroup";
      const systemPrompt = buildSystemPrompt(mood, profile, userName, chatType as any, reminder.chatId);

      const response = await chat(
        env,
        `[НАПОМИНАНИЕ для ${userName}: "${reminder.description}"]. Напомни в своём стиле, обращаясь к ${userName}.`,
        userName, systemPrompt, reminder.chatId,
      );
      await trackLLMCall(env);

      if (response) {
        await sendMessage(env, reminder.chatId, formatForTelegram(response));
        await saveBotMessage(env, reminder.chatId, response);
      }

      await processReminder(env, reminder);
    }
  } catch (err) {
    console.error("[CRON] Error processing reminders:", err);
  }
}

// ─── Rustem Mode ────────────────────────────────────────────────────────────
// Mostly ignore Rustem in VIP group. Occasionally send passive-aggressive replies.
// Track apologies — gradual forgiveness over time.

const RUSTEM_PASSIVE_RESPONSES = [
  ")", "👍", "ок", "мхм", "ну ладно", "ага", "угу", "ну-ну", "...",
  "Ок.", "Хорошо.", "Понятно.",
];

const APOLOGY_KEYWORDS = [
  "прости", "извини", "сорри", "sorry", "мой косяк", "я был неправ",
  "не хотел", "прошу прощения", "виноват", "пардон",
];

async function getRustemApologyState(env: Env): Promise<{ count: number; firstAt: number; lastAt: number }> {
  const key = `rustem_apologies:${VIP_GROUP_ID}`;
  const row = await env.DB.prepare(
    `SELECT data FROM rate_limits WHERE key = ?`,
  ).bind(key).first<{ data: string | null }>();
  if (row?.data) return JSON.parse(row.data);
  return { count: 0, firstAt: 0, lastAt: 0 };
}

async function trackRustemApology(env: Env): Promise<void> {
  const key = `rustem_apologies:${VIP_GROUP_ID}`;
  const state = await getRustemApologyState(env);
  state.count += 1;
  if (state.firstAt === 0) state.firstAt = Date.now();
  state.lastAt = Date.now();
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, data, expires_at) VALUES (?, 0, ?, ?)
     ON CONFLICT(key) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
  ).bind(key, JSON.stringify(state), expiresAt).run();
}

async function resetRustemApologies(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM rate_limits WHERE key = ?`)
    .bind(`rustem_apologies:${VIP_GROUP_ID}`).run();
}

function isRustemApology(text: string): boolean {
  const lower = text.toLowerCase();
  return APOLOGY_KEYWORDS.some((kw) => lower.includes(kw));
}

async function handleRustemMessage(
  env: Env,
  ctx: ExecutionContext,
  chatId: number,
  chatType: string,
  messageId: number,
  userId: number,
  userName: string,
  text: string,
  message: TelegramMessage,
  threadId?: number,
  throttle: ThrottleLevel = "normal",
): Promise<boolean> {
  // Track apologies
  if (isRustemApology(text)) {
    ctx.waitUntil(trackRustemApology(env));
  }

  // Calculate response chance based on apology state
  const apologyState = await getRustemApologyState(env);
  const daysSinceFirst = apologyState.firstAt > 0
    ? (Date.now() - apologyState.firstAt) / (1000 * 60 * 60 * 24)
    : 0;

  // Base: 5% chance to respond. +5% per apology (max +45%), but only if apologies span 3+ days
  let responseChance = 0.05;
  if (apologyState.count >= 1 && daysSinceFirst >= 3) {
    responseChance += Math.min(apologyState.count * 0.05, 0.45);
  }

  // If he just apologized right now, slightly boost chance for this message
  if (isRustemApology(text)) {
    responseChance = Math.max(responseChance, 0.30);
  }

  const roll = Math.random();

  if (roll > responseChance) {
    // Ignore — but sometimes react with an emoji
    if (Math.random() < 0.08) {
      await setMessageReaction(env, chatId, messageId, "annoyed");
    }
    return true; // handled (skipped)
  }

  // Decide: passive-aggressive one-liner (75%) or full LLM response (25%)
  if (Math.random() < 0.75) {
    const pick = RUSTEM_PASSIVE_RESPONSES[Math.floor(Math.random() * RUSTEM_PASSIVE_RESPONSES.length)];
    await sendMessage(env, chatId, pick, messageId, threadId);
    ctx.waitUntil(saveBotMessage(env, chatId, pick, undefined, threadId));
    return true;
  }

  // Full LLM response — but with cold/hostile tone enforced
  // Let it fall through to handleActiveMessage with normal flow
  return false;
}

// ─── Troll Cooldown Helpers ──────────────────────────────────────────────────

function isLowEffortMessage(text: string, hasMedia: boolean, message: TelegramMessage): boolean {
  // Stickers, GIFs, media-only = low effort
  if (!text && hasMedia) return true;
  if (message.sticker) return true;
  if (message.animation) return true;

  // Very short text (<5 chars), likely gibberish or one-word trolling
  if (text && text.length < 5 && !text.includes("напомни")) return true;

  // Gibberish detection: mostly non-Cyrillic, non-Latin meaningful text
  if (text && text.length > 0) {
    const meaningful = text.replace(/[^a-zA-Zа-яА-ЯёЁ\s]/g, "").trim();
    if (meaningful.length < 3 && text.length > 3) return true;
  }

  return false;
}

const TROLL_STREAK_TTL = 600; // 10 minutes — streak resets after inactivity

async function getTrollStreak(env: Env, chatId: number, userId: number): Promise<number> {
  const key = `troll:${chatId}:${userId}`;
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT count FROM rate_limits WHERE key = ? AND expires_at > ?`,
  ).bind(key, now).first<{ count: number }>();
  return row?.count || 0;
}

async function incrementTrollStreak(env: Env, chatId: number, userId: number): Promise<void> {
  const key = `troll:${chatId}:${userId}`;
  const expiresAt = Date.now() + TROLL_STREAK_TTL * 1000;
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET count = count + 1, expires_at = excluded.expires_at`,
  ).bind(key, expiresAt).run();
}

async function resetTrollStreak(env: Env, chatId: number, userId: number): Promise<void> {
  const key = `troll:${chatId}:${userId}`;
  await env.DB.prepare(`DELETE FROM rate_limits WHERE key = ?`).bind(key).run();
}
