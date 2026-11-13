# GEO Observability — AI answer visibility with an observability layer

[![ci](https://github.com/Organized-AI/geo-observability/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Organized-AI/geo-observability/actions/workflows/ci.yml)
[![security](https://github.com/Organized-AI/geo-observability/actions/workflows/security.yml/badge.svg?branch=main)](https://github.com/Organized-AI/geo-observability/actions/workflows/security.yml)
[![deploy-staging](https://github.com/Organized-AI/geo-observability/actions/workflows/deploy-staging.yml/badge.svg?branch=main)](https://github.com/Organized-AI/geo-observability/actions/workflows/deploy-staging.yml)
[![release](https://github.com/Organized-AI/geo-observability/actions/workflows/release.yml/badge.svg)](https://github.com/Organized-AI/geo-observability/actions/workflows/release.yml)

**Live app:** [app.organizedai.vip/geo-observability](https://app.organizedai.vip/geo-observability) · **User guide:** [/docs](https://app.organizedai.vip/geo-observability/docs/) · **How it ships:** [DOCUMENTATION/gitops.md](DOCUMENTATION/gitops.md) · **Source:** [github.com/Organized-AI/geo-observability](https://github.com/Organized-AI/geo-observability) (private)

A Cloudflare-native tool that shows where AI assistants recommend a brand, and what those answers are worth. It is for agencies and in-house teams who need to know whether ChatGPT, Claude, Gemini and Perplexity name their brand, which sources those answers lean on, and whether AI traffic turns into revenue. For each client project it delivers:

1. **Tracking.** Prompts run daily (or weekly) per engine and country through Cloudflare AI Gateway, with the raw answer kept in R2 and every call logged, costed and traceable.
2. **Scores.** Visibility, share of voice, position, sentiment, win rate and citations (cited vs used), plus fan-out queries, brand perception and fact checks against the facts you set.
3. **Observability.** AI crawler hits and AI-referred visits captured at the edge, and server-side conversions (sGTM, GA4, Google Ads, Meta, TikTok, Shopify), joined to the pages the answers cite.
4. **Actions.** Daily insights, ranked actions and content briefs, written from the evidence.
5. **Access.** A client portal with public signup and emailed sign-in links, read-only share links, a REST API (`/api/v1`) and an MCP server (`/mcp`).

**Pricing:** 14-day free trial (card on file at signup), then $150 a month per workspace plus token usage at cost, billed through Stripe (test mode until live billing is approved). Details: [SPECIFICATIONS/billing.md](SPECIFICATIONS/billing.md).

## Where each piece lives

| Capability | Where it is |
|---|---|
| Engines (ChatGPT, Claude, Gemini, Perplexity; labelled stub without a key; Alexa listed as unavailable) | `src/engines/` (`providers.ts`, `gateway.ts`, `stub.ts`, `registry.ts`) |
| Mention matching, ranking and the Workers AI judge | `src/judge/` (`mentions.ts` deterministic, `llm.ts` judge with rules fallback) |
| Passes: plan → queue → one Workflow per prompt × engine × country × day | `src/workflows/` (`scheduler.ts`, `run-prompt.ts`, `pipeline.ts`), `src/durable/progress.ts` (live progress) |
| Reports, filters and daily rollups | `src/metrics/` |
| Crawler and referral classification, ingest, the Pages table | `src/observability/`, `edge/` (tap Worker for client zones), `public/tap.js` |
| Insights, actions and briefs | `src/insights/engine.ts` |
| Portal API, public API v1, MCP | `src/routes/portal.ts`, `src/routes/v1.ts`, `src/mcp/server.ts` |
| Signup, emailed sign-in, sessions | `src/routes/auth.ts`, `src/lib/auth.ts`, `src/lib/session.ts`, `src/lib/mailer.ts`, `public/signup/`, `public/login/` |
| Billing: Checkout, trial, metering, webhooks | `src/billing/`, `src/routes/billing.ts`, `scripts/stripe-setup.mjs` |
| Serving under app.organizedai.vip/geo-observability | `src/lib/basepath.ts`, `routes` in `wrangler.jsonc` |
| Client portal, landing page, user guide | `public/app/`, `public/index.html`, `docs-src/` → `public/docs/` |
| Schema | `migrations/` (D1, append-only) |
| Infrastructure per environment | `wrangler.jsonc`, `infra/environments.json`, `scripts/infra.mjs` ([infra/README.md](infra/README.md)) |
| CI/CD | `.github/workflows/`, `scripts/deploy.mjs`, `scripts/version.mjs` ([DOCUMENTATION/gitops.md](DOCUMENTATION/gitops.md)) |

---

## Quickstart (local, no accounts)

```bash
npm ci
npm run db:migrate:local && npm run seed:demo:local
npm run dev:offline      # http://localhost:8787 · /app/ (demo workspace) · /docs/
npm run check            # types, lint, Workers tests, script tests, version + infra checks, docs, bundles
```

No Cloudflare login and no provider keys are needed. Engines without a key run on a clearly labelled stub, and Workers AI features fall back to rules, so the whole pipeline runs end to end. `cp .dev.vars.example .dev.vars && npm run dev` runs against real bindings instead.

## Deploy

Git is the only way a change reaches Cloudflare:

```
 pull request ─► ci (PR Gate) + security ─► squash-merge to main
 push to main ─► deploy-staging: checks → staging D1 migrations → wrangler deploy --env staging → /healthz = this commit
 tag vX.Y.Z   ─► release: tag on main · version = package.json = CHANGELOG · every check · staging ran this commit
                  └─► production: D1 migrations → wrangler deploy --tag vX.Y.Z → /healthz = vX.Y.Z → GitHub Release
 rollback     ─► Actions → rollback (or npx wrangler rollback): previous Worker version, D1 untouched
```

```bash
npm run release:prepare -- minor         # [Unreleased] → ## [X.Y.Z] - date, bumps package.json; merge it, then:
git tag -a v1.4.0 -m v1.4.0 && git push origin v1.4.0
npm run infra:plan -- --env staging      # what exists in Cloudflare, what is missing, which required secrets are unset
npm run deploy:staging                   # the same script CI runs; deploy:production is for emergencies
```

One-time setup (API token permissions, GitHub secrets and variables, environments, staging resources) is in [DOCUMENTATION/gitops.md](DOCUMENTATION/gitops.md); secrets and the public address in [DOCUMENTATION/deploy.md](DOCUMENTATION/deploy.md); sign-in email in [DOCUMENTATION/sign-in-email.md](DOCUMENTATION/sign-in-email.md); Stripe in [DOCUMENTATION/stripe-billing.md](DOCUMENTATION/stripe-billing.md).

---

## How it works

```
 Cron 06:00 UTC (daily; weekly projects on Mondays), onboarding "finish" or "Run now"
        │  planPass: active prompts × enabled engines × countries, within plan limits
        ▼
 runs (queued) ─► RunProgress Durable Object (live progress) ─► Queue (dead-letter queue after 3 tries)
        ▼
 ┌─ RunPromptWorkflow, one per prompt × engine × country × day ────────────────────────┐
 │ preflight: workspace active · billing gate · monthly spend cap                      │
 │ ask ─► AI Gateway (metadata: tenant, project, prompt, engine, run; logs, cost, OTel)│
 │          ChatGPT Responses + web search · Claude + web search · Gemini + Google     │
 │          Search · Perplexity Sonar · stub when a key is missing                     │
 │ store raw answer ─► R2                                                              │
 │ score: deterministic mentions + rank ─► Workers AI judge (sentiment, new brands,    │
 │        perception, claims vs your facts) ─► rules fallback                          │
 │ persist ─► D1 (runs, mentions, citations, fan-out queries, claims, usage)           │
 │            Analytics Engine (visibility events)                                     │
 └─────────────────────────────────────────────────────────────────────────────────────┘
        ▼
 hourly: rollups · usage pushed to Stripe meters        09:00: InsightsWorkflow ─► insights + ranked actions

 Observability layer
   edge tap Worker (client zone)      ─► /ingest/edge         AI bots + AI-referred arrivals
   tap.js on any site                 ─► /ingest/hit          AI-referred page views
   sGTM · GA4 · Ads · Meta · Shopify  ─► /ingest/conversion   server-side conversions (event_id dedupe)
        └─► joined on path + day with citations of the client's domains ─► Pages table
```

Metric definitions and the full data model are in [ARCHITECTURE/overview.md](ARCHITECTURE/overview.md); the API in [ARCHITECTURE/API.md](ARCHITECTURE/API.md).

### Design choices

| Choice | Why |
|---|---|
| **Official APIs through AI Gateway, never scraped UIs** | Every answer is reproducible, costed and logged in one place, and nothing signs in to a third-party app. Alexa stays "unavailable" because it has no public answer API. |
| **Deterministic scoring first, LLM judge second** | Mentions and rank come from matching, so the numbers are stable; the judge adds sentiment, perception and claim checks, with a rules fallback when Workers AI is unavailable. |
| **One Workflow per prompt × engine × country × day** | The instance id is the run id, so re-queuing is idempotent and a failed engine retries alone. |
| **Edge capture without log pipelines** | A small tap Worker on the client's zone (or `tap.js`) records AI crawlers and AI referrals directly, so the observability layer works without CDN log exports. |
| **Tenant isolation in one place** | All client data goes through `TenantDB` (`src/lib/db.ts`), where `tenant_id = ?1` is mandatory. |
| **Stub engine, labelled** | A missing key never breaks a pass; the answer is marked as stub everywhere it shows. |
| **Staging mirrors production and shares nothing** | Own Worker, D1, KV, R2, queues, Workflows, datasets and AI Gateway, and no routes. `npm run infra:check` fails CI otherwise. |
| **Releases are tags** | Production changes only from a `vX.Y.Z` tag that agrees with `package.json` and `CHANGELOG.md`; the Worker version carries the tag and `/healthz` reports it. |

## Configuration

Plain vars are in `wrangler.jsonc`; secrets are set with `npx wrangler secret put <NAME> [--env staging]` and listed by environment in [infra/environments.json](infra/environments.json). The main ones:

| Name | Kind | Meaning |
|---|---|---|
| `APP_URL` | var | Public address; its path is the base path (`""` turns it off) |
| `DEMO_MODE` | var | `"true"` serves a read-only demo workspace at `/app/` |
| `OPENAI_MODEL` · `ANTHROPIC_MODEL` · `GEMINI_MODEL` · `PERPLEXITY_MODEL` · `JUDGE_MODEL` | var | Model ids per engine and for the judge |
| `AI_GATEWAY_ID` | var | AI Gateway that every engine call goes through |
| `STRIPE_LIVE_MODE` · `STRIPE_AUTOMATIC_TAX` | var | Both `"false"` until live billing and Stripe Tax are approved |
| `SHARE_LINK_SECRET` · `EMAIL_FROM` | secret | Required: share-link signing; sender for sign-in links |
| `OPENAI_API_KEY` · `ANTHROPIC_API_KEY` · `GEMINI_API_KEY` · `PERPLEXITY_API_KEY` | secret | Engine keys; a missing one means that engine runs on the stub |
| `CLOUDFLARE_ACCOUNT_ID` · `CF_AIG_TOKEN` | secret | Route engine calls through the authenticated AI Gateway |
| `STRIPE_SECRET_KEY` · `STRIPE_WEBHOOK_SECRET` · `STRIPE_BILLING_CONFIG` | secret | Billing; without them signup and card billing stay off |
| `AGENCY_EMAILS` | secret | Staff who see every client workspace |

## Project layout

Organized Codebase layout; [CLAUDE.md](CLAUDE.md) has the conventions and the rules for coding agents.

```
src/                      the Worker
  engines/ · judge/       provider clients through AI Gateway, stub · mention matching, Workers AI judge
  workflows/ · durable/   scheduler, RunPromptWorkflow, pipeline steps · live pass progress
  metrics/ · insights/    reports, filters, rollups · insights, actions, briefs
  observability/          bot and referral classification, ingest, Pages table
  routes/ · mcp/          portal API, /api/v1, auth, billing routes · MCP server
  billing/ · lib/         Stripe client, metering, webhooks · TenantDB, auth, sessions, mailer, base path
public/                   landing page, portal (/app), signup, login, generated docs (/docs), tap.js
docs-src/                 user guide sources (Markdown) → npm run build:docs
edge/                     tap Worker deployed on a client's zone
migrations/               D1 schema, append-only
infra/                    environments.json + README: every resource per environment
scripts/                  deploy, infra, version, docs build, demo seed, offline dev, Stripe setup
test/ · test-scripts/     Workers-runtime tests · tests for the deploy, infra and version tooling
.github/                  workflows, CODEOWNERS, Dependabot, PR template
CONFIG/                   GitHub environments and rulesets as code, Stripe plan
ARCHITECTURE/ · PLANNING/ · SPECIFICATIONS/ · DOCUMENTATION/ · AGENT-HANDOFF/   Organized Codebase docs
```

## Making changes quickly

| To… | Do this |
|---|---|
| Add an engine | Add a client in `src/engines/providers.ts`, register it in `registry.ts`, add its key to `infra/environments.json` |
| Change a model | Edit the `*_MODEL` var in `wrangler.jsonc` (production and staging) |
| Change the schema | Add the next numbered file in `migrations/`; keep it compatible with the running release |
| Add a binding | Add it to production and staging in `wrangler.jsonc` with different names, then `npm run infra:check` and `npm run infra:apply -- --env <env>` |
| Change prices | Edit `CONFIG/stripe-plan.json` and run `npm run stripe:setup` (owner only) |
| Write user docs | Edit `docs-src/`, run `npm run build:docs`, commit `public/docs/` |
| Ship | Pull request → merge (staging) → `npm run release:prepare` → tag (production) |

## Support, contributing and security

- **Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md) (branching, checks, changelog, releases) and [CLAUDE.md](CLAUDE.md) (repo map and rules for coding agents).
- **Security:** see [SECURITY.md](SECURITY.md). Secrets live only in Cloudflare and GitHub secrets; gitleaks, zizmor and Trivy run on every pull request.
- **Changes:** every release is in [CHANGELOG.md](CHANGELOG.md) and on the repository's Releases page.

## Limitations and next steps

- **Engines need keys.** Until provider keys are set, each engine answers from the labelled stub. Model ids are vars and should be checked against each provider's current list.
- **AI Gateway logging** needs `CLOUDFLARE_ACCOUNT_ID` and `CF_AIG_TOKEN` on the Worker and the gateway to exist (`npm run infra:apply` creates it).
- **Alexa** can't be tracked: there is no public way to read Alexa+ answers.
- **Billing** runs in Stripe test mode; live mode and Stripe Tax wait for the owner's go-ahead.
- **GitHub plan.** Required reviewers on production and the `main` and tag rulesets need GitHub Team for a private repository; `CONFIG/github/setup.sh` applies them once available. Until then any `v*` tag deploys production.
- **Test tooling.** `@cloudflare/vitest-pool-workers` is deprecated in favour of `@cloudflare/vitest-plugin`; migrate when convenient.
