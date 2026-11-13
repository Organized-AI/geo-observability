# Changelog

## 1.2.4
- Email Service gets the sender as a plain address string, as in Cloudflare's example; a malformed EMAIL_FROM is caught before sending and the error names what is set.

## 1.2.3
- Sign-in email failures are visible: every send is logged in `email_log` (migration 0005) with the provider's error code, `/login/`, signup and the post-Checkout page say why a send failed, and owners get a Sign-in email card on Usage & API with a test button (`GET /api/email/status`, `POST /api/email/test`).
- EMAIL_FROM can be written as `Name <address>`.

## 1.2.2
- The workspace turns active as soon as Stripe confirms the Checkout payment on the return page, so setup never stalls waiting for the webhook.
- Setup's first step starts from the workspace name and website given at signup.
- End-to-end journey test: signup, Checkout, return, setup, first run, reports, site tracking, metered billing, sign out.

## 1.2.1
- Starter includes all four engines (migration 0004 raises existing Starter workspaces). Setup shows plan limits and stops at them; limit errors show their real message.
- Stripe client works on Workers (fetch called as a plain function); stored Stripe key is cleaned of stray whitespace; signup shows Stripe's real error and reuses a half-made workspace.

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
