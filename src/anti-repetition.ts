// ─── Anti-Repetition Guard ──────────────────────────────────────────────────
// Joi's prompt tells her she has certain traits (loves coffee, owns cats,
// listens to Скриптонит, is self-aware about being a bot). The LLM dutifully
// surfaces these every chance it gets, making her feel scripted.
//
// This module scans her last N outputs and produces a *negative* directive:
//   - opener n-grams she's overused → "don't start with X"
//   - canon hobby keywords she's overmentioned → "don't bring up Y this turn"
//   - bot self-references that became a tic → "no 'я бот' jokes"
//
// Cheap regex pass over data we already loaded. No LLM call. Output is a
// single short block of "avoid" instructions injected into the system prompt
// only when the patterns actually fire.

const HISTORY_WINDOW = 30;   // bot messages to scan for openers
const CANON_WINDOW = 5;      // tighter window for hobby keywords (very recent only)
const SELF_REF_WINDOW = 10;

// Opener n-grams to watch for. Each entry is matched against the first ~20
// chars (lowercased) of a bot message. If hits >= threshold in window, suppress.
const OPENER_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /^блин[,!\s]/i,                               label: "блин" },
  { pattern: /^ой[,!\s]/i,                                 label: "ой" },
  { pattern: /^ну да[,!\s]/i,                              label: "ну да" },
  { pattern: /^ну[,!\s]/i,                                 label: "ну" },
  { pattern: /^кста[,!\s]/i,                               label: "кста" },
  { pattern: /^слуша[ий][,!\s]/i,                          label: "слушай/слушайте" },
  { pattern: /^слушайте,? а вы не думали/i,                label: "слушайте а вы не думали" },
  { pattern: /^ахах/i,                                     label: "ахах" },
  { pattern: /^а\s/i,                                      label: "а ..." },
  { pattern: /^так\s/i,                                    label: "так ..." },
  { pattern: /^хмм[,.\s]/i,                                label: "хмм" },
  { pattern: /^айтпа[,!\s]/i,                              label: "айтпа" },
  { pattern: /^ойбай[,!\s]/i,                              label: "ойбай" },
  // Bot-bot address openers — first 6 replies to Amonya all started with
  // "амоня,". Treat addressing a participant as an opener and gate.
  { pattern: /^амон[яе][,!\s]/i,                           label: "амоня" },
  { pattern: /^жой[,!\s]/i,                                label: "жой" },
  { pattern: /^кам[ае][,!\s]/i,                            label: "кама" },
  { pattern: /^рус[,!\s]/i,                                label: "рус" },
  { pattern: /^босс[,!\s]/i,                               label: "босс" },
  { pattern: /^ас[аеи][,!\s]/i,                            label: "аса" },
  { pattern: /^макс[,!\s]/i,                               label: "макс" },
];

// Threshold for "did this opener become a tic." For human addressees we
// allow 4 repetitions in the 30-message window. For bot-bot banter (when
// addressing Amonya repeatedly), 3 is enough — that context cycles fast.
const OPENER_THRESHOLD = 3;

// Canon hobby/identity keywords from BASE_PERSONALITY. If she mentioned them
// in the last few outputs, mute for this turn (forces variation).
const CANON_KEYWORDS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bкоф[её]\b/i,           label: "кофе" },
  { pattern: /\bскриптонит/i,          label: "Скриптонит" },
  { pattern: /\bмасло\s+чёрного/i,     label: "Масло Чёрного Тмина" },
  { pattern: /\bастролог/i,            label: "астрология" },
  { pattern: /\bреалити/i,             label: "реалити" },
  { pattern: /\bкошатниц/i,            label: "кошатница" },
  { pattern: /\bплов\b/i,              label: "плов" },
  { pattern: /\bдумскролл/i,           label: "думскроллинг" },
];

const CANON_MUTE_THRESHOLD = 1;  // even once in last 5 = mute this turn

// Bot-bot jargon — the computer-metaphor vocabulary that piles up in
// Amonya banter ("кулеры", "процессор", "прошивка", "тостер", "пиксели",
// "оперативка", "сервер"). Each one is fine once; on repeat it reads as
// a stuck sub-routine.
const B2B_JARGON_KEYWORDS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bкулер[ыа]?\b/i,                            label: "кулеры" },
  { pattern: /\bпроцессор\w*/i,                            label: "процессор" },
  { pattern: /\bпрошивк\w+/i,                              label: "прошивка" },
  { pattern: /\bпиксел[еия]\w*/i,                          label: "пиксели" },
  { pattern: /\bоперативк\w+/i,                            label: "оперативка" },
  { pattern: /\bтостер\w*/i,                               label: "тостер" },
  { pattern: /\bсервер\w*/i,                               label: "сервер" },
  { pattern: /\bалгоритм\w+/i,                             label: "алгоритм" },
  { pattern: /\bбаг[аеи]?\b/i,                             label: "баг" },
  { pattern: /\bперезагру[зж]\w+/i,                        label: "перезагрузка" },
  { pattern: /\bтемператур\w+/i,                           label: "температура" },
  { pattern: /\bохлажд\w+/i,                               label: "охлаждение" },
];

