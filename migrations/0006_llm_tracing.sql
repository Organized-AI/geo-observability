-- LLM tracing: spans sent by a client's own LLM apps over OTLP, grouped into traces and named apps.
-- Times are integer epoch milliseconds. Cost is integer micros of a US dollar.

CREATE TABLE trace_apps (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,                     -- from x-project-name, openinference.project.name or service.name
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT,
  UNIQUE (tenant_id, name)
);

CREATE TABLE llm_spans (
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id            TEXT NOT NULL REFERENCES trace_apps(id) ON DELETE CASCADE,
  trace_id          TEXT NOT NULL,                -- 32 hex characters
  span_id           TEXT NOT NULL,                -- 16 hex characters
  parent_span_id    TEXT,                         -- no foreign key: a child may arrive before its parent
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'UNKNOWN', -- LLM | CHAIN | AGENT | TOOL | RETRIEVER | EMBEDDING | RERANKER | GUARDRAIL | EVALUATOR | PROMPT | DECISION | UNKNOWN
  status_code       TEXT NOT NULL DEFAULT 'UNSET',   -- UNSET | OK | ERROR
  status_message    TEXT,
  start_ms          INTEGER NOT NULL,
  end_ms            INTEGER NOT NULL,
  model             TEXT,
  provider          TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  cost_micros       INTEGER,
  session_id        TEXT,
  user_id           TEXT,
  input_text        TEXT,                         -- cut to a fixed length; the full value stays in attributes when it fits
  output_text       TEXT,
  attributes        TEXT NOT NULL DEFAULT '{}',   -- JSON object of flat attribute keys
  events            TEXT NOT NULL DEFAULT '[]',   -- JSON array of { name, time_ms, attributes }
  truncated         INTEGER NOT NULL DEFAULT 0,   -- 1 when a value was cut to fit the limits
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, trace_id, span_id)
);

-- One row per trace, recomputed from its spans after every write.
CREATE TABLE llm_traces (
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id            TEXT NOT NULL REFERENCES trace_apps(id) ON DELETE CASCADE,
  trace_id          TEXT NOT NULL,
  session_id        TEXT,
  user_id           TEXT,
  root_span_id      TEXT,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'UNKNOWN',
  status            TEXT NOT NULL DEFAULT 'UNSET', -- ERROR when any span failed
  start_ms          INTEGER NOT NULL,
  end_ms            INTEGER NOT NULL,
  span_count        INTEGER NOT NULL DEFAULT 0,
  error_count       INTEGER NOT NULL DEFAULT 0,
  llm_count         INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_micros       INTEGER NOT NULL DEFAULT 0,
  model             TEXT,
  input_preview     TEXT,
  output_preview    TEXT,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, trace_id)
);
CREATE INDEX llm_traces_app_time ON llm_traces(tenant_id, app_id, start_ms DESC, trace_id);
CREATE INDEX llm_traces_time ON llm_traces(tenant_id, start_ms DESC, trace_id);
CREATE INDEX llm_traces_session ON llm_traces(tenant_id, session_id, start_ms) WHERE session_id IS NOT NULL;
