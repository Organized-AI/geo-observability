-- Phase 6: Stripe billing. Card on file at signup, usage pushed hourly to Stripe meters, webhooks set status.

-- billing_accounts.status now also takes 'incomplete' (signed up, no card yet: runs off, read-only).
ALTER TABLE billing_accounts ADD COLUMN status_at INTEGER;          -- Stripe event `created` (unix s) of the last status change applied; older events are ignored
ALTER TABLE billing_accounts ADD COLUMN past_due_since TEXT;
ALTER TABLE billing_accounts ADD COLUMN current_period_end TEXT;
ALTER TABLE billing_accounts ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_accounts ADD COLUMN checkout_ref TEXT;          -- last Checkout Session id
CREATE INDEX billing_accounts_customer ON billing_accounts(customer_ref);

-- usage_pushes: pending | pushed | skipped (never billable, e.g. a workspace not billed through Stripe) | failed (gave up)
ALTER TABLE usage_pushes ADD COLUMN state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE usage_pushes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_pushes ADD COLUMN last_error TEXT;
UPDATE usage_pushes SET state = 'pushed' WHERE pushed_at IS NOT NULL;
CREATE INDEX usage_pushes_state ON usage_pushes(state, hour);
CREATE INDEX usage_events_hour ON usage_events(hour);

-- Every Stripe webhook event we processed, so a redelivery is a no-op.
CREATE TABLE stripe_events (
  id          TEXT PRIMARY KEY,                  -- evt_...
  type        TEXT NOT NULL,
  tenant_id   TEXT,
  created     INTEGER NOT NULL,                  -- Stripe's event timestamp (unix s)
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
