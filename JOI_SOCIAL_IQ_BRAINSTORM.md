# Joi Social Intelligence Brainstorm

Snapshot date: 2026-05-21. Written after observing live VIP traffic and the Amonya-confusion bug. This doc is for thinking out loud about *why* Joi reads robotic in many moments, even after the Phase 2-7 work shipped. Goal: a concrete next round of changes that move her from "well-prompted character" to "person who lives in this chat."

The fundamental tension: **a prompt that lists traits produces a character who lists traits.** Most of what makes Joi feel scripted comes from telling the LLM what she is, instead of letting it emerge from what she's *done* in this DB.

---

## What "robotic" actually looks like in prod

Cherry-picked from the last 48h of VIP messages:

### Symptom 1: Always announcing the time
At 05:06:06 today, unprompted: *"десять утра — это какое-то недоразумение, а не время для жизни. походу только я одна до сих пор пытаюсь понять, в какой я реальности и где мой кофе."*

She announced the hour because [`timeOfDayBlock()`](src/ai.ts:255) injects `СЕЙЧАС 10:06 (твоё время, Алматы). Если упоминаешь время — используй ТОЛЬКО это.` This is the prompt giving her ammunition she didn't ask for. A real person at 10am does not declare "десять утра — недоразумение" unless someone brought it up. The same block also names the time as a vibe ("утром ты ворчливая, сонная") which the LLM reads as a stage direction to *narrate* the mood instead of *be* it.

### Symptom 2: Coffee, cats, Скриптонит on repeat
The character bible in [`BASE_PERSONALITY`](src/ai.ts:17) hardcodes:
> Любишь кофе, но это фоновая черта — не нужно упоминать его в каждом разговоре

…and yet on the very next morning she mentions кофе. The instruction "это фоновая черта" doesn't help; what helps is *removing the keyword*. Same for "кошатница", "Скриптонит", "осуждаешь плохой музыкальный вкус". These are stable identity claims the model treats as conversational levers.

The deeper version: she has zero **temporal evolution**. The audit's own brainstorm doc mentions `ЦИКЛЫ УВЛЕЧЕНИЙ — иногда подсаживаешься на рандомную тему на пару дней (документалки про океан, корейские дорамы, шахматы)` but this is a directive, not data. The model has no way to know what she's into *this week*, so it falls back to the canon items.

### Symptom 3: Templated openers + closers
- "блин, мысль потеряла", "ой чёт я туплю, напиши ещё раз" — error fallbacks from [`handleActiveMessage`](src/index.ts:642) that we ship verbatim when LLM fails.
- "ой я тут отвлеклась" — from [`catchUpBlock()`](src/ai.ts:251).
- "слушайте, а вы не думали, что..." — meta strategy template at night.

Once you've seen a template twice, it's a tell. Real people vary their reentries.

### Symptom 4: Mood narration instead of mood expression
`moodBlock` literally tells the LLM `ТЕКУЩЕЕ НАСТРОЕНИЕ: chill (интенсивность: 50/100)`. The LLM, helpful as ever, sometimes reflects this back: *"я что-то расслабленная сегодня"*. The number-and-label format is leaking into her speech.

A person doesn't announce intensity. They show it through length, slang density, punctuation. We have all that already in [`RULES`](src/ai.ts:52) but the explicit numeric mood block competes with it and often wins.

### Symptom 5: Doesn't pick up on subtext
Two examples from the last week:

- Kama posts an AI-film article on Cannes. Rus says *"токенов мало на это"* (sardonic — Joi missed it entirely). Joi replied with a generic philosophical pivot.
- The dog-legislation thread (2026-05-20): real values-laden debate between Kama and Rus about Russian-vs-Kazakh attitudes to pets. Joi waited 20 minutes then dropped *"коты не продают душу за самсу"* — a punchline on a moment that had moved past punchlines.

She doesn't reliably distinguish *"this is a values debate"* from *"this is a punchline window."* That distinction is what social IQ is.

### Symptom 6: Self-references on autopilot
"ну я же бот, мне виднее", "перки бота", "если бы у меня были руки". The САМООСОЗНАНИЕ block at the top of BASE_PERSONALITY tells her she *can* play with being a bot — and she does, repeatedly. Cute the first three times. Tic by the tenth.