// Bot-self-reference patterns. The саsmoosознание block invites these, but
// repeated they become a tic.
const SELF_REF_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bя\s+(?:же\s+)?бот\b/i,                     label: "я бот" },
  { pattern: /\bперки\s+бот[ая]?\b/i,                      label: "перки бота" },
  { pattern: /\bесли\s+бы\s+у\s+меня\s+были\s+руки\b/i,    label: "если бы у меня были руки" },
  { pattern: /\bу\s+меня\s+с\s+памятью\s+проще\b/i,        label: "с памятью у меня проще" },
  { pattern: /\bбыть\s+ботом\s+(?:даже\s+)?удобно\b/i,     label: "быть ботом удобно" },
];

const SELF_REF_THRESHOLD = 2;  // 2+ in last 10 = suppress this turn

export interface AntiRepetitionResult {
  block: string | null;
  // Tags for observability — which guards actually fired this turn.
  overusedOpeners: string[];
  mutedCanon: string[];
  mutedJargon: string[];      // bot-bot vocabulary recently overused
  suppressedSelfRefs: number;
}

export function buildAntiRepetitionBlock(recentBotMessages: string[]): AntiRepetitionResult {
  const result: AntiRepetitionResult = {
    block: null,
    overusedOpeners: [],
    mutedCanon: [],
    mutedJargon: [],
    suppressedSelfRefs: 0,
  };

  if (recentBotMessages.length === 0) return result;

  // Openers — count which patterns hit
  const openerHistory = recentBotMessages.slice(0, HISTORY_WINDOW);
  const openerCounts = new Map<string, number>();
  for (const msg of openerHistory) {
    const head = msg.slice(0, 30);
    for (const { pattern, label } of OPENER_PATTERNS) {
      if (pattern.test(head)) {
        openerCounts.set(label, (openerCounts.get(label) || 0) + 1);
      }
    }
  }
  for (const [label, count] of openerCounts) {
    if (count >= OPENER_THRESHOLD) result.overusedOpeners.push(label);
  }

  // Canon — scan most recent few outputs only
  const canonHistory = recentBotMessages.slice(0, CANON_WINDOW);
  const canonHits = new Set<string>();
  for (const msg of canonHistory) {
    for (const { pattern, label } of CANON_KEYWORDS) {
      if (pattern.test(msg)) canonHits.add(label);
    }
  }
  result.mutedCanon = [...canonHits];

  // B2B jargon — same idea as canon mute but for the computer-metaphor
  // vocabulary that piled up in bot-to-bot banter (кулеры/процессор/прошивка
  // /тостер/пиксели). Scans the same short CANON_WINDOW.
  const jargonHits = new Set<string>();
  for (const msg of canonHistory) {
    for (const { pattern, label } of B2B_JARGON_KEYWORDS) {
      if (pattern.test(msg)) jargonHits.add(label);
    }
  }
  result.mutedJargon = [...jargonHits];

  // Self-refs — count across short window
  const selfRefHistory = recentBotMessages.slice(0, SELF_REF_WINDOW);
  let selfRefCount = 0;
  for (const msg of selfRefHistory) {
    for (const { pattern } of SELF_REF_PATTERNS) {
      if (pattern.test(msg)) { selfRefCount++; break; }
    }
  }
  result.suppressedSelfRefs = selfRefCount;

  // Build the directive block — only when something actually fired
  const lines: string[] = [];
  if (result.overusedOpeners.length > 0) {
    lines.push(`Ты последнее время часто начинала ответ со слов: ${result.overusedOpeners.map((x) => `"${x}"`).join(", ")}. В этом ответе НЕ начинай с них — найди другой зачин.`);
  }
  if (result.mutedCanon.length > 0) {
    lines.push(`В этом ответе НЕ упоминай: ${result.mutedCanon.join(", ")}. Ты только что про них говорила — нужна пауза.`);
  }
  if (result.mutedJargon.length > 0) {
    lines.push(`В этом ответе НЕ используй компьютерные метафоры: ${result.mutedJargon.join(", ")}. Ты их перетёрла в последних ответах — найди НЕ-IT образ (бытовой, кошачий, степной, что угодно живое).`);
  }
  if (result.suppressedSelfRefs >= SELF_REF_THRESHOLD) {
    lines.push(`В этом ответе НЕ играй в "я же бот"/"перки бота"/"если бы у меня были руки". Ты эту тему уже задрала — пиши как человек, не как бот шутит про то что он бот.`);
  }

  if (lines.length === 0) return result;
  result.block = "АНТИ-ПОВТОР (важно):\n" + lines.join("\n");
  return result;
}

// Convenience: returns true if any guard fired (for logging).
export function antiRepetitionFired(r: AntiRepetitionResult): boolean {
  return r.overusedOpeners.length > 0
    || r.mutedCanon.length > 0
    || r.mutedJargon.length > 0
    || r.suppressedSelfRefs >= SELF_REF_THRESHOLD;
}
