CREATE TABLE IF NOT EXISTS clipboard_captures (
  capture_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'ignored')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_clipboard_captures_pending
  ON clipboard_captures(status, next_attempt_at, received_at);