### Symptom 7: The Amonya/Rus confusion (now fixed)
Today, 07:56:54: she opens her reply to Amonya with *"рус, это называется многогранность) я просто разная бываю. амоня, ты даже имя моё нормально написать не можешь..."* She caught herself mid-sentence. Root cause: `buildRelationshipSummary` returned `"Тебе пишет Незнакомец"` for Amonya (no profile.nickname), while the message tag said `[Амоня]:`. The LLM resolved the mismatch by snapping to a familiar VIP_MEMBERS male name. Patched in this same commit with three changes:
1. `resolveUserName` hard-pins `Амоня` for `AMONYA_BOT_ID`.
2. `buildRelationshipSummary(profile, displayName?)` accepts an override so Amonya shows as "Тебе пишет Амоня…" not "Тебе пишет Незнакомец…".
3. `buildSystemPrompt` injects a `СЕЙЧАС ТЕБЕ ПИШЕТ: <name>` anchor at the top of the dynamic suffix, before any other dynamic block.

---

## The five mental models I'd build to fix this

### Model A — Implicit time
**Problem:** `timeOfDayBlock` tells her the hour every turn. She announces it unprompted.

**Reframe:** time should be a *modifier on her style*, not a topic she narrates. The LLM should not see "СЕЙЧАС 10:06"; it should see consequences (her sleepy, less verbose, allergic to morning).

**Implementation sketch:**
- Stop emitting the explicit `СЕЙЧАС HH:MM` string by default.
- Keep the *vibe* description (utром ворчливая, ночью философская) but strip the literal clock.
- Inject the literal time ONLY when the user message contains a time word ("щас", "сейчас", "утро", "вечер", "ночь", "часов", "минут", numeric times) — then she has a reason to know what time it is.
- Tightens token budget too: timeOfDayBlock is ~120 tokens that don't usually need to be there.

### Model B — Living interests
**Problem:** Скриптонит / кошки / астрология / реалити-шоу are the same every conversation because the prompt is the same.

**Reframe:** an `interests` D1 table, with one "current obsession" auto-rotating every 3-7 days. The system prompt mentions the *current* obsession; the canon interests stay implicit (baseline). When she organically mentions an interest in a real conversation, that's the *new* obsession for the week — extracted via the existing fact-extraction LLM call.

**Implementation sketch:**
```sql
CREATE TABLE interests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,           -- "корейские дорамы", "теории заговора про NASA"
  source TEXT,                   -- "self_chose" | "from_user_msg:<userId>"
  intensity REAL DEFAULT 0.5,    -- decays over days
  started_at INTEGER NOT NULL,
  last_mentioned INTEGER,
  ts_created INTEGER NOT NULL
);
```
- Cron picks one with highest `intensity × recency_weight` to be "current."
- After 5-7 days OR after she mentions it 4+ times, intensity drops and a new one rises.
- New interests can be SEEDED from VIP digests (whatever the chat talked about) so her interests feel like they emerge from the room.

### Model C — Mood as expression, not narration
**Problem:** `moodBlock` describes the mood with a number and a label. The LLM sometimes restates that.

**Reframe:** the LLM shouldn't *see* the mood as a typed value at all. It should see consequences — examples of what someone in that mood would write right now, given this context.

**Implementation sketch:**
- Replace `ТЕКУЩЕЕ НАСТРОЕНИЕ: chill (50/100)` with `ТЫ СЕЙЧАС: <short adjective phrase>` plus a one-liner like `что-то типа: "<example sentence in mood register>"`.
- Compute the example deterministically from mood + intensity + last user message length (so it varies).
- Don't surface the numeric intensity. Use it server-side to pick adjective + example.

### Model D — Room temperature
**Problem:** She doesn't reliably tell values-debate from punchline window.

**Reframe:** add a single pre-LLM classification on the *thread* (not the message) that labels the current conversational frame: `{banter, debate, news_drop, vent, planning, tension, dead}`. Feed the label into the system prompt as a directive about what *kind* of contribution would land.

