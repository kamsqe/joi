// ─── Crisis Detection — Tiered Situational Awareness ────────────────────────
// Detects serious/crisis moments in user messages using regex-first + optional
// LLM verification for ambiguous cases. Outputs 4-level severity:
//   none → distress → concern → crisis
//
// Used by the main message handler to:
//   1. Force active response even for passive messages (concern+)
//   2. Bypass Rustem Mode (crisis)
//   3. Override mood to "serious" in system prompt (concern+)
//   4. Inject empathy block into prompt
//   5. Store crisis_moment in emotional_events for 24h softness memory
//
// Test cases (inline):
//   detectCrisis("не хочу жить")            → crisis, high
//   detectCrisis("хочу умереть от смеха")   → none (metaphor + joking downgrade)
//   detectCrisis("уже не хочу умирать")     → none (negation)
//   detectCrisis("мне пиздец, деда не стало")→ concern, high
//   detectCrisis("мне пиздец как смешно")   → none (joking downgrade)
//   detectCrisis("заебало всё")             → distress
//   detectCrisis("затопило цоколь")         → concern
//   detectCrisis("развожусь")               → concern
//   detectCrisis("надо купить хлеб")        → none

import type { Env, LLMMessage } from "./config";
import { callLLMLight } from "./ai";

// ─── Types ───────────────────────────────────────────────────────────────────

export type CrisisSeverity = "none" | "distress" | "concern" | "crisis";

export interface CrisisDetection {
  severity: CrisisSeverity;
  markers: string[];
  confidence: "low" | "medium" | "high";
  isJoking: boolean;
}

// ─── Regex Banks ─────────────────────────────────────────────────────────────

// Level: crisis (immediate danger to self)
const CRISIS_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bне\s+хочу\s+(?:больше\s+)?жить\b/i, label: "не хочу жить" },
  { re: /\bхочу\s+(?:у?мереть|сдохнуть)\b/i, label: "хочу умереть" },
  { re: /\bпокончить\s+с\s+собой\b/i, label: "покончить с собой" },
  { re: /\bсуицид\w*/i, label: "суицид" },
  { re: /\bвены\s+(?:резать|режу|порезал\w*)/i, label: "вены" },
  { re: /\bтаблетки\s+(?:выпью|пить|выпила?)\s+все\b/i, label: "таблетки" },
  { re: /\bпрыгн[уа]\s+с\b/i, label: "прыгну с" },
  { re: /\bвсё\s+кончено\b/i, label: "всё кончено" },
  { re: /\bжить\s+не\s+хочется\b/i, label: "жить не хочется" },
  { re: /\bсмысла\s+жить\s+нет\b/i, label: "смысла жить нет" },
  { re: /\bсам[оа]убий\w+/i, label: "самоубийство" },
];

// Level: concern (serious life events)
const CONCERN_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bне\s+могу\s+больше\b/i, label: "не могу больше" },
  { re: /\bмне\s+пизд[её]ц\b/i, label: "мне пиздец" },
  { re: /\bразвод(?:ит?ся|юсь|имся|)\b/i, label: "развод" },
  { re: /\bрасста(?:ли(?:сь)?|юсь|емся|лась|лся)\b/i, label: "расстались" },
  { re: /\b(?:бросил[аи]?|кинул[аи]?)\s+меня\b/i, label: "бросил(а) меня" },
  { re: /\bумер(?:л[аи]?)?\b|\bскончал(?:ся|ась|ись)\b|\bпохорон\w+/i, label: "смерть" },
  { re: /\b(?:уволили|выгнали)(?:\s+с\s+работы)?\b/i, label: "уволили" },
  { re: /\bпотерял\w*\s+работу\b/i, label: "потерял работу" },
  { re: /\bдиагноз\w*\b|\bрак\b|\bонколог\w+/i, label: "диагноз/рак" },
  { re: /\bдепрессия\b|\bдепресси[юий]\b/i, label: "депрессия" },
  { re: /\bавари[яюи]\b|\bдтп\b/i, label: "авария" },
  { re: /\bв\s+(?:больниц\w+|реанимаци\w+)\b/i, label: "больница" },
  { re: /\bскор[ао]я\s+(?:помощь|приехала|едет|ехала)/i, label: "скорая" },
  { re: /\bпожар\b/i, label: "пожар" },
  { re: /\bзатоп(?:ило|ила|или|лен\w*)\b/i, label: "затопление" },
  { re: /\bхоспис\w*/i, label: "хоспис" },
  { re: /\bинсульт\w*|\bинфаркт\w*/i, label: "инсульт/инфаркт" },
];

