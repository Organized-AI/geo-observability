# Deploy

## 1. Cloudflare resources (once per environment)

```bash
export CLOUDFLARE_API_TOKEN=...   # Account: Workers Scripts, D1, R2, KV, Queues, Workflows, AI Gateway, Analytics Engine, Workers AI (Edit)
export CLOUDFLARE_ACCOUNT_ID=...

npx wrangler d1 create geo-observability                 # paste database_id into wrangler.jsonc
npx wrangler kv namespace create CONFIG                  # paste id into wrangler.jsonc
npx wrangler r2 bucket create geo-observability-answers
npx wrangler queues create geo-observability-runs
npx wrangler queues create geo-observability-runs-dlq
# Staging: same with the -staging names, ids go under env.staging in wrangler.jsonc
```

Create an AI Gateway named `geo-observability` (dashboard → AI → AI Gateway), turn on authentication, logging and per-gateway spend limits. Copy its token for `CF_AIG_TOKEN`.

## 2. Worker secrets

```bash
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID   # routes engine calls through AI Gateway
npx wrangler secret put CF_AIG_TOKEN
npx wrangler secret put OPENAI_API_KEY          # any missing provider key = that engine runs on the stub
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put PERPLEXITY_API_KEY
npx wrangler secret put SHARE_LINK_SECRET       # long random string
npx wrangler secret put ACCESS_TEAM_DOMAIN      # e.g. yourteam.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD              # Access application audience tag
npx wrangler secret put AGENCY_EMAILS           # comma-separated; these users see every client
# optional: OTEL_EXPORTER_URL, OTEL_EXPORTER_HEADERS, AIG_UNIFIED_BILLING=true (if AI Gateway pays providers)
```

Model ids are plain vars in wrangler.jsonc (`OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GEMINI_MODEL`, `PERPLEXITY_MODEL`, `JUDGE_MODEL`). Check them against each provider's current model list. Token prices for cost estimates live in KV key `pricing` (see `src/engines/registry.ts`).

## 3. Migrate, deploy, seed the demo

```bash
npm ci
npm run check
npm run deploy:production        # docs build + D1 migrations + wrangler deploy
npm run seed:demo                # optional: read-only demo workspace at /app/ while DEMO_MODE=true
```

Set `DEMO_MODE` to `"false"` in wrangler.jsonc once real clients are on it.

## 4. Cloudflare Access

Zero Trust → Access → Applications → self-hosted, domain = the Worker's host, path `/app*` and `/api*` (exclude `/api/v1*`, `/api/shared*`, `/mcp`, `/ingest*`, `/tap.js`, `/docs*`, `/`). Policy: allow the agency's emails plus each client's email domain. Copy the audience tag into `ACCESS_AUD`.

## 5. GitOps

Push to `main` → CI gate → deploy workflow ships **staging**. Publish a GitHub release → ships **production** (add required reviewers on the `production` environment). Repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; optional repo variable `APP_URL_STAGING` for the smoke test. The deploy job skips cleanly until those secrets exist.

## 6. Client edge tap (per client zone)

Edit `edge/wrangler.jsonc` (route, `INGEST_URL`, `PROJECT_ID`), then:
```bash
npx wrangler secret put INGEST_KEY --config edge/wrangler.jsonc   # an ingest-scope key from the portal
npm run deploy:edge
```

## Local development
```bash
npm run db:migrate:local && npm run seed:demo:local
npm run dev:offline            # no Cloudflare login needed; Workers AI features fall back to rules
# or: cp .dev.vars.example .dev.vars && npm run dev   (needs a Cloudflare login for the AI binding)
```