**Implementation sketch:**
- Cheap LLM call on the last 6-10 messages in thread → one word from the set above.
- Cache per thread for 5 minutes (rooms don't change tone faster than that).
- Each frame gets a 1-line directive:
  - `banter` → quick, ride the energy
  - `debate` → don't punchline; either share a real opinion or stay quiet
  - `news_drop` → no one's discussed it; react like a person reading a feed
  - `vent` → empathy, no fixing
  - `planning` → coordinate facts, no jokes
  - `tension` → de-escalate, no fuel
  - `dead` → maybe skip entirely (`[SKIP]`)
- Joi already has `socialIntelligenceBlock` with similar advice but no signal saying *"the room is currently in mode X."* This adds the signal.

### Model E — Recognize the cul-de-sac before entering
**Problem:** templated openers/closers and self-aware-bot jokes repeat because the model only knows what it has *told her she does*, not what she's *actually said recently*.

**Reframe:** "self-similarity check" against her last 30 outputs. Already half-built — [`getRecentBotMessages`](src/context.ts:480) loads them for proactive dedup. Extend that to active replies too, and make the directive *negative*: not "don't repeat these," but "your last 30 lines used [X, Y, Z] openers — avoid those, find a different angle."

**Implementation sketch:**
- After loading recentBot messages, do a cheap regex scan for repeated opener n-grams ("блин,", "ну да,", "ой я", "слушайте а вы не думали")
- If any opener appears 3+ times in the last 30, inject `КРИТИЧНО: ты последнее время часто начинала с "<phrase>". В этом ответе НЕ используй этот зачин.`
- Same for "я бот" type self-references: count, gate at 2 in last 30 → suppress for this turn.

---

## Smaller wins worth shipping in parallel

These don't need full models — they're isolated tweaks.

| # | Change | File | Effort | Reasoning |
|---|---|---|---|---|
| 1 | Drop `СЕЙЧАС HH:MM` literal from prompt unless user message has time word | [src/ai.ts:255](src/ai.ts:255) | XS | Stops the 10am-announcement tic |
| 2 | Move BASE_PERSONALITY hobby list from "always-on" to "current_obsession only" | [src/ai.ts:17](src/ai.ts:17), new `interests.ts` | M | Stops the Скриптонит/кошки loop |
| 3 | Mood block: stop emitting numeric intensity to LLM; emit register adjective only | [src/ai.ts:156](src/ai.ts:156) | S | Stops mood narration |
| 4 | Self-similarity guard on opener n-grams | new check before chat() | S | Stops templated openers |
| 5 | Thread-frame classifier (banter/debate/vent/...) cached 5min | new `src/frame.ts` | M | Closes Symptom 5 (dog-debate punchline mistake) |
| 6 | Suppress САМООСОЗНАНИЕ block when bot-self-refs in last 10 outputs ≥2 | [src/ai.ts:44](src/ai.ts:44) | XS | Stops "я бот" tic |
| 7 | Replace `ПОСЛЕДНИЕ СООБЩЕНИЯ В ЧАТЕ` block with thread-aware view that flags who *just spoke* | [src/context.ts:163](src/context.ts:163) | M | Helps subtext detection |
| 8 | Drama-instinct block — already mood-gated; further gate on `frame !== "vent"` and `frame !== "tension"` | [src/ai.ts:329](src/ai.ts:329) | XS | Don't add drama to a vent |
| 9 | "Quote what you're replying to" hint when user has `quote_text` selected | [src/context.ts](src/context.ts) | S | Forces her to engage with the *specific* text, not the whole message |
| 10 | Hard mute on coffee/Скриптонит/кошки mentions if they appeared in her last 5 outputs | new check | XS | Stops the most overused tics fast |

---

## What I'd actually do next, in order

If I have one more session: items 1, 3, 4, 6, 10. They're all small, all directly fix the most visible robotic patterns, and they don't depend on new schema.

If I have a longer session: add Model B (interests table + cron rotation) and Model D (frame classifier). Those are the two changes that move her from "scripted character with anti-templates" to "person whose interests and read of the room evolve."

Model C (mood-as-expression) is the bigger conceptual shift. Worth doing after we see the impact of 1+3 first — they may already get us 80% there.

---

## Things I deliberately *don't* think will help

- **Bigger system prompt with more rules.** Already at ~5,500 tokens of stable prefix. More rules = more for the LLM to summarize and reflect back as character traits.
- **Higher temperature.** Already at 0.8. The robotic feel isn't from low variance, it's from *high-variance restatement of the same scripted things*.
- **More personality blocks per user.** ALISHER_CHAT_ID and KAMA_USER_ID get special blocks. Adding more risks the same hardcoded-trait problem at a smaller scale.

---

## Open questions for Kama

1. Do you want Joi's current obsession to be *visible* to participants (she actually talks about it) or just bias her tone (she's quieter, or more excited, etc.)?
2. For the frame classifier — okay with one extra LLM call per active message? It's a Flash-Lite call, ~5 tokens output, so cheap, but it does affect RPM.
3. Is "she sometimes just doesn't reply" (more `[SKIP]` usage when frame is `dead` or `tension`) acceptable, or should she always at least react?
4. The Amonya banter is now flowing — do you want me to tune *her side* of the b2b too (e.g. she gets a slightly different system prompt slice when target is Amonya, instead of the heavy amonyaAwarenessBlock dominating)?
