# Billing (Phase 6) — not built yet

Status: **hooks only**. Nothing talks to a payment provider. Waiting on a Stripe sandbox for the "Organized AI - Niceboard" account.

## Already in place
- `usage_events` row per finished run: `answers_run` = 1, `llm_cost_micros` = estimated model cost, with the AI Gateway log id.
- Hourly cron rolls usage into `usage_pushes` with identifier `tenant:meter:hour` (the idempotency key a metered push needs), `pushed_at` NULL.
- `billing_accounts.status` (active, trialing, past_due, unpaid, canceled) gates new runs (`billingAllowsRuns`) and drives the portal banner (`billingBanner`). Missing row = active.
- `BillingProvider` interface in `src/billing/hooks.ts`; `aggregateUsage(env, provider)` pushes unpushed rows through it.

## To add when the sandbox exists
1. `StripeBillingProvider.pushUsage`: one meter event per usage_pushes row, identifier as the event identifier; retry 429 with backoff.
2. Routes: `POST /api/billing/checkout` (Checkout in subscription mode: flat platform price + metered prices; metadata `app=geo-observability`), `POST /api/billing/portal` (customer portal), `POST /webhooks/stripe` (signature verified with `constructEventAsync`; handles checkout.session.completed, customer.subscription.*, invoice.paid, invoice.payment_failed → billing_accounts).
3. Secrets: STRIPE_SECRET_KEY (sk_test_ until live is approved), STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_PLATFORM, meter event names.
4. Daily reconciliation of D1 usage against AI Gateway cost per tenant.
5. Docs: "Card and invoices" and "When a payment fails" pages under Plans and usage.
