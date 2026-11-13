/**
 * Billing state shared by the run pipeline, the portal and the hourly cron.
 *
 *  - every finished run writes usage_events rows (answers_run, llm_cost_micros) keyed by tenant and hour;
 *  - aggregateUsage() rolls finished hours into usage_pushes with the idempotency identifier tenant:meter:hour,
 *    then pushes pending rows through a BillingProvider (Stripe meter events, see ./stripe.ts);
 *  - billing_accounts.status, written by the Stripe webhook (./webhooks.ts), gates new runs and portal writes.
 *
 * Workspaces created by agency staff have no billing_accounts row (provider "none") and are always active.
 */
import type { Env, RunJob } from "../env";
import type { TenantDB } from "../lib/db";
import { hourKey, newId } from "../lib/util";

export type BillingStatus = "active" | "trialing" | "past_due" | "unpaid" | "canceled" | "incomplete";
export const METERS = ["answers_run", "llm_cost_micros", "browser_minutes", "extra_engines"] as const;

export interface UsagePush {
  tenantId: string;
  meter: string;
  hour: string;
  quantity: number;
  identifier: string;
}

/** pushed: the provider has it. retry: try again next hour (stop: end this batch, e.g. rate limited). skipped / failed: never billed; kept with the reason. */
export interface PushResult {
  status: "pushed" | "retry" | "skipped" | "failed";
  error?: string;
  stop?: boolean;
}

/** Implement this to connect a billing provider. Must be idempotent on `identifier`. */
export interface BillingProvider {
  name: string;
  pushUsage(env: Env, push: UsagePush & { customer: string }): Promise<PushResult>;
}

export const noopProvider: BillingProvider = {
  name: "none",
  async pushUsage() {
    return { status: "retry" };
  },
};

/** After this many failed tries a row is marked failed and shows on the Usage page instead of retrying forever. */
export const MAX_PUSH_ATTEMPTS = 24;
/** How far back the hourly roll-up looks. Stripe takes events up to 35 days old. */
const AGGREGATE_WINDOW_HOURS = 35 * 24;

export function recordUsage(tdb: TenantDB, job: RunJob, costMicros: number, aigLogId: string | null): D1PreparedStatement[] {
  const hour = hourKey();
  const rows: [string, number][] = [["answers_run", 1]];
  if (costMicros > 0) rows.push(["llm_cost_micros", costMicros]);
  return rows.map(([meter, qty]) =>
    tdb.prepare(
      "INSERT INTO usage_events (id, tenant_id, meter, quantity, run_id, aig_log_id, hour) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)",
      newId("use"),
      meter,
      qty,
      job.runId,
      aigLogId,
      hour,
    ),
  );
}

/** Sum usage per tenant, meter and finished hour into usage_pushes. Pushed rows never change, so re-running is safe. */
export async function rollUpUsage(env: Env, now = new Date()): Promise<void> {
  const current = hourKey(now);
  const from = hourKey(new Date(now.getTime() - AGGREGATE_WINDOW_HOURS * 3600_000));
  await env.DB.prepare(
    `INSERT INTO usage_pushes (tenant_id, meter, hour, quantity, identifier)
     SELECT tenant_id, meter, hour, SUM(quantity), tenant_id || ':' || meter || ':' || hour
     FROM usage_events WHERE hour < ?1 AND hour >= ?2 GROUP BY tenant_id, meter, hour
     ON CONFLICT(tenant_id, meter, hour) DO UPDATE SET quantity = excluded.quantity
     WHERE usage_pushes.state = 'pending'`,
  )
    .bind(current, from)
    .run();
}

/**
 * Hourly: roll up usage, then push pending rows for Stripe-billed workspaces, one at a time and oldest first
 * (Stripe allows one concurrent meter event per customer and meter). Rows for workspaces that aren't billed
 * through Stripe are marked skipped. Returns how many rows were pushed.
 */
