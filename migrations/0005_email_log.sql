-- One row per outgoing email attempt, so a failed send can be seen (wrangler d1 execute … or GET /api/email/status).
CREATE TABLE IF NOT EXISTS email_log (
  id          TEXT PRIMARY KEY,
  to_email    TEXT NOT NULL,
  provider    TEXT NOT NULL,            -- cloudflare | resend | outbox | none
  status      TEXT NOT NULL,            -- sent | failed
  code        TEXT,                     -- provider error code, e.g. E_SENDER_DOMAIN_NOT_AVAILABLE
  detail      TEXT,                     -- provider message (trimmed)
  message_id  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS email_log_created ON email_log (created_at);
