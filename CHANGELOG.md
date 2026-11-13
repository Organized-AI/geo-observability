# Changelog

## 1.2.0
- Public signup: email and workspace name, then Stripe Checkout; you come back signed in. No Cloudflare Access needed.
- Email sign-in at /login/: single-use 15-minute links (hashed), confirm-button page, HttpOnly session cookie, rate limits, sign out.
- Email through Cloudflare Email Service (`send_email` binding, `EMAIL_FROM`), Resend as a fallback, D1 outbox for local development.
- Same-origin check on cookie-authenticated writes; domain auto-join only for confirmed emails. Cloudflare Access stays optional for staff.
- Sign up and Sign in links on the landing page.

## 1.1.0
- Billing (Phase 6): self-serve signup with card on file through Stripe Checkout (subscription: platform fee + metered prices), Stripe customer portal for card changes, invoices and cancellation.
- Usage pushed hourly to Stripe meter events with idempotent `tenant:meter:hour` identifiers; pending/pushed/skipped/failed states with retries.
- Signed Stripe webhooks with event dedupe and out-of-order protection; grace period on failed payments, then paused runs; read-only workspace when unpaid or canceled, data kept.
- `scripts/stripe-setup.mjs`: idempotent sandbox setup (products, prices, meters, portal configuration, webhook) that refuses non-test keys and can set the Worker secrets.
- Stripe Tax behind `STRIPE_AUTOMATIC_TAX`, off by default. Docs: Card and invoices, When a payment fails.

## 1.0.0
- Prompt tracking across ChatGPT, Claude, Gemini, Perplexity via AI Gateway; stub engine fallback; Alexa listed as unavailable.
- Scoring: mentions, position, sentiment, win rate, citations (cited vs used), fan-out queries, perception and fact-checks.
- Client portal, onboarding with first pass and live progress, saved views, share links, CSV export.
- Observability layer: edge tap Worker, tap.js, conversion ingest with dedupe, Pages table.
- Insights, actions, content briefs; REST API v1; MCP server; spend cap; OTel export.
- Billing hooks (usage logging, gating); no provider.