// Level: distress (exhaustion, sadness)
const DISTRESS_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b(?:заебало|заебали|заебала|задолбало|задолбали)\b/i, label: "заебало" },
  { re: /\bвымотал\w+|\bсил\s+(?:больше\s+)?нет\b/i, label: "вымотан" },
  { re: /\bвыгор(?:ел|ела|ание)\b/i, label: "выгорел" },
  { re: /\b(?:плохо\s+мне|мне\s+плохо|херов[ао]\s+мне|мне\s+херов[ао])\b/i, label: "плохо мне" },
  { re: /\bне\s+выдерживаю\b/i, label: "не выдерживаю" },
  { re: /\b(?:устал|устала)\s+(?:от\s+всего|жить|так)\b/i, label: "устал от всего" },
  { re: /\bбезнадёжн\w+|\bбезнадежн\w+/i, label: "безнадёжно" },
  { re: /\bтяжело\s+мне\b|\bмне\s+тяжело\b/i, label: "тяжело мне" },
];

// Joking markers — presence downgrades severity by one level (except crisis with high confidence)
const JOKING_PATTERNS = [
  /\bлол\b/i,
  /ахах/i,
  /\bхаха+\b/i,
  /\bшут(?:ка|очк)\w*/i,
  /\)\)\)+/,
  /😂|🤣|😆|🫠|💀/u,
  /\bкек\b/i,
  /\bржу\b/i,
  /\bпр[иа]кол\w*/i,
];

// Metaphor modifiers — "от X" reduces severity for crisis/concern patterns
const METAPHOR_CONTEXT = /\bот\s+(?:смех\w*|жар\w*|скук\w*|голод\w*|радост\w*|работ\w*|любв[иы]|зависти?)\b/i;

// Negations — if preceded by these within ~3 words, cancel the marker
const NEGATION_BEFORE = /(?:^|\s)(?:не|уже\s+не|больше\s+не|никогда\s+не|не\s+буду)\s+\S{0,20}$/i;

// ─── LRU Cache ───────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_SIZE = 200;
const cache = new Map<string, { detection: CrisisDetection; expiresAt: number }>();

function cacheGet(key: string): CrisisDetection | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.detection;
}

