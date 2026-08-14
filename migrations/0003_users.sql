-- Self-service accounts. You (the owner) keep logging in with APP_PASSWORD
-- as before - that flow is unchanged. This table is for anyone else you
-- want to give access to: they register with email + password, land in
-- 'pending', and can't log in until you approve them from Settings.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,   -- PBKDF2-SHA256, base64
  password_salt TEXT NOT NULL,   -- random per-user salt, base64
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT
);
