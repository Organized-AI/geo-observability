-- GEO Observability: initial schema.
-- Every row that belongs to a client carries tenant_id, and every query goes through
-- src/lib/db.ts, which refuses to run without one. Timestamps are ISO-8601 UTC strings.

-- ---------------------------------------------------------------- tenancy
CREATE TABLE tenants (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL UNIQUE,
  email_domain        TEXT,                       -- users on this domain join automatically
  plan                TEXT NOT NULL DEFAULT 'starter',
  prompt_limit        INTEGER NOT NULL DEFAULT 50,
  project_limit       INTEGER NOT NULL DEFAULT 1,
  model_limit         INTEGER NOT NULL DEFAULT 3,
  country_limit       INTEGER NOT NULL DEFAULT 1,
  monthly_spend_cap_micros INTEGER NOT NULL DEFAULT 50000000,  -- $50 of model spend
  status              TEXT NOT NULL DEFAULT 'active',          -- active | paused
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  is_agency   INTEGER NOT NULL DEFAULT 0,   -- agency staff see every tenant
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE memberships (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'viewer',   -- owner | editor | viewer
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,              -- SHA-256 of the secret; the secret is shown once
  prefix      TEXT NOT NULL,                     -- first characters, to recognise a key in the UI
  scope       TEXT NOT NULL DEFAULT 'read',      -- read | ingest
  last_used_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at  TEXT
);
CREATE INDEX api_keys_tenant ON api_keys(tenant_id);

-- ---------------------------------------------------------------- projects and setup
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  domain      TEXT NOT NULL,
  schedule    TEXT NOT NULL DEFAULT 'daily',     -- daily | weekly | paused
  onboarding_step TEXT NOT NULL DEFAULT 'brand', -- brand | topics | prompts | competitors | models | done
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX projects_tenant ON projects(tenant_id);

CREATE TABLE brand_profiles (
  project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL,
  what_you_sell TEXT,
  buyers      TEXT,
  markets     TEXT,                              -- JSON array of {country, language}
  facts       TEXT,                              -- JSON array of strings the brand stands behind
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE brands (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]',        -- JSON array of other spellings
  regex       TEXT,                              -- optional extra pattern
  domains     TEXT NOT NULL DEFAULT '[]',        -- JSON array of domains the brand owns
  socials     TEXT NOT NULL DEFAULT '[]',        -- JSON array of handles or URLs
  is_own      INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active',    -- active | suggested | rejected
  color       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX brands_project ON brands(tenant_id, project_id);

CREATE TABLE topics (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'     -- active | suggested
);
CREATE INDEX topics_project ON topics(tenant_id, project_id);

CREATE TABLE personas (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT
);

CREATE TABLE prompts (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  topic_id    TEXT REFERENCES topics(id) ON DELETE SET NULL,
  persona_id  TEXT REFERENCES personas(id) ON DELETE SET NULL,
  text        TEXT NOT NULL CHECK (length(text) <= 200),
  country     TEXT NOT NULL DEFAULT 'US',         -- ISO 3166-1 alpha-2
  language    TEXT NOT NULL DEFAULT 'en',
  intent      TEXT NOT NULL DEFAULT 'commercial', -- informational | commercial | transactional | navigational
  branded     INTEGER NOT NULL DEFAULT 0,
  volume      INTEGER CHECK (volume BETWEEN 1 AND 5),
  tags        TEXT NOT NULL DEFAULT '[]',          -- JSON array
  status      TEXT NOT NULL DEFAULT 'active',      -- suggested | active | archived
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX prompts_project ON prompts(tenant_id, project_id, status);

-- Engines a project tracks. The engine list itself lives in code (src/engines/registry.ts).
CREATE TABLE project_models (
  tenant_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  engine      TEXT NOT NULL,                     -- chatgpt | claude | gemini | perplexity | alexa
  enabled     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (project_id, engine)
);

CREATE TABLE project_countries (
  tenant_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  country     TEXT NOT NULL,
  PRIMARY KEY (project_id, country)
);

-- ---------------------------------------------------------------- runs and what came back
CREATE TABLE runs (
  id          TEXT PRIMARY KEY,                  -- deterministic: prompt:engine:country:date
  tenant_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  prompt_id   TEXT NOT NULL,
  engine      TEXT NOT NULL,
  model       TEXT,                              -- provider model id actually used
  country     TEXT NOT NULL,
  run_date    TEXT NOT NULL,                     -- YYYY-MM-DD
  status      TEXT NOT NULL DEFAULT 'queued',    -- queued | running | done | failed | skipped
  error       TEXT,
  channel     TEXT NOT NULL DEFAULT 'api',       -- api | stub | browser
  aig_log_id  TEXT,
  cost_micros INTEGER NOT NULL DEFAULT 0,        -- estimated from tokens; reconciled against AI Gateway
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms  INTEGER,
  r2_key      TEXT,
  answer_excerpt TEXT,
  judge       TEXT,                              -- llm | rules
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE INDEX runs_tenant_date ON runs(tenant_id, project_id, run_date);
CREATE INDEX runs_prompt ON runs(tenant_id, prompt_id, run_date);

CREATE TABLE mentions (
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL,
  brand_id    TEXT,                              -- NULL for a brand we are not tracking yet
  brand_name  TEXT NOT NULL,
  rank        INTEGER NOT NULL,                  -- 1 = named first
  sentiment   INTEGER,                           -- 0..100, 50 is neutral
  snippet     TEXT,
  PRIMARY KEY (run_id, brand_name)
);
CREATE INDEX mentions_brand ON mentions(tenant_id, brand_id, run_id);

CREATE TABLE citations (
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL,
  url         TEXT NOT NULL,
  domain      TEXT NOT NULL,
  path        TEXT NOT NULL,
  title       TEXT,
  kind        TEXT NOT NULL DEFAULT 'cited',     -- cited (shown to the reader) | used (retrieved, not shown)
  position    INTEGER NOT NULL,
  PRIMARY KEY (run_id, url)
);
CREATE INDEX citations_domain ON citations(tenant_id, domain, run_id);

CREATE TABLE fanout_queries (
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL,
  query       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'search',    -- search | shopping
  PRIMARY KEY (run_id, query)
);

CREATE TABLE claims (
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL,
  brand_id    TEXT,
  claim       TEXT NOT NULL,
  verdict     TEXT NOT NULL DEFAULT 'unchecked', -- matches | conflicts | unchecked
  kind        TEXT NOT NULL DEFAULT 'attribute'  -- attribute | objection | fact
);
CREATE INDEX claims_tenant ON claims(tenant_id, brand_id);

CREATE TABLE domain_classes (
  tenant_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  domain      TEXT NOT NULL,
  type        TEXT NOT NULL,                     -- own | competitor | editorial | reference | ugc | institutional | other
  PRIMARY KEY (tenant_id, project_id, domain)
);

CREATE TABLE url_versions (
  tenant_id   TEXT NOT NULL,
  url         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  r2_key      TEXT,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, url, content_hash)
);

-- ---------------------------------------------------------------- rollups
CREATE TABLE daily_brand_metrics (
  tenant_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  day         TEXT NOT NULL,
  brand_id    TEXT NOT NULL,
  engine      TEXT NOT NULL,
  country     TEXT NOT NULL,
  topic_id    TEXT NOT NULL DEFAULT '',
  answers     INTEGER NOT NULL,                  -- answers in this slice
  mentioned   INTEGER NOT NULL,                  -- answers naming the brand
  mentions_all INTEGER NOT NULL,                 -- brand mentions of every tracked brand in the slice
  rank_sum    INTEGER NOT NULL,
  sentiment_sum INTEGER NOT NULL,
  sentiment_n INTEGER NOT NULL,
  wins        INTEGER NOT NULL,                  -- named ahead of every competitor in the same answer
  contests    INTEGER NOT NULL,                  -- answers naming the brand and at least one competitor
  cited       INTEGER NOT NULL,                  -- answers citing one of the brand's domains
  PRIMARY KEY (tenant_id, project_id, day, brand_id, engine, country, topic_id)
);

-- ---------------------------------------------------------------- observability layer
CREATE TABLE crawl_daily (
  tenant_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  day         TEXT NOT NULL,
  path        TEXT NOT NULL,
  bot         TEXT NOT NULL,                     -- GPTBot, ClaudeBot, ...
  operator    TEXT NOT NULL,                     -- openai, anthropic, ...
  bot_type    TEXT NOT NULL,                     -- training | search | user
  hits        INTEGER NOT NULL DEFAULT 0,
  status_4xx  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, project_id, day, path, bot)
);

CREATE TABLE referral_daily (
  tenant_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  day         TEXT NOT NULL,
  path        TEXT NOT NULL,                     -- landing page
  assistant   TEXT NOT NULL,                     -- chatgpt | claude | perplexity | gemini | copilot | ...
  source      TEXT NOT NULL,                     -- edge | tap | sgtm | ga4
  sessions    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, project_id, day, path, assistant, source)
);

CREATE TABLE conversion_daily (
  tenant_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  day         TEXT NOT NULL,
  path        TEXT NOT NULL,                     -- landing page of the converting session
  assistant   TEXT NOT NULL,
  source      TEXT NOT NULL,                     -- sgtm | ga4 | google_ads | meta | tiktok | shopify
  event_name  TEXT NOT NULL,
  conversions INTEGER NOT NULL DEFAULT 0,
  value_micros INTEGER NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'USD',
  PRIMARY KEY (tenant_id, project_id, day, path, assistant, source, event_name)
);

-- Deduplication of server-side conversions sent from more than one place.
CREATE TABLE conversion_events_seen (
  tenant_id   TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  seen_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, event_id)
);

