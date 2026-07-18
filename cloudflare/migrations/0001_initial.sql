PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('teacher', 'agency', 'admin')),
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  preferences_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (role, name, phone)
);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'closed')),
  district TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  import_fingerprint TEXT,
  structured_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_agency_created ON orders(agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_district ON orders(district);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_import_fingerprint
  ON orders(import_fingerprint) WHERE import_fingerprint IS NOT NULL AND import_fingerprint <> '';

CREATE TABLE IF NOT EXISTS order_locations (
  order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  place TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  original_place TEXT NOT NULL DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  status TEXT NOT NULL DEFAULT '',
  poi_id TEXT NOT NULL DEFAULT '',
  coordinates TEXT NOT NULL DEFAULT '',
  resolved_address TEXT NOT NULL DEFAULT '',
  confidence REAL,
  query_text TEXT NOT NULL DEFAULT '',
  queries_json TEXT NOT NULL DEFAULT '[]',
  candidates_json TEXT NOT NULL DEFAULT '[]',
  options_json TEXT NOT NULL DEFAULT '[]',
  relation TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (order_id, teacher_id)
);
CREATE INDEX IF NOT EXISTS idx_applications_teacher ON applications(teacher_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_order ON applications(order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'closed')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);

CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(active, updated_at DESC);
