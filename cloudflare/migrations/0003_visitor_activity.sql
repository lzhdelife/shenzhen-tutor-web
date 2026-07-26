CREATE TABLE IF NOT EXISTS visitor_activity (
  visitor_id TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_visitor_activity_last_seen
  ON visitor_activity(last_seen_at);
