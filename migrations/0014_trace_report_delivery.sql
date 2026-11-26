-- Daily reports by email, and each person's own day.
ALTER TABLE trace_settings ADD COLUMN email_reports INTEGER NOT NULL DEFAULT 0; -- owner switch, off until turned on
ALTER TABLE trace_reports ADD COLUMN emailed_at TEXT;

-- One row per person seen from a coding tool: their time zone (sent by geo-trace) and whether they want the email.
CREATE TABLE trace_people (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  tz            TEXT,                          -- IANA name, e.g. America/Chicago; UTC when unknown
  email_reports INTEGER NOT NULL DEFAULT 1,    -- the person's own choice; 0 after they unsubscribe
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, user_id)
);
