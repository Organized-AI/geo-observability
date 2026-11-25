# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow `X.Y.Z` ([Semantic Versioning](https://semver.org/)). Add a line under `[Unreleased]` for anything a user or operator would notice; `npm run release:prepare -- patch|minor|major` turns it into a version (see CONTRIBUTING.md).

## [Unreleased]

### Added

- Personal tracing keys for Claude Code and Codex: every turn sent with one belongs to its person, whatever the machine claims. Make one under Traces, Send traces.
- A workspace capture level for coding tools (everything, prompts and answers, or usage only), set by an owner and enforced when traces arrive.
- Secrets (API keys, tokens, passwords, private keys) are replaced before a turn leaves the machine and again on arrival.
- The installer prints what it will send, under which name, and who can read it.
- A monthly span allowance per workspace (2,000,000 by default), shown under Traces with a warning at 80%. Past it, new traces are refused with 429 until the next month.
- Large span bodies are kept in R2, so the database holds short previews; the span view and exports still show everything.

### Changed

- Coding-tool prompts, answers and daily reports are visible only to their person and to workspace owners. Usage numbers stay visible to the workspace.

## [1.5.0] - 2026-11-23

### Added
- LLM tracing: send traces from your own LLM apps over OpenTelemetry (OTLP over HTTP, protobuf or JSON) to `/ingest/otlp/v1/traces` with an ingest key. Spans carrying OpenInference or OpenTelemetry `gen_ai` attributes show their model, messages, tool calls, retrieved documents, tokens and cost.
- A **Traces** page in the portal: runs by app with error, search and date filters, conversations grouped by session, and a trace page with the span tree, a timeline and the detail of each step. The demo workspace has sample traces.
- Claude Code and Codex as trace sources: `geo-trace.mjs` (served at `/trace/geo-trace.mjs`) connects a person's machine with one command and sends each turn as a trace with its model calls, token counts and tool calls. Prompts and answers are sent by default and can be switched off; tool inputs and outputs are off unless switched on. It works with subscription logins and can be rolled out through managed settings. `import` sends the sessions already on a machine.
- A **People** tab under Traces: tools, sessions, turns and tokens per person, with a filter from a person to their traces.
- A page per person: tools with failure rates and timing, skills, plugins, MCP servers, subagents, slash commands, shell programs, models, projects and sessions. The geo-trace script now sends these names with every tool call (never the inputs).
- Daily reports per person, written after each day: the day's numbers against their own previous week, with observations labelled Watch, Try or Good. Rules only; nothing reads what was typed.
- Across the team, on the People tab: how many people use skills, subagents, plugins, MCP servers and slash commands, who uses each, and what stands out. A person's page shows the change from the period before.
- People and daily reports count coding-tool users only; end users of your own apps show when that app is chosen.
- A turn sent live and imported later is stored once, and a turn imported while still running is completed by its finished copy.
- Quarterly retention: traces are deleted 92 days after they start (hourly job; `TRACE_RETENTION_DAYS` changes the window). The Traces page says when traces are within 14 days of deletion.
- Export from the Traces page, using the filters on screen: traces as CSV, full traces with every step as JSON Lines, and people as CSV.
- `/api/tracing` for the portal (apps, traces, spans, sessions, people, setup) and three user guide pages under Integrations.
- Migrations `0006_llm_tracing.sql` (`trace_apps`, `llm_spans`, `llm_traces`) `0007_trace_people.sql` and `0008_trace_retention.sql` (indexes) `0009_trace_person_reports.sql` (`trace_reports`) and `0010_trace_app_kind.sql`. Apply them before deploying.

## [1.4.1] - 2026-11-14

### Changed
- New logo (a human hand shaking a robot hand) in the header of every page, the user guide and the 3D map, as the favicon and home-screen icon, on the social share image (`/brand/og.png`) and in the README.

## [1.4.0] - 2026-11-14

### Added
- GitOps like Organized-AI/podcast-agent: a PR Gate on every pull request, security scans, staging deployed from `main`, production deployed from a `vX.Y.Z` tag with a GitHub Release from this file, and a rollback workflow (DOCUMENTATION/gitops.md). The workflows are parked in `CONFIG/github-workflows/` until they are moved into `.github/workflows/`.
- Infrastructure as code: `infra/environments.json` plus `wrangler.jsonc` declare every resource per environment; `npm run infra:plan|infra:apply -- --env <env>` lists or creates what is missing (D1, KV, R2, queues and dead-letter queues, AI Gateway) and checks which Worker secrets are set (names only). `npm run infra:check` runs offline in CI: staging mirrors production's bindings and vars and shares none of its resources.
- One version everywhere: `npm run version:check` (package.json, package-lock.json, CHANGELOG), `npm run release:prepare`. Deploys stamp the Worker version with the release tag and set `APP_VERSION` and `GIT_COMMIT`; `/healthz` reports them and the deploy script checks it after every deploy.
- How it works in 3D at `/how-it-works/`: the system as an interactive three.js map (orbit, flow, explode, top view, a guided loop and a breakdown of each of the ten parts), linked from the landing page footer. three.js r128 is vendored in `public/vendor/`.
- `CONFIG/github/setup.sh`: creates the `staging` and `production` environments and the `main` and `v*` tag rulesets with `gh`.

