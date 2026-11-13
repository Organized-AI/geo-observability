# GEO Observability

AI search visibility (AEO/GEO) tracking with an observability layer, for client brands. Tracks prompts across ChatGPT, Claude, Gemini and Perplexity through Cloudflare AI Gateway, scores visibility, share of voice, position, sentiment and citations, and joins AI crawler hits, AI referral sessions and server-side conversions to the pages answers cite. Client portal on Workers Paid with per-client access.

## Tech stack
- Runtime: Cloudflare Workers (TypeScript), Hono routing, Worker Assets for the portal, landing page and docs
- Data: D1 (facts and rollups), R2 (raw answers), KV (config, rate limits), Analytics Engine (time series)
- Jobs: Cron Triggers → Queues → Workflows (one instance per prompt × engine × country × day); Durable Object for live pass progress
- AI: provider APIs through AI Gateway; Workers AI judge; stub engine when a key is missing
- Front end: vanilla JS modules + GSAP (vendored in public/vendor); docs built from docs-src with marked
- Tests: Vitest in the Workers runtime (@cloudflare/vitest-pool-workers)

## Project structure
- `src/engines/` provider clients + stub + registry · `src/judge/` mention matching and LLM judge
- `src/metrics/` filters, reports, rollups · `src/observability/` bot/referral classify, ingest, Pages table
- `src/workflows/` scheduler, pipeline steps, Workflow classes · `src/insights/` insights and actions
- `src/routes/` portal API, public v1 API · `src/mcp/` MCP server · `src/billing/` Stripe client, metering push, webhooks, gating · `src/routes/billing.ts` signup/checkout/portal/webhook
- `public/app` portal · `public/signup` self-serve signup · `public/index.html` landing · `public/docs` generated docs · `edge/` client-zone tap Worker
- `migrations/` D1 schema · `scripts/` docs build, demo seed, offline dev, lint · `test/` unit + integration

## Code conventions
- All client data access goes through `TenantDB` (`src/lib/db.ts`): `tenant_id = ?1` is mandatory, extra params start at `?2`. Use `Binds` for dynamic SQL.
- Report queries start from `runsCte()`; join mentions/citations as `FROM r CROSS JOIN mentions m ON m.run_id = r.id`.
- Money is integer micros. Dates are UTC `YYYY-MM-DD`.
- Errors: throw `HttpError(status, code, message)`; messages are user-facing and plain.
- Identity: `identify()` in `src/lib/auth.ts` (session cookie from an emailed link → optional Cloudflare Access → dev email). Store only SHA-256 of tokens. Domain auto-join needs a verified email. State-changing routes call `assertSameOrigin`.

## DO NOT
- Don't write SQL outside `TenantDB` for tenant data, and don't pass unused binds (D1 rejects them).
- Don't edit an applied migration; add a new numbered file.
- Don't scrape assistant UIs or sign in to third-party apps; engines use official APIs only. Alexa stays "unavailable".
- Don't copy any competitor's docs, copy, branding or code. Docs in docs-src are written fresh.
- Don't add time estimates to plans or docs.
- Billing is Stripe in test mode (see SPECIFICATIONS/billing.md). Don't switch on live mode, Stripe Tax or change prices without the owner's go-ahead, and never create Stripe objects from an agent session: `scripts/stripe-setup.mjs` is run by the owner.
- Never commit secrets. Commits are authored by Jordan Hill; no AI co-author trailers.

## Delivery (GitOps, see DOCUMENTATION/gitops.md)
- Staging deploys from `main`; production only from a `vX.Y.Z` tag through the release workflow. Don't deploy production from an agent session.
- Add user-visible changes under `## [Unreleased]` in CHANGELOG.md. Don't bump the version or tag unless asked; `npm run release:prepare` does both files.
- New bindings go into production and staging in `wrangler.jsonc` with different resource names; `npm run infra:check` must pass. Never give staging production's routes or resources.
- Workflows live in `.github/workflows/` (or are parked in `CONFIG/github-workflows/` when the pushing app lacks the workflows permission). Pin every action to a commit SHA.

## Verification requirements
Before completing any task:
1. Say how you'll verify it.
2. `npm run check` (typecheck, lint, tests, docs build, bundle dry run) must pass.
3. For UI changes: run `npm run dev:offline` after `npm run db:migrate:local && npm run seed:demo:local`, open http://localhost:8787/app/ and check desktop, 375px and dark mode.
