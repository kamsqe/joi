-- Living interests — Joi has one "current obsession" at a time that rotates
-- every 3-7 days. Run with:
--   npx wrangler d1 execute joi-db --remote --file=migrations/0001_interests.sql

CREATE TABLE IF NOT EXISTS interests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,           -- per-chat scope (private chats get separate obsessions)
  topic TEXT NOT NULL,                -- "корейские дорамы", "теории заговора про NASA"
  flavor TEXT,                        -- one-liner: how she talks about it (optional, model-friendly hint)
  source TEXT DEFAULT 'canon',        -- 'canon' (seeded) | 'self_chose' | 'from_chat:<userId>'
  is_current INTEGER DEFAULT 0,       -- exactly one per chat at a time
  intensity REAL DEFAULT 0.5,         -- 0..1, decays over time, controls mention probability
  started_at INTEGER,                 -- when current=1 was set
  last_mentioned INTEGER,             -- last time she actually surfaced it in chat
  ts_created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interests_chat_current ON interests(chat_id, is_current);
CREATE INDEX IF NOT EXISTS idx_interests_chat_topic ON interests(chat_id, topic);
