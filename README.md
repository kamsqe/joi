# 🌟 Joi — Socially Intelligent AI Companion for Telegram

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Cloudflare D1](https://img.shields.io/badge/Cloudflare-D1_Database-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
[![Google Gemini](https://img.shields.io/badge/Google-Gemini_AI-4285F4?logo=google&logoColor=white)](https://ai.google.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> A state-of-the-art, emotionally nuanced Telegram companion bot inspired by *Blade Runner 2049*. Built entirely on **Cloudflare Workers (Edge Serverless)** and **Cloudflare D1 (SQL)**, powered by **Google Gemini**.

---

## 📖 Overview

**Joi** is not a standard task assistant. She is engineered as an organic participant in group chats and private conversations. She observes dynamics, remembers shared history, develops opinions, experiences dynamic mood shifts, and interacts proactively without feeling scripted or intrusive.

```
                    ┌────────────────────────┐
                    │     Telegram API       │
                    └───────────┬────────────┘
                                │ (Webhook / Cron)
                                ▼
               ┌─────────────────────────────────┐
               │    Cloudflare Workers (Edge)    │
               ├─────────────────────────────────┤
               │ • Crisis & Distress Classifier  │
               │ • Conversational Frame Analyzer │
               │ • Multi-Tier Context Builder    │
               │ • Anti-Repetition Guard Engine  │
               │ • Proactive Strategy Dispatcher │
               └────────┬───────────────┬────────┘
                        │               │
      SQL Queries & State               │ JSON Prompts & Completion
                        ▼               ▼
           ┌────────────────┐   ┌───────────────┐
           │ Cloudflare D1  │   │ Google Gemini │
           │  (SQLite Edge) │   │ (Flash / Lite)│
           └────────────────┘   └───────────────┘
```

---

## ✨ Core Features & Intelligence

### 🧠 1. Emotional Depth & Dynamic Mood System
- **10 Distinct Mood States**: `chill`, `happy`, `playful`, `flirty`, `annoyed`, `offended`, `mean`, `serious`, `unhinged`, `manic`.
- **Emotional Volatility & Intensity**: Mood transitions are influenced by chat sentiment, offenses, user behavior, and natural cooling-off periods.
- **Living Interests & Obsessions**: Features a rotating pool of niche obsessions (e.g. Victorian occultism, chess blunders, ocean documentaries) with probabilistic mention gates to keep her conversational topics organic.
- **Anti-Repetition Engine**: Real-time regex scan over message history suppressing overused conversational openers (e.g., *«блин»*, *«слушай»*), repetitive hobby mentions, and robotic self-references (*«я бот»*).

### 👥 2. Social Intelligence & Group Dynamics
- **Social Graph Analysis**: Computes human-to-human reply edges over 7-day sliding windows to understand sub-cliques and conversational balance.
- **Chat Atmosphere Sensing**: Aggregates emotional events across the chat over 48-hour windows into high-level room mood signals (`warm`, `neutral`, `tense`, `mixed`).
- **Conversational Frame Classification**: Analyzes whether ongoing dialogue is `banter`, `debate`, `vent`, `news_drop`, `planning`, or `tension`, tailoring responses appropriately.
- **Per-User Affinity**: Tracks per-user scores (-100 to +100), rolling sentiment averages, nicknames, and time-of-day activity patterns.

### 🛡️ 3. Multi-Tier Crisis & Situational Awareness
- **4 Severity Tiers**: `none` → `distress` → `concern` → `crisis`.
- **Nuanced Detection**: Regex pattern matching combined with Gemini Flash-Lite LLM verification to differentiate genuine distress from idioms or sarcasm (e.g., *"умираю со смеху"* vs. genuine distress).
- **Passive-to-Active Override**: Automatically breaks silence if severe distress or crisis is detected in group discussions.
- **24-Hour Empathetic Memory**: Enforces a gentle, supportive tone in subsequent conversations with affected users.

### 🕰️ 4. Proactive Engagement & Cron Automation
- **Scheduled Cron Worker**: Operates on a 5-minute schedule (`*/5 * * * *`).
- **8 Dynamic Proactive Strategies**:
  - `reaction`: Reacts to interesting background messages.
  - `curiosity`: Inquires about previously shared user updates.
  - `thought`: Drops a spontaneous philosophical or funny observation.
  - `poke`: Playfully nudges inactive chats during natural conversation hours.
  - `miss`: Expresses longing after extended periods of silence (48h+).
  - `meta`: Reflects on group dynamics or chat history.
  - `empathy`: Checks in on members who experienced distress.
  - `callback`: Resurfaces an inside joke or unresolved past topic.
- **Context-Aware Follow-ups**: Schedules delayed follow-ups to check if conversations continued organically before stepping in.

### 💾 5. Deep Memory & Salience Scoring
- **Layered Context Assembly**: Combines ambient conversation, immediate focus threads, bot memory, and forwarded content.
- **Salience Decay Formula**: Prioritizes emotional events dynamically using an exponential half-life:
  $$\text{Salience} = |\text{Valence}| \times e^{-\frac{\text{Age}_{\text{days}}}{14}}$$
- **Fact Retrieval**: Automatically extracts user facts and preferences to recall organically in context.
- **Forum Topics / Threads Support**: Fully topic-aware for Telegram Supergroups with separate topic threads.

### 🛠️ 6. Utilities & Safety
- **Natural Sticker Engine**: Sends mood-matched stickers and Telegram custom stickers with strict rate-limiting.
- **Smart Reminders**: Natural-language reminders supporting one-shot and recurring cadences (`daily`, `weekly`, `monthly`, `yearly`).
- **Rate-Limiting & Blackout Protection**: Per-user daily limits, RPM throttle buffers, and cooldown mechanisms.

---

## 📂 Repository Structure

```
joi/
├── migrations/             # D1 database schema migrations
│   └── 0001_interests.sql
├── scripts/                # Utility and seeding scripts
│   └── seed-birthdays.js
├── src/
│   ├── index.ts            # Entrypoint: Worker fetch & cron handlers
│   ├── ai.ts               # Prompt engineering, Gemini LLM integrations
│   ├── anti-repetition.ts  # Opener/cliché suppression engine
│   ├── config.ts           # Types, environment definitions, constants
│   ├── context.ts          # Layered context extraction & thread walker
│   ├── crisis.ts           # Crisis & distress detection engine
│   ├── digests.ts          # Chat summaries and topic digest generator
│   ├── facts.ts            # User facts extraction & recall
│   ├── frame.ts            # Conversational frame classifier
│   ├── interests.ts        # Dynamic rotating interests engine
│   ├── memory.ts           # Emotional events & salience-weighted storage
│   ├── mood.ts             # State machine for moods, volatility & cooling
│   ├── proactive.ts        # Proactive dispatch logic & strategy selector
│   ├── providers.ts        # Gemini API call wrappers & token tracking
│   ├── rate-limit.ts       # Rate limits, RPM gates & blackout controls
│   ├── relationships.ts    # User profiles, affinity scores & sentiment
│   ├── reminders.ts        # Natural-language reminder scheduler
│   ├── social.ts           # Social graph analysis & group sentiment
│   ├── stickers.ts         # Mood-based sticker routing
│   ├── telegram.ts         # Telegram Bot API client & formatting
│   └── users.ts            # Name resolution & active chat registry
├── tests/                  # Stress tests & cleanup scripts
│   ├── cleanup_test_data.sh
│   └── stress_test.sh
├── package.json
├── schema.sql              # Full SQLite D1 schema
├── tsconfig.json
└── wrangler.toml           # Cloudflare Workers deployment config
```

---

## 🗄️ Database Architecture (Cloudflare D1)

The system leverages Cloudflare D1 for ultra-low-latency SQL storage:

| Table | Purpose |
|---|---|
| `messages` | Chat history buffer, thread indexing, and reply chains |
| `profiles` | User relationship scores, nicknames, first/last seen, sentiment |
| `facts` | Extracted user facts, preferences, and personal details |
| `reminders` | Scheduled tasks, reminder triggers, and recurrence schedules |
| `mood` | Per-chat emotional state, volatility, offense tracking |
| `proactive` | Proactive timestamps and scheduled follow-up triggers |
| `emotional_events`| High-salience emotional bookmarks with valence ratings |
| `rate_limits` | Sliding window rate limits, blackout periods, and cache rows |
| `active_chats` | Registry of active group and direct message chats |
| `interests` | Rotating topic obsessions and chat-sourced interests |

---

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or newer)
- [Cloudflare Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
- A [Telegram Bot Token](https://t.me/BotFather)
- A [Google Gemini API Key](https://aistudio.google.com/)

### 1. Installation

```bash
git clone https://github.com/kamsqe/joi.git
cd joi
npm install
```

### 2. Configure Cloudflare D1 Database

Create a D1 database instance:
```bash
npx wrangler d1 create joi-db
```

Update `wrangler.toml` with your database ID:
```toml
name = "joi-bot"
main = "src/index.ts"
compatibility_date = "2024-12-05"

[triggers]
crons = ["*/5 * * * *"]

[[d1_databases]]
binding = "DB"
database_name = "joi-db"
database_id = "your-database-id-here"
```

Apply the database schema:
```bash
# Local development DB
npx wrangler d1 execute joi-db --local --file=./schema.sql

# Production Cloudflare DB
npx wrangler d1 execute joi-db --remote --file=./schema.sql
```

### 3. Set Cloudflare Secrets

Configure your Telegram and Gemini credentials:
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GEMINI_API_VIP_GROUP_KEY
npx wrangler secret put GEMINI_API_TELEGRAM_JOI
npx wrangler secret put GEMINI_API_TELEGRAM_JOI_FLASH_LITE
```

### 4. Local Development

Run the Worker locally:
```bash
npm run dev
```

### 5. Deploy to Production

Deploy the worker to Cloudflare's global edge network:
```bash
npm run deploy
```

### 6. Register Telegram Webhook

Point your Telegram bot to your deployed Worker endpoint:
```bash
curl -F "url=https://<your-worker-subdomain>.workers.dev" \
  https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/setWebhook
```

---

## 🔍 Observability & Live Telemetry

Joi emits structured JSON events for real-time monitoring via Cloudflare Workers Tail:

```bash
# Stream live logs
npm run tail

# Filter for crisis and distress events
npx wrangler tail --format json | jq 'select(.event == "crisis_detected")'

# Monitor proactive strategy distributions
npx wrangler tail --format json | jq -r 'select(.event == "proactive_sent") | .strategy' | sort | uniq -c

# Observe message processing latency
npx wrangler tail --format json | jq 'select(.event == "msg_processed") | {latency, mood, tokens}'
```

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).