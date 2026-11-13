# Billing (Phase 6)

Status: **built, test mode**. Stripe in the "Organized AI - Niceboard" sandbox. The Worker refuses live keys unless `STRIPE_LIVE_MODE` is `"true"`.

## Flow
1. **Signup** — `/signup/` (behind Cloudflare Access for identity) → `POST /api/signup` creates the tenant, an owner membership, a Stripe customer (metadata `tenant_id`, `app=geo-observability`) and a `billing_accounts` row (`provider=stripe`, `status=incomplete`), then returns a Checkout URL. Leaving Checkout and coming back reuses the unfinished workspace.
2. **Checkout** — subscription mode: flat platform price (qty 1) + every metered price; `payment_method_collection=always`; `subscription_data.metadata.tenant_id`. Card is saved on the customer and the subscription starts. Stripe Tax only when `STRIPE_AUTOMATIC_TAX="true"` (off by default; the owner decides).
3. **Webhooks** — `POST /webhooks/stripe`, signature checked (HMAC-SHA256, 5-minute tolerance), event ids stored in `stripe_events` so redeliveries are no-ops, events older than the last applied status change are ignored (`billing_accounts.status_at`). Handled: `checkout.session.completed`, `customer.subscription.created|updated|deleted|paused|resumed`, `invoice.paid`, `invoice.payment_failed`. Live-mode events are ignored on a test deployment.
4. **Metering** — each finished run writes `usage_events` (`answers_run`=1, `llm_cost_micros`=estimated cost). The `20 * * * *` cron rolls finished hours (last 35 days) into `usage_pushes` (identifier `tenant:meter:hour`) and sends pending rows as Stripe meter events (`identifier` = that key, timestamp = middle of the hour), one at a time, oldest first. Pushed rows never change. Rows for workspaces not billed through Stripe are marked `skipped`; a repeat-identifier error counts as pushed; 429/5xx stay `pending` (429 ends the batch); after 24 tries a row becomes `failed`. Meters with no configured Stripe meter are `skipped`.
5. **Customer portal** — `POST /api/billing/portal` (owners) for card changes, invoices, cancel at period end. `POST /api/billing/checkout` restarts Checkout for an `incomplete` or `canceled` workspace.

## Gating
| Status | Runs | Portal |
|---|---|---|
| active, trialing | yes | full |
| past_due | until `grace_until` (`BILLING_GRACE_DAYS`, default 7) | full, banner with Update card |
| incomplete | no | read-only, banner with Add a card |
| unpaid, canceled | no | read-only, data kept |

Agency staff are never locked. Workspaces with no `billing_accounts` row (agency-created) are always active and their usage is never pushed.

## Configuration
- Secrets: `STRIPE_SECRET_KEY` (sk_test_/rk_test_), `STRIPE_WEBHOOK_SECRET`, `STRIPE_BILLING_CONFIG` (JSON: `platform_price`, `metered.{meter}.{event_name,price}`, `portal_config`, optional `trial_days`).
- Vars: `STRIPE_AUTOMATIC_TAX` (`"false"`), `STRIPE_LIVE_MODE` (`"false"`), `BILLING_GRACE_DAYS`, optional `APP_URL`.
- Stripe objects come from `scripts/stripe-setup.mjs` with `CONFIG/stripe-plan.json` (placeholder test prices). API version pinned to `2025-03-31.basil` in both the Worker and the webhook endpoint.

## Not built yet
- Daily reconciliation of D1 usage against AI Gateway cost per tenant.
- `browser_minutes` and `extra_engines` meters (no usage recorded for them yet).
- Plan limits driven by the Stripe price (limits are still the tenant row's defaults).
- Live mode: needs the owner's go-ahead, live Stripe objects (run the setup script with a live key after relaxing its guard deliberately) and `STRIPE_LIVE_MODE="true"`.
