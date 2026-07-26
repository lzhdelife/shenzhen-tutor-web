CREATE TABLE IF NOT EXISTS amap_usage (
  usage_date TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  outcome TEXT NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (usage_date, endpoint, outcome)
);

CREATE INDEX IF NOT EXISTS idx_amap_usage_date
  ON amap_usage(usage_date, endpoint);
