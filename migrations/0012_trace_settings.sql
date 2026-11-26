-- What coding tools may send, per workspace. full: prompts, answers and (if a machine opts in) tool inputs and outputs;
-- prompts: prompts and answers only; metadata: timings, tools and token counts only.
CREATE TABLE trace_settings (
  tenant_id   TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  capture     TEXT NOT NULL DEFAULT 'full',
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
