-- Joi D1 Schema
-- Core message storage (replaces KV buf:*)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  user_id INTEGER,
  user_name TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  is_bot INTEGER DEFAULT 0,
  is_forwarded INTEGER DEFAULT 0,
  forward_source TEXT,
  reply_to_message_id INTEGER,
  thread_id INTEGER,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_messages_chat_msgid ON messages(chat_id, message_id);

-- User profiles (replaces KV user:*)
CREATE TABLE IF NOT EXISTS profiles (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  nickname TEXT,
  nickname_override INTEGER DEFAULT 0,
  score INTEGER DEFAULT 0,
  sentiment_avg REAL DEFAULT 0.0,
  first_seen INTEGER NOT NULL,
  last_interaction INTEGER NOT NULL,
  is_first_contact INTEGER DEFAULT 1,
  activity_hours TEXT,
  PRIMARY KEY (chat_id, user_id)
);

-- User facts (replaces KV facts:*)
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  fact TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_user ON facts(chat_id, user_id);

-- Reminders (replaces KV rem:* + rem_idx:*)
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  remind_at INTEGER NOT NULL,
  recurrence TEXT DEFAULT 'once',
  created_at INTEGER NOT NULL,
  last_reminded INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reminders_chat ON reminders(chat_id);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(remind_at);

-- Mood state (replaces KV mood:*)
CREATE TABLE IF NOT EXISTS mood (
  chat_id INTEGER PRIMARY KEY,
  mood TEXT NOT NULL DEFAULT 'chill',
  intensity INTEGER DEFAULT 50,
  volatility REAL DEFAULT 0.4,
  last_change INTEGER NOT NULL,
  offended_by INTEGER,
  offense_reason TEXT,
  cool_period_until INTEGER
);

-- Proactive state (replaces KV proactive:*)
CREATE TABLE IF NOT EXISTS proactive (
  chat_id INTEGER PRIMARY KEY,
  last_proactive_ts INTEGER DEFAULT 0,
  pending_follow_up TEXT
);

-- Rate limiting (replaces KV rate:* + rpm:* + blackout:*)
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  data TEXT,
  expires_at INTEGER NOT NULL
);

-- Active chats (replaces KV chats:active)
CREATE TABLE IF NOT EXISTS active_chats (
  chat_id INTEGER PRIMARY KEY,
  registered_at INTEGER NOT NULL
);

-- Emotional bookmarks — significant moments per user (max 10)
CREATE TABLE IF NOT EXISTS emotional_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,       -- 'fight', 'apology', 'personal', 'joke', 'milestone', 'warmth'
  summary TEXT NOT NULL,          -- 1-line description: "поругались из-за музыки"
  valence REAL NOT NULL,          -- -1.0 (negative) to 1.0 (positive)
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emotional_events_user ON emotional_events(chat_id, user_id, ts DESC);

-- Performance indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_chat_role_ts ON messages(chat_id, role, ts DESC);
