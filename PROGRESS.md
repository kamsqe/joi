# Joi — Progress Log

Snapshot of what's been done and what's next. Updated after each major phase.

Last updated: **Apr 17, 2026** after Phase 7 deploy.

---

## Current Status

Phases 2–7 deployed to production. Now in **observation window** (~2-3 days) to collect structured logs before deciding on next tuning or Phase 6 (Vision).

**Live URL**: https://joi-bot.mirmanoov.workers.dev
**Cron**: every 5 min (`*/5 * * * *`)
**Size**: 318 KiB / 66 KiB gzip

---

## Completed Phases

### Phase N — Bugfixes (pre-work)
- `threadId` passed to `saveBotMessage` in all 4 active paths
- `trackLLMCall` for proactive + reminder + digest LLM calls (RPM tracking was incomplete)
- Rustem message saved to D1 *before* `handleRustemMessage` (was lost when Rustem mode skipped)
- Follow-up proactive loads `recentMessages` for groups (was missing)

### Phase 2 — Crisis & Situational Awareness
New module `src/crisis.ts`.
- **4-tier severity**: `none → distress → concern → crisis`
- **Russian-specific regex banks**: 11 crisis patterns, 17 concern, 8 distress
- **Metaphor + joking downgrade**: "хочу умереть от смеха" → none
- **Negation handling**: "уже не хочу умирать" → none
- **LLM verifier** (LITE model, 5 tokens) for ambiguous concern+
- **LRU cache** 5 min × 200 entries
- **Passive → active override**: crisis/concern forces response even if Joi not addressed
- **Rustem Mode bypass** when crisis detected
- **Mood override**: concern+ forces `mood = "serious"` and clears offense
- **Crisis block** injected in system prompt (3 tiers, different tone)
- **24h softness memory**: recent crisis users get softer tone in later messages
- Crisis events stored in `emotional_events` as `crisis_moment` (deduped 1h)
- Forwarded content skipped (articles about depression won't trigger)

### Phase 3 — Proactive Overhaul
- Removed broken `startsWith("ПОСЛЕДНИЕ")` filter in `generateProactiveMessage` (C1)
- Removed redundant `buildContext` call in proactive (C2) — system prompt now has recentMessages directly
- Added missing blocks to `buildProactiveSystemPrompt`: socialIntelligenceBlock, stickerPermissionBlock, emotionalEvents, kamaBlock (C3, G1)
- **8 proactive strategies**: reaction, curiosity, thought, poke, miss, meta, empathy, callback (C5)
- **Context-aware strategy selection** in `selectProactiveStrategy`: weighted random by time-of-day, mood, silence, crisis history, private vs group (C7, C9)
- **Hard overrides**: recent crisis → always empathy; 48h+ silence → always miss
- **Topic-aware dedup**: `getRecentBotMessages` filters by `thread_id` in VIP (C4)
- **Dedup pool 3→8** messages
- **Temperature 0.9→0.8** for coherence (C6)
- **Anti-spam 5 min**: skip proactive if last user msg < 5 min ago (C8)
- **Private proactive** now loads recentMessages too (G3)
- **Passive sentiment sampling 10%** to keep relationships alive in VIP (G2)

### Phase 4 — Deep Memory (partial)
- **D1: Per-topic context filter in VIP** — `buildContext` accepts `threadId`, filters ambient/focus/self/forwarded layers. Digests stay global (cross-topic awareness preserved)
- **D3: Salience-weighted emotional events** — fetch pool of 30, score by `|valence| × exp(-age_days / 14)`, pick top 10, re-sort chronologically. DB trim size bumped 10→30.

Not done (deferred): D2 episode linking, D4 per-topic digests, D5 fact dedup, D6 forgetting curve.

### Phase 5 — Social Intelligence (VIP only)
New module `src/social.ts`.
- **Social graph**: SQL self-JOIN on `reply_to_message_id` computes reply-edges over last 7 days. Filter human-to-human, count ≥ 3 (S1)
- **Pair aggregation**: fold directed edges into bidirectional pairs with imbalance score (who's chasing whom) (S3)
- **Chat mood signal**: aggregate emotional_events over last 48h by valence sign → warm / neutral / tense / mixed (S2)
- **Cost-gated**: only loaded for VIP chats (not private or other groups)
- Injected into both active (`buildSystemPrompt`) and proactive (`buildProactiveSystemPrompt`) VIP prompts
- Null-safe: empty data → no block in prompt (zero tokens)

### Phase 7 — Observation Infrastructure (this phase)
- Extended `msg_processed` log: + `threadId`, `crisisSeverity`, `recentCrisis`, `socialEdges`, `emoEvents`
- New `crisis_detected` log: severity, markers, confidence, isJoking, forceActive, rustemBypass
- New `proactive_sent` log: strategy, isFollowUp, silenceHours, almatyHour, mood, responseLength, latency
- New `quality_feedback` log: user's reply sentiment after Joi's message (correlation via `reply_to_message_id + from.username === BOT_USERNAME`). Both active and sampled-passive paths.

All logs are structured JSON to `console.log` — accessible via `npx wrangler tail`.

---

## Observation Window: What to Watch

```bash
# Live tail (stream all events)
npx wrangler tail

# Crisis firings only
npx wrangler tail --format json | jq 'select(.event == "crisis_detected")'

# Strategy distribution for proactive
npx wrangler tail --format json | \
  jq -r 'select(.event == "proactive_sent") | .strategy' | \
  sort | uniq -c | sort -rn

# Latency distribution (active)
npx wrangler tail --format json | \
  jq 'select(.event == "msg_processed") | .latency' | \
  awk 'BEGIN{c=0}{s+=$1;c++;if($1>max)max=$1}END{print "avg:",s/c,"max:",max,"n:",c}'

# Quality feedback (reply sentiment to Joi)
npx wrangler tail --format json | jq 'select(.event == "quality_feedback")'
```

### Questions we want to answer

1. **Crisis false positives**: how often do we get severity != "none" on clearly-joking messages?
   - Check `crisis_detected` with `isJoking: false` but text clearly was a joke
2. **Strategy distribution**: is meta/philosophy dominating at night? Is poke too rare?
3. **VIP latency**: does social graph SQL JOIN add significant latency?
4. **Force-active rate**: how many crisis→forced active per day? Is it disruptive?
5. **Quality signal**: are replies to Joi net positive or net negative?
6. **Topic filter impact**: is VIP context shrinking too much in sparse topics?
   - Proxy: `recentBotMsgCount` field in logs
7. **Rustem bypass**: does it ever fire for real (not just jokes)?
8. **Anti-spam effectiveness**: `anti_spam_recent` reason in shouldSendProactive

---

## Risk Inventory (what might go wrong)

| Risk | Likelihood | Mitigation |
|---|---|---|
| Crisis false positives on idioms | MEDIUM | Observe logs, tune regex/markers |
| Strategy meta dominating at night | MEDIUM | Tune weights if seen |
| VIP prompt exceeds optimal tokens | LOW-MEDIUM | Cost impact only, not breakage |
| Social graph SQL slow on large VIP | LOW | Add LIMIT tighter if needed |
| Salience favors old drama | LOW | Half-life tunable |
| Anti-spam kills legit moments | MEDIUM | Adjust 5min threshold |
| Log volume exceeds free tier | LOW | Logs are ephemeral in Workers |

---

## Next Steps (prioritized)

### Immediate (next 2-3 days)
- [ ] Run `wrangler tail` periodically, watch logs
- [ ] Note any anomalies in a scratchpad
- [ ] Check VIP prompt behavior against expectations

### Tuning pass (after observation)
- [ ] Adjust crisis regex banks based on false positives
- [ ] Retune proactive strategy weights by time-of-day
- [ ] Adjust salience half-life if events feel too persistent or too volatile
- [ ] Possibly tighten/loosen anti-spam recency (5 min)
- [ ] Possibly tune passive sentiment sample rate (currently 10%)

### Phase 6 — Vision (deferred by cost concern)
- Gemini vision for photo understanding
- Cost gate: only for photos quoted/addressed to Joi
- N-vision-calls-per-chat-per-day limit
- Voice-to-text (Whisper or Gemini)

### Phase 8 — Core/Shell Refactor (deferred)
- Extract shared personality core
- Chat-type blocks as pluggable shells
- Low priority, no user-facing impact

### Deferred Phase 4 items
- D2 episode linking (cluster emotional events by theme)
- D4 per-topic digests in VIP
- D5 fact deduplication
- D6 forgetting curve

---

## Architecture Summary

```
src/
├── index.ts         Entry: handleMessage, handleCron, handleActiveMessage
├── ai.ts            buildSystemPrompt, buildProactiveSystemPrompt, chat, LLM wrappers
├── context.ts       buildContext (layered), buildPrivateContext (session), thread walker
├── crisis.ts        detectCrisis, saveCrisisEvent, hasRecentCrisis [Phase 2]
├── social.ts        buildSocialGraph, computeChatMood [Phase 5]
├── proactive.ts     selectProactiveStrategy, shouldSendProactive, follow-up state [Phase 3]
├── memory.ts        emotional_events + salience ranking [Phase 4 D3]
├── digests.ts       activity digest + LLM topic digests
├── mood.ts          MoodData, swings, volatility
├── relationships.ts UserProfile, sentimentAvg, tiers
├── facts.ts         fact extraction + retrieval
├── reminders.ts     one-shot + recurring
├── stickers.ts      mood-based sticker selection
├── rate-limit.ts    per-user rate, RPM throttle, blackout
├── telegram.ts      API client, formatting
├── users.ts         name resolution, active chat registry
├── providers.ts     callGemini abstraction
└── config.ts        Env, types, constants, VIP_MEMBERS
```

---

## Deploy Commands

```bash
# Typecheck
npx tsc --noEmit

# Deploy
npx wrangler deploy

# Live logs
npx wrangler tail

# DB inspect
npx wrangler d1 execute joi-db --command="SELECT COUNT(*) FROM emotional_events WHERE event_type='crisis_moment'"
```

---

*Keep this file updated after each phase. Use `git log` + this doc to reconstruct full history.*
