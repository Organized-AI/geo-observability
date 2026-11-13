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
npx wrangler secret put EMAIL_FROM              # sender for sign-in links, on a domain onboarded to Cloudflare Email Service
# optional: ACCESS_TEAM_DOMAIN, ACCESS_AUD (Cloudflare Access for staff), RESEND_API_KEY (email fallback)
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

## 3b. Public address (app.organizedai.vip/geo-observability)

`wrangler.jsonc` sets `APP_URL` to `https://app.organizedai.vip/geo-observability` and adds two routes on the
`organizedai.vip` zone (`app.organizedai.vip/geo-observability` and `.../geo-observability/*`). `wrangler deploy`
creates them. `app.organizedai.vip` already has a proxied DNS record (the organizedai-vanity-router serves the rest of
that host), so no DNS change is needed; a route beats the router on these two paths only.

What the base path changes, all in `src/lib/basepath.ts`: the path is stripped before routing, HTML links get the
prefix, redirects get the prefix, and the session cookie becomes `__Secure-geo_session` with `Path=/geo-observability`
(people signed in on workers.dev sign in once more). On workers.dev, page loads redirect to the public address while
`/api`, `/ingest`, `/mcp`, `/tap.js`, `/healthz` and `/webhooks/stripe` keep answering, so installed snippets and the
existing Stripe webhook endpoint still work. Moving the Stripe webhook to
`https://app.organizedai.vip/geo-observability/webhooks/stripe` is optional; if you do, keep the same signing secret or
update `STRIPE_WEBHOOK_SECRET`.

To go back to workers.dev only: set `"APP_URL": ""`, remove `routes`, deploy.

## 4. Sign-in

Clients sign up at `/signup/` and sign in with emailed links at `/login/`; sessions are an HttpOnly cookie. Set up sending once: [sign-in-email.md](sign-in-email.md). Agency staff named in `AGENCY_EMAILS` can sign in by link too.

Cloudflare Access is optional, for staff only: if you add it, protect only what staff use and keep `/`, `/signup*`, `/login*`, `/auth*`, `/app*`, `/api*`, `/webhooks*`, `/docs*`, `/mcp`, `/ingest*`, `/tap.js` public. Then set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.

## 4b. Stripe billing

See [stripe-billing.md](stripe-billing.md): one script creates the sandbox products, prices, meters, portal configuration and webhook, and sets the three Stripe secrets. Without them, card billing and self-serve signup stay off and everything else works as before.

## 5. GitOps

First enable the workflows (they are parked in `CONFIG/github-workflows/`): `git mv CONFIG/github-workflows .github/workflows`, commit and push.

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