-- ---------------------------------------------------------------- insights, actions, sharing
CREATE TABLE insights (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  day         TEXT NOT NULL,
  kind        TEXT NOT NULL,                     -- visibility_move | prompt_lost | prompt_won | rival_source | crawl_drop | referral_move | conversion_move
  severity    INTEGER NOT NULL DEFAULT 1,        -- 1 low .. 3 high
  text        TEXT NOT NULL,
  evidence    TEXT NOT NULL DEFAULT '{}',        -- JSON: run ids, urls, metric deltas
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX insights_day ON insights(tenant_id, project_id, day);

CREATE TABLE actions (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,                     -- get_listed | refresh_page | new_page | fix_crawl | fix_fact
  title       TEXT NOT NULL,
  detail      TEXT,
  evidence    TEXT NOT NULL DEFAULT '{}',
  impact      INTEGER NOT NULL DEFAULT 1,        -- 1..3
  status      TEXT NOT NULL DEFAULT 'open',      -- open | in_progress | done | dismissed
  brief       TEXT,                              -- content brief, Markdown
  done_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX actions_project ON actions(tenant_id, project_id, status);

CREATE TABLE views (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  filters     TEXT NOT NULL DEFAULT '{}',
  layout      TEXT NOT NULL DEFAULT '[]',
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE share_links (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  view_id     TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------- usage (billing hooks; no provider wired)
CREATE TABLE usage_events (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  meter       TEXT NOT NULL,                     -- answers_run | llm_cost_micros | browser_minutes | extra_engines
  quantity    INTEGER NOT NULL,
  run_id      TEXT,
  aig_log_id  TEXT,
  hour        TEXT NOT NULL,                     -- YYYY-MM-DDTHH, the unit a billing push aggregates on
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX usage_tenant_hour ON usage_events(tenant_id, meter, hour);

CREATE TABLE billing_accounts (
  tenant_id   TEXT PRIMARY KEY,
  provider    TEXT NOT NULL DEFAULT 'none',      -- none until billing is wired
  customer_ref TEXT,
  subscription_ref TEXT,
  status      TEXT NOT NULL DEFAULT 'active',    -- active | trialing | past_due | unpaid | canceled
  grace_until TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE usage_pushes (
  tenant_id   TEXT NOT NULL,
  meter       TEXT NOT NULL,
  hour        TEXT NOT NULL,
  quantity    INTEGER NOT NULL,
  identifier  TEXT NOT NULL UNIQUE,              -- tenant:meter:hour, the idempotency key a provider push uses
  pushed_at   TEXT,
  PRIMARY KEY (tenant_id, meter, hour)
);

-- ---------------------------------------------------------------- audit
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  user_email  TEXT,
  action      TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
