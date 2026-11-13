/**
 * Billing hooks. Billing is deliberately NOT wired to a payment provider yet.
 *
 * What exists:
 *  - every finished run writes usage_events rows (answers_run, llm_cost_micros) keyed by tenant and hour;
 *  - aggregateUsage() rolls them into usage_pushes rows with the idempotency identifier tenant:meter:hour,
 *    which is exactly what a metered-billing push needs, and leaves pushed_at NULL;
 *  - billing_accounts.status gates new runs and drives the portal banner.
 *
 * What a provider integration adds later (see SPECIFICATIONS/billing.md):
 *  - a BillingProvider implementation that sends each unpushed usage_pushes row and sets pushed_at;
 *  - checkout / customer portal routes and a signed webhook route that writes billing_accounts.status.
 */
import type { Env, RunJob } from "../env";
import type { TenantDB } from "../lib/db";
import { hourKey, newId } from "../lib/util";

export type BillingStatus = "active" | "trialing" | "past_due" | "unpaid" | "canceled";
export const METERS = ["answers_run", "llm_cost_micros", "browser_minutes", "extra_engines"] as const;

export interface UsagePush {
  tenantId: string;
  meter: string;
  hour: string;
  quantity: number;
  identifier: string;
}

/** Implement this to connect a billing provider. Must be idempotent on `identifier`. */
export interface BillingProvider {
  name: string;
  pushUsage(env: Env, push: UsagePush): Promise<void>;
}

export const noopProvider: BillingProvider = {
  name: "none",
  async pushUsage() {
    /* no provider configured: rows stay unpushed and are visible on the Usage page */
  },
};

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

/** Hourly: sum usage per tenant, meter and hour into usage_pushes (finished hours only). */
export async function aggregateUsage(env: Env, provider: BillingProvider = noopProvider): Promise<number> {
  const current = hourKey();
  await env.DB.prepare(
    `INSERT INTO usage_pushes (tenant_id, meter, hour, quantity, identifier)
     SELECT tenant_id, meter, hour, SUM(quantity), tenant_id || ':' || meter || ':' || hour
     FROM usage_events WHERE hour < ?1 GROUP BY tenant_id, meter, hour
     ON CONFLICT(tenant_id, meter, hour) DO UPDATE SET quantity = excluded.quantity
     WHERE usage_pushes.pushed_at IS NULL`,
  )
    .bind(current)
    .run();
  if (provider === noopProvider) return 0;
  const pending = await env.DB.prepare("SELECT tenant_id, meter, hour, quantity, identifier FROM usage_pushes WHERE pushed_at IS NULL LIMIT 500").all<{
    tenant_id: string;
    meter: string;
    hour: string;
    quantity: number;
    identifier: string;
  }>();
  let pushed = 0;
  for (const p of pending.results ?? []) {
    await provider.pushUsage(env, { tenantId: p.tenant_id, meter: p.meter, hour: p.hour, quantity: p.quantity, identifier: p.identifier });
    await env.DB.prepare("UPDATE usage_pushes SET pushed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE identifier = ?1").bind(p.identifier).run();
    pushed++;
  }
  return pushed;
}

export async function billingStatus(env: Env, tenantId: string): Promise<{ provider: string; status: BillingStatus; grace_until: string | null }> {
  const row = await env.DB.prepare("SELECT provider, status, grace_until FROM billing_accounts WHERE tenant_id = ?1")
    .bind(tenantId)
    .first<{ provider: string; status: BillingStatus; grace_until: string | null }>();
  return row ?? { provider: "none", status: "active", grace_until: null };
}

/** active / trialing: run. past_due: run until the grace period ends. unpaid / canceled: stop new runs, keep data. */
export async function billingAllowsRuns(env: Env, tenantId: string): Promise<boolean> {
  const b = await billingStatus(env, tenantId);
  if (b.status === "active" || b.status === "trialing") return true;
  if (b.status === "past_due") return !b.grace_until || b.grace_until > new Date().toISOString();
  return false;
}

export function billingBanner(status: BillingStatus): string {
  switch (status) {
    case "past_due":
      return "Your last payment didn't go through. Update your card to keep daily runs going.";
    case "unpaid":
    case "canceled":
      return "Daily runs are paused. Your data is kept and still readable.";
    default:
      return "";
  }
}