export async function aggregateUsage(env: Env, provider: BillingProvider | null = noopProvider, now = new Date()): Promise<number> {
  await rollUpUsage(env, now);
  if (!provider || provider === noopProvider) return 0;

  await env.DB.prepare(
    `UPDATE usage_pushes SET state = 'skipped', last_error = 'workspace not billed through Stripe'
     WHERE state = 'pending' AND tenant_id NOT IN (SELECT tenant_id FROM billing_accounts WHERE provider = 'stripe')`,
  ).run();

  const pending = await env.DB.prepare(
    `SELECT p.tenant_id, p.meter, p.hour, p.quantity, p.identifier, p.attempts, b.customer_ref
     FROM usage_pushes p JOIN billing_accounts b ON b.tenant_id = p.tenant_id
     WHERE p.state = 'pending' AND b.provider = 'stripe' AND b.customer_ref IS NOT NULL
     ORDER BY p.hour, p.tenant_id, p.meter LIMIT 500`,
  ).all<{ tenant_id: string; meter: string; hour: string; quantity: number; identifier: string; attempts: number; customer_ref: string }>();

  let pushed = 0;
  for (const p of pending.results ?? []) {
    let r: PushResult;
    try {
      r = await provider.pushUsage(env, { tenantId: p.tenant_id, meter: p.meter, hour: p.hour, quantity: p.quantity, identifier: p.identifier, customer: p.customer_ref });
    } catch (e) {
      r = { status: "retry", error: String((e as Error)?.message ?? e) };
    }
    if (r.status === "pushed") {
      await env.DB.prepare("UPDATE usage_pushes SET state = 'pushed', pushed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_error = NULL, attempts = attempts + 1 WHERE identifier = ?1 AND state = 'pending'")
        .bind(p.identifier)
        .run();
      pushed++;
    } else if (r.status === "retry") {
      const giveUp = p.attempts + 1 >= MAX_PUSH_ATTEMPTS;
      await env.DB.prepare("UPDATE usage_pushes SET attempts = attempts + 1, last_error = ?2, state = ?3 WHERE identifier = ?1 AND state = 'pending'")
        .bind(p.identifier, (r.error ?? "will retry").slice(0, 500), giveUp ? "failed" : "pending")
        .run();
      if (r.stop) break;
    } else {
      await env.DB.prepare("UPDATE usage_pushes SET attempts = attempts + 1, last_error = ?2, state = ?3 WHERE identifier = ?1 AND state = 'pending'")
        .bind(p.identifier, (r.error ?? r.status).slice(0, 500), r.status)
        .run();
    }
  }
  return pushed;
}

export interface BillingInfo {
  provider: string;
  status: BillingStatus;
  grace_until: string | null;
  customer_ref: string | null;
  subscription_ref: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

export async function billingStatus(env: Env, tenantId: string): Promise<BillingInfo> {
  const row = await env.DB.prepare(
    "SELECT provider, status, grace_until, customer_ref, subscription_ref, current_period_end, cancel_at_period_end FROM billing_accounts WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .first<Omit<BillingInfo, "cancel_at_period_end"> & { cancel_at_period_end: number | null }>();
  if (!row) return { provider: "none", status: "active", grace_until: null, customer_ref: null, subscription_ref: null, current_period_end: null, cancel_at_period_end: false };
  return { ...row, cancel_at_period_end: !!row.cancel_at_period_end };
}

/** active / trialing: run. past_due: run until the grace period ends. incomplete / unpaid / canceled: no new runs, data kept. */
export function statusAllowsRuns(status: BillingStatus, graceUntil: string | null, now = new Date()): boolean {
  if (status === "active" || status === "trialing") return true;
  if (status === "past_due") return !graceUntil || graceUntil > now.toISOString();
  return false;
}

export async function billingAllowsRuns(env: Env, tenantId: string): Promise<boolean> {
  const b = await billingStatus(env, tenantId);
  return statusAllowsRuns(b.status, b.grace_until);
}

/** Statuses that make the workspace read-only for its own users (agency staff can still edit). Billing pages stay open to owners. */
export function billingLocks(status: BillingStatus): boolean {
  return status === "incomplete" || status === "unpaid" || status === "canceled";
}

export function billingBanner(status: BillingStatus, graceUntil: string | null = null, now = new Date()): string {
  switch (status) {
    case "incomplete":
      return "Add a card to start your workspace. Nothing is charged for usage until answers run.";
    case "past_due":
      if (graceUntil && graceUntil > now.toISOString()) {
        return `Your last payment didn't go through. Update your card by ${graceUntil.slice(0, 10)} to keep daily runs going.`;
      }
      return "Your last payment didn't go through, so new runs are paused. Update your card to start them again.";
    case "unpaid":
      return "Daily runs are paused because of an unpaid invoice. Your data is kept and still readable.";
    case "canceled":
      return "Your subscription has ended, so daily runs are paused. Your data is kept and still readable.";
    default:
      return "";
  }
}
