# Stripe billing setup (sandbox)

Everything runs on your Mac, from inside the repo. The sandbox's secret key stays in your shell; nothing asks you to paste it anywhere.

## 1. Get the sandbox key into your shell

In the Stripe dashboard, switch to the **Organized AI - Niceboard** sandbox → Developers → API keys → copy the secret key (`sk_test_…`). Then:

```bash
cd /Users/supabowl/geo-observability
read -rs STRIPE_SECRET_KEY && export STRIPE_SECRET_KEY   # paste, press Enter; nothing is echoed or saved to history
```

## 2. Preview, then create the Stripe objects

```bash
npm run stripe:setup -- --url https://<your worker host> --dry-run
npm run stripe:setup -- --url https://<your worker host> --put-secrets
```

It refuses anything but a test-mode key. It creates (or reuses, on a re-run):
- products and prices from `CONFIG/stripe-plan.json`: a monthly platform price and one metered price per meter (answers run, model spend). **The amounts are placeholders**; change them in that file and re-run.
- Stripe meters `geo_answers_run` and `geo_llm_cost_micros` (sum, mapped by `stripe_customer_id`).
- a customer portal configuration (card update, invoices, cancel at period end).
- the webhook endpoint `<url>/webhooks/stripe` with the events the Worker handles, pinned to API version `2025-03-31.basil`.

`--put-secrets` runs `wrangler secret put` for `STRIPE_SECRET_KEY`, `STRIPE_BILLING_CONFIG` and, when the endpoint is new, `STRIPE_WEBHOOK_SECRET`. Without it, the script prints the commands instead. Use `--wrangler-env staging` for staging.

If the webhook endpoint already existed, Stripe won't hand back its signing secret: reveal it in the dashboard (Developers → Webhooks → the endpoint) and run `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.

## 3. Deploy

```bash
npm run deploy:production   # applies migration 0002_billing.sql, then deploys
```

## 4. Cloudflare Access

- Keep `/webhooks/*` **outside** Access (Stripe signs its requests; Access would block them).
- `/signup/*` must be **inside** Access so the Worker knows who is signing up. For self-serve signup, the Access policy on `/signup*`, `/app*` and `/api*` has to let new people sign in (for example a one-time PIN policy for any email). Who may sign up is your call; until you open it, only people Access already allows can.

## Sales tax

`STRIPE_AUTOMATIC_TAX` is `"false"`. Setting it to `"true"` makes Checkout collect a billing address and calculate tax with Stripe Tax, which needs Stripe Tax set up (registrations, origin address) in the account first. That's a business decision, so it's left off.

## Testing a signup in the sandbox

1. Open `https://<your worker host>/signup/`, sign in through Access, name a workspace, continue.
2. In Checkout use card `4242 4242 4242 4242`, any future expiry, any CVC and postcode.
3. Back in the portal the banner waits for the webhook, then Setup opens. In Stripe (sandbox) the customer has an active subscription with three prices.
4. Run a pass from Setup. About 20 minutes after the hour ends, Usage & API → Billing shows the hour as "Sent to Stripe", and the meter shows the events in Stripe (Billing → Meters).
5. Failed payment: open Manage billing and switch the card to `4000 0000 0000 0341` (it saves, then every charge declines). In the Stripe dashboard create a one-off invoice for that customer and let Stripe charge it. The `invoice.payment_failed` webhook puts the workspace in past due, and the portal shows the banner with the grace date.
6. Cancel from Manage billing → the subscription ends at period end; cancel immediately in the dashboard to see the read-only state.

Stripe CLI shortcut for webhooks while testing locally: `stripe listen --forward-to localhost:8787/webhooks/stripe` and put the `whsec_…` it prints in `.dev.vars`.
