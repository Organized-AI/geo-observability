-- Large span bodies live in R2 (ANSWERS bucket, traces/<tenant>/<trace>/...); the row keeps a short preview and the key.
ALTER TABLE llm_spans ADD COLUMN body_key TEXT;

-- Spans per workspace per month, for the quota and the usage page.
CREATE TABLE trace_usage (
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month      TEXT NOT NULL,              -- YYYY-MM (UTC)
  spans      INTEGER NOT NULL DEFAULT 0,
  bytes      INTEGER NOT NULL DEFAULT 0, -- request bytes received
  PRIMARY KEY (tenant_id, month)
);

-- Monthly span allowance. An owner-run plan change can raise it; 0 means no tracing.
ALTER TABLE tenants ADD COLUMN trace_span_limit INTEGER NOT NULL DEFAULT 2000000;
