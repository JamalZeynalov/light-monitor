-- Вставте весь файл у D1 -> light-monitor-db -> Console -> Execute.
-- Повторне виконання не стирає стан або повідомлення.
CREATE TABLE IF NOT EXISTS monitor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','up','down')),
  last_seen INTEGER,
  last_cron INTEGER,
  last_error INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO monitor (id) VALUES (1);

-- Подія та зміна стану записуються однією транзакцією D1 batch.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('up','down','test')),
  created_at INTEGER NOT NULL,
  queued INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_queue ON events(queued, id);

-- Окрема доставка для кожного отримувача. Успішні доставки не повторюємо.
CREATE TABLE IF NOT EXISTS deliveries (
  event_id INTEGER NOT NULL REFERENCES events(id),
  chat_id TEXT NOT NULL,
  delivered_at INTEGER,
  retry_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, chat_id)
);
CREATE INDEX IF NOT EXISTS deliveries_pending
  ON deliveries(delivered_at, retry_at, event_id);
CREATE INDEX IF NOT EXISTS deliveries_chat
  ON deliveries(chat_id, delivered_at, event_id);

-- Початок кожного періоду за сигналом плати; 0 — перша тиха активація.
CREATE TABLE IF NOT EXISTS power_periods (
  event_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('up','down')),
  started_at INTEGER NOT NULL
);
