-- Public signup and email sign-in links (replaces the Cloudflare Access requirement; Access stays optional for staff).

ALTER TABLE users ADD COLUMN email_verified_at TEXT;        -- set the first time a sign-in link is used
ALTER TABLE users ADD COLUMN signup_pending INTEGER NOT NULL DEFAULT 0;  -- 1: created by public signup, email not yet verified
ALTER TABLE billing_accounts ADD COLUMN checkout_claimed_at TEXT;      -- the Checkout return that opened a session

-- Browser sessions. Only a SHA-256 of the cookie value is stored.
CREATE TABLE sessions (
  id_hash      TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified     INTEGER NOT NULL DEFAULT 1,     -- 0: opened from a Checkout return before the email was confirmed
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Single-use, short-lived sign-in links. Only a SHA-256 of the token is stored.
CREATE TABLE login_tokens (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX login_tokens_email ON login_tokens(email, created_at);

-- Rate limiting for sign-in emails, signups and link checks (key is a hash of the email or IP).
CREATE TABLE rate_events (
  kind        TEXT NOT NULL,
  key         TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX rate_events_lookup ON rate_events(kind, key, created_at);

-- Local development and tests only (EMAIL_MODE=outbox): emails are written here instead of sent.
CREATE TABLE email_outbox (
  id          TEXT PRIMARY KEY,
  to_email    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
