-- Drill-down by person reads spans by who sent them; daily reports keep one row per person and day.
CREATE INDEX llm_spans_user_time ON llm_spans(tenant_id, user_id, start_ms) WHERE user_id IS NOT NULL;

CREATE TABLE trace_reports (
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  day        TEXT NOT NULL,                      -- UTC YYYY-MM-DD
  report     TEXT NOT NULL,                      -- JSON: the day's numbers, the week before, observations
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, user_id, day)
);