### Changed
- The Organized AI look across the app, matching DealCon: paper, ink and yellow, a black header bar, IBM Plex Sans and Mono with Source Serif 4 headings, in the landing page, portal, signup, sign-in, user guide and the 3D map, light and dark.
- The README is product-level: diagrams (Mermaid) and an animated preview of the 3D map instead of ids, prices and secret lists.

### Fixed
- `npm run dev:offline` works again without a Cloudflare login: the email binding runs locally instead of remotely.
- Staging inherited production's routes, so a staging deploy would have taken `app.organizedai.vip/geo-observability` from production. Staging now has no routes, an empty `APP_URL` and its own dead-letter queue.

## [1.3.1] - 2026-11-13
- Pricing: 14-day free trial (card collected at signup), then $150 a month per workspace plus token usage at cost. The per-answer charge is gone. Rerun `npm run stripe:setup -- --put-secrets` to create the new Stripe prices; existing subscriptions keep their old prices.

## [1.3.0] - 2026-11-13
- Served at https://app.organizedai.vip/geo-observability through two Workers routes on this Worker (they take precedence over the organizedai-vanity-router on that host, which is left untouched).
- `APP_URL` may carry a base path. Under it the Worker strips the path, rewrites root-relative links in HTML, prefixes its redirects and scopes the session cookie to the path (`__Secure-geo_session`, so other apps on the host never see it). Sign-in links, Stripe returns, share links and tracking snippets use the public address.
- Page loads on the workers.dev address redirect to APP_URL; the API, ingest, MCP, tap.js and the Stripe webhook keep answering there. `APP_URL=""` turns the base path and the redirect off.

## [1.2.4] - 2026-11-13
- Email Service gets the sender as a plain address string, as in Cloudflare's example; a malformed EMAIL_FROM is caught before sending and the error names what is set.

## [1.2.3] - 2026-11-13
- Sign-in email failures are visible: every send is logged in `email_log` (migration 0005) with the provider's error code, `/login/`, signup and the post-Checkout page say why a send failed, and owners get a Sign-in email card on Usage & API with a test button (`GET /api/email/status`, `POST /api/email/test`).
- EMAIL_FROM can be written as `Name <address>`.

## [1.2.2] - 2026-11-13
- The workspace turns active as soon as Stripe confirms the Checkout payment on the return page, so setup never stalls waiting for the webhook.
- Setup's first step starts from the workspace name and website given at signup.
- End-to-end journey test: signup, Checkout, return, setup, first run, reports, site tracking, metered billing, sign out.

## [1.2.1] - 2026-11-13
- Starter includes all four engines (migration 0004 raises existing Starter workspaces). Setup shows plan limits and stops at them; limit errors show their real message.
- Stripe client works on Workers (fetch called as a plain function); stored Stripe key is cleaned of stray whitespace; signup shows Stripe's real error and reuses a half-made workspace.

## [1.2.0] - 2026-11-13
- Public signup: email and workspace name, then Stripe Checkout; you come back signed in. No Cloudflare Access needed.
- Email sign-in at /login/: single-use 15-minute links (hashed), confirm-button page, HttpOnly session cookie, rate limits, sign out.
- Email through Cloudflare Email Service (`send_email` binding, `EMAIL_FROM`), Resend as a fallback, D1 outbox for local development.
- Same-origin check on cookie-authenticated writes; domain auto-join only for confirmed emails. Cloudflare Access stays optional for staff.
- Sign up and Sign in links on the landing page.

## [1.1.0] - 2026-11-13
- Billing (Phase 6): self-serve signup with card on file through Stripe Checkout (subscription: platform fee + metered prices), Stripe customer portal for card changes, invoices and cancellation.
- Usage pushed hourly to Stripe meter events with idempotent `tenant:meter:hour` identifiers; pending/pushed/skipped/failed states with retries.
- Signed Stripe webhooks with event dedupe and out-of-order protection; grace period on failed payments, then paused runs; read-only workspace when unpaid or canceled, data kept.
- `scripts/stripe-setup.mjs`: idempotent sandbox setup (products, prices, meters, portal configuration, webhook) that refuses non-test keys and can set the Worker secrets.
- Stripe Tax behind `STRIPE_AUTOMATIC_TAX`, off by default. Docs: Card and invoices, When a payment fails.

## [1.0.0] - 2026-11-13
- Prompt tracking across ChatGPT, Claude, Gemini, Perplexity via AI Gateway; stub engine fallback; Alexa listed as unavailable.
- Scoring: mentions, position, sentiment, win rate, citations (cited vs used), fan-out queries, perception and fact-checks.
- Client portal, onboarding with first pass and live progress, saved views, share links, CSV export.
- Observability layer: edge tap Worker, tap.js, conversion ingest with dedupe, Pages table.
- Insights, actions, content briefs; REST API v1; MCP server; spend cap; OTel export.
- Billing hooks (usage logging, gating); no provider.
