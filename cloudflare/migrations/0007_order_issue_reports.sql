CREATE TABLE IF NOT EXISTS order_issue_reports (
  id TEXT PRIMARY KEY,
  target_key TEXT NOT NULL,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('published', 'preview')),
  reporter_key TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  parsed_snapshot_json TEXT NOT NULL DEFAULT '{}',
  parser_version TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(target_key, reporter_key)
);

CREATE INDEX IF NOT EXISTS idx_order_issue_reports_target ON order_issue_reports(target_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_issue_reports_updated ON order_issue_reports(updated_at DESC);