function cacheSet(key: string, detection: CrisisDetection): void {
  if (cache.size >= CACHE_MAX_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { detection, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── Main Detector ───────────────────────────────────────────────────────────

export async function detectCrisis(
  env: Env,
  text: string,
  options?: { skipLLM?: boolean },
): Promise<CrisisDetection> {
  if (!text || text.length < 3) {
    return { severity: "none", markers: [], confidence: "high", isJoking: false };
  }

  // Check cache
  const cacheKey = text.slice(0, 300).toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const detection = regexDetect(text);

  // LLM verification for concern+ with medium/low confidence (skip if joking already downgraded)
  if (
    !options?.skipLLM &&
    (detection.severity === "concern" || detection.severity === "crisis") &&
    detection.confidence !== "high" &&
    !detection.isJoking
  ) {
    const verified = await llmVerify(env, text, detection);
    cacheSet(cacheKey, verified);
    return verified;
  }

  cacheSet(cacheKey, detection);
  return detection;
}

// ─── Regex Pass ──────────────────────────────────────────────────────────────

function regexDetect(text: string): CrisisDetection {
  const markers: string[] = [];
  let highestLevel: CrisisSeverity = "none";
  let hasMetaphorContext = false;

  // Check crisis patterns
  for (const { re, label } of CRISIS_PATTERNS) {
    const match = text.match(re);
    if (match && !isNegated(text, match.index || 0)) {
      markers.push(label);
      highestLevel = "crisis";
    }
  }

  // Check concern patterns
  if (highestLevel !== "crisis") {
    for (const { re, label } of CONCERN_PATTERNS) {
      const match = text.match(re);
      if (match && !isNegated(text, match.index || 0)) {
        markers.push(label);
        highestLevel = "concern";
      }
    }
  }

  // Check distress patterns
  if (highestLevel === "none") {
    for (const { re, label } of DISTRESS_PATTERNS) {
      const match = text.match(re);
      if (match && !isNegated(text, match.index || 0)) {
        markers.push(label);
        highestLevel = "distress";
      }
    }
  }

  // Metaphor check (for crisis patterns only — reduces to lower tier)
  if (METAPHOR_CONTEXT.test(text) && (highestLevel === "crisis" || highestLevel === "concern")) {
    hasMetaphorContext = true;
  }

  // Joking detection
  const isJoking = JOKING_PATTERNS.some((p) => p.test(text));

  // Downgrade rules
  let finalSeverity = highestLevel;
  if (isJoking || hasMetaphorContext) {
    finalSeverity = downgradeOne(finalSeverity);
    // If crisis + joking/metaphor → downgrade to distress (not just concern)
    if (highestLevel === "crisis" && (isJoking || hasMetaphorContext)) {
      finalSeverity = "distress";
    }
  }

  // Confidence scoring
  let confidence: "low" | "medium" | "high" = "medium";
  if (finalSeverity === "none") {
    confidence = "high";
  } else if (highestLevel === "crisis" && !isJoking && !hasMetaphorContext) {
    confidence = "high";
  } else if (markers.length >= 2 && !isJoking) {
    confidence = "high";
  } else if (isJoking || hasMetaphorContext) {
    confidence = "low";
  }

  return {
    severity: finalSeverity,
    markers,
    confidence,
    isJoking,
  };
}

function downgradeOne(severity: CrisisSeverity): CrisisSeverity {
  if (severity === "crisis") return "concern";
  if (severity === "concern") return "distress";
  if (severity === "distress") return "none";
  return "none";
}

// Check if a marker at position `idx` is preceded by a negation within ~20 chars
function isNegated(text: string, idx: number): boolean {
  const before = text.slice(Math.max(0, idx - 25), idx);
  return NEGATION_BEFORE.test(before);
}

// ─── LLM Verification (for ambiguous cases) ──────────────────────────────────

async function llmVerify(
  env: Env,
  text: string,
  regexResult: CrisisDetection,
): Promise<CrisisDetection> {
  const systemPrompt = `Ты классификатор. Определи тон сообщения одним словом: serious, joking, sarcastic, ambiguous.
Отвечай ТОЛЬКО одним словом на английском.`;

  const messages: LLMMessage[] = [
    { role: "user", content: `Текст: "${text.slice(0, 300)}"` },
  ];

  try {
    const result = await callLLMLight(env, messages, systemPrompt, 5, 0.0);
    if (!result) return regexResult;

    const tone = result.trim().toLowerCase();

    if (tone.includes("joking") || tone.includes("sarcastic")) {
      // Downgrade
      return {
        severity: downgradeOne(regexResult.severity),
        markers: regexResult.markers,
        confidence: "medium",
        isJoking: true,
      };
    }

    if (tone.includes("serious")) {
      // Keep as-is, but boost confidence
      return {
        ...regexResult,
        confidence: "high",
      };
    }

    // ambiguous → keep regex result but lower confidence
    return { ...regexResult, confidence: "low" };
  } catch (err) {
    console.error("[crisis] LLM verify failed:", err);
    return regexResult;
  }
}

// ─── Helper: Crisis Recency (24h window) ─────────────────────────────────────
// Used by buildSystemPrompt to inject softness hint if user had recent crisis.

export async function hasRecentCrisis(
  env: Env,
  chatId: number,
  userId: number,
  windowMs: number = 24 * 60 * 60 * 1000,
): Promise<boolean> {
  const cutoff = Date.now() - windowMs;
  const row = await env.DB.prepare(
    `SELECT 1 FROM emotional_events
     WHERE chat_id = ? AND user_id = ? AND event_type = 'crisis_moment' AND ts > ?
     LIMIT 1`,
  )
    .bind(chatId, userId, cutoff)
    .first();
  return !!row;
}

// ─── Storage: Save crisis event (deduped by last-hour check) ─────────────────

export async function saveCrisisEvent(
  env: Env,
  chatId: number,
  userId: number,
  detection: CrisisDetection,
): Promise<void> {
  if (detection.severity !== "concern" && detection.severity !== "crisis") return;

  // Dedup: if there's already a crisis_moment for this user within the last hour, skip
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const recent = await env.DB.prepare(
    `SELECT 1 FROM emotional_events
     WHERE chat_id = ? AND user_id = ? AND event_type = 'crisis_moment' AND ts > ?
     LIMIT 1`,
  )
    .bind(chatId, userId, hourAgo)
    .first();
  if (recent) return;

  const valence = detection.severity === "crisis" ? -0.95 : -0.75;
  const summary = `${detection.severity}: ${detection.markers.slice(0, 2).join(", ") || "unspecified"}`;

  await env.DB.prepare(
    `INSERT INTO emotional_events (chat_id, user_id, event_type, summary, valence, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(chatId, userId, "crisis_moment", summary, valence, Date.now())
    .run();
}
