ALTER TABLE orders ADD COLUMN raw_fingerprint TEXT;
ALTER TABLE orders ADD COLUMN semantic_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_raw_fingerprint
  ON orders(raw_fingerprint) WHERE raw_fingerprint IS NOT NULL AND raw_fingerprint <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_semantic_fingerprint
  ON orders(semantic_fingerprint) WHERE semantic_fingerprint IS NOT NULL AND semantic_fingerprint <> '';
