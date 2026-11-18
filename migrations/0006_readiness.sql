-- Preserve the scheduler outbox already installed by the production hotfix.
CREATE TABLE IF NOT EXISTS run_dispatch_outbox (
  tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
  payload TEXT NOT NULL, sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, run_id)
);
CREATE INDEX IF NOT EXISTS run_dispatch_pending ON run_dispatch_outbox (tenant_id, project_id, sent_at);

-- Durable pass records: expiry must never disappear when a KV TTL elapses.
CREATE TABLE demo_passes (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, key_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL, tenant_slug TEXT NOT NULL, project_id TEXT, project_name TEXT,
  api_limit INTEGER NOT NULL, mcp_limit INTEGER NOT NULL,
  api_calls INTEGER NOT NULL DEFAULT 0, mcp_calls INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  FOREIGN KEY (key_id) REFERENCES api_keys(id)
);
