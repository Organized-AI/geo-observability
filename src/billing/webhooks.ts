/**
 * Stripe webhook handling: signed events → billing_accounts.
 *
 * Stripe doesn't promise delivery order, so every status change records the event's `created` time in
 * billing_accounts.status_at and older events are ignored. Each event id is stored in stripe_events,
 * so a redelivery does nothing.
 */
import type { Env } from "../env";
import { nowIso } from "../lib/util";
import { graceDays } from "./config";
import type { BillingStatus } from "./hooks";

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, any> };
}

export const HANDLED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

/** Stripe subscription status → ours. */
export function mapSubscriptionStatus(s: string): BillingStatus {
  switch (s) {
    case "active":
    case "trialing":
    case "past_due":
    case "unpaid":
    case "canceled":
    case "incomplete":
      return s;
    case "incomplete_expired":
      return "canceled";
    case "paused":
      return "unpaid";
    default:
      return "incomplete";
  }
}

interface Account {
  tenant_id: string;
  status: BillingStatus;
  status_at: number | null;
  grace_until: string | null;
  past_due_since: string | null;
}

const idOf = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null);

async function findAccount(env: Env, obj: Record<string, any>): Promise<Account | null> {
  const select = "SELECT tenant_id, status, status_at, grace_until, past_due_since FROM billing_accounts";
  const tenantId = obj?.metadata?.tenant_id ?? obj?.client_reference_id ?? obj?.parent?.subscription_details?.metadata?.tenant_id ?? null;
  if (typeof tenantId === "string") {
    const a = await env.DB.prepare(`${select} WHERE tenant_id = ?1 AND provider = 'stripe'`).bind(tenantId).first<Account>();
    if (a) return a;
  }
  const customer = idOf(obj?.customer);
  if (customer) {
    const a = await env.DB.prepare(`${select} WHERE customer_ref = ?1 AND provider = 'stripe'`).bind(customer).first<Account>();
    if (a) return a;
  }
  return null;
}

/** Writes a status change if the event is not older than the last one applied. Handles the grace period. */
async function applyStatus(env: Env, a: Account, status: BillingStatus, eventCreated: number, extra: Record<string, string | number | null> = {}): Promise<boolean> {
  if (a.status_at != null && eventCreated < a.status_at) return false;
  let grace = a.grace_until;
  let since = a.past_due_since;
  if (status === "past_due") {
    if (a.status !== "past_due" || !grace) {
      since = nowIso();
      grace = new Date(Date.now() + graceDays(env) * 86_400_000).toISOString();
    }
  } else {
    grace = null;
    since = null;
  }
  const cols = Object.keys(extra);
  const sets = cols.map((c, i) => `${c} = ?${i + 6}`).join(", ");
  await env.DB.prepare(
    `UPDATE billing_accounts SET status = ?2, status_at = ?3, grace_until = ?4, past_due_since = ?5${sets ? ", " + sets : ""},
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id = ?1`,
  )
    .bind(a.tenant_id, status, eventCreated, grace, since, ...cols.map((c) => extra[c]))
    .run();
  a.status = status;
  a.status_at = eventCreated;
  a.grace_until = grace;
  a.past_due_since = since;
  return true;
}

function periodEnd(sub: Record<string, any>): string | null {
  const t = sub?.items?.data?.[0]?.current_period_end ?? sub?.current_period_end;
  return typeof t === "number" ? new Date(t * 1000).toISOString() : null;
}

export type WebhookOutcome = "duplicate" | "ignored" | "no_account" | "applied" | "stale";

export async function handleStripeEvent(env: Env, event: StripeEvent): Promise<WebhookOutcome> {
  const seen = await env.DB.prepare("SELECT 1 FROM stripe_events WHERE id = ?1").bind(event.id).first();
  if (seen) return "duplicate";

  const outcome = await apply(env, event);

  await env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, type, tenant_id, created) VALUES (?1, ?2, ?3, ?4)")
    .bind(event.id, event.type, outcome.tenantId, event.created)
    .run();
  return outcome.result;
}

async function apply(env: Env, event: StripeEvent): Promise<{ result: WebhookOutcome; tenantId: string | null }> {
  if (!(HANDLED_EVENTS as readonly string[]).includes(event.type)) return { result: "ignored", tenantId: null };
  const obj = event.data?.object ?? {};
  const a = await findAccount(env, obj);
  if (!a) return { result: "no_account", tenantId: null };
  const done = (ok: boolean) => ({ result: (ok ? "applied" : "stale") as WebhookOutcome, tenantId: a.tenant_id });

  switch (event.type) {
    case "checkout.session.completed": {
      const sub = idOf(obj.subscription);
      await env.DB.prepare(
        "UPDATE billing_accounts SET checkout_ref = ?2, subscription_ref = COALESCE(?3, subscription_ref), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id = ?1",
      )
        .bind(a.tenant_id, obj.id ?? null, sub)
        .run();
      // The subscription events carry the real status; this only lifts a fresh signup out of "incomplete"
      // in case it arrives first. It doesn't set status_at, so the subscription event still applies.
      if (a.status === "incomplete" && (obj.payment_status === "paid" || obj.payment_status === "no_payment_required") && obj.status === "complete") {
        await env.DB.prepare("UPDATE billing_accounts SET status = 'active' WHERE tenant_id = ?1 AND status = 'incomplete'").bind(a.tenant_id).run();
      }
      return done(true);
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
    case "customer.subscription.deleted": {
      const status = event.type === "customer.subscription.deleted" ? "canceled" : mapSubscriptionStatus(String(obj.status ?? ""));
      // The subscription id and the latest period end are kept even from an event that arrives late.
      await env.DB.prepare(
        `UPDATE billing_accounts SET subscription_ref = COALESCE(?2, subscription_ref),
           current_period_end = CASE WHEN ?3 IS NOT NULL AND (current_period_end IS NULL OR ?3 > current_period_end) THEN ?3 ELSE current_period_end END
         WHERE tenant_id = ?1`,
      )
        .bind(a.tenant_id, idOf(obj), periodEnd(obj))
        .run();
      const ok = await applyStatus(env, a, status, event.created, { cancel_at_period_end: obj.cancel_at_period_end ? 1 : 0 });
      return done(ok);
    }
    case "invoice.payment_failed": {
      if (a.status !== "active" && a.status !== "trialing" && a.status !== "past_due") return done(false);
      return done(await applyStatus(env, a, "past_due", event.created));
    }
    case "invoice.paid": {
      if (a.status !== "past_due" && a.status !== "unpaid" && a.status !== "incomplete") return done(false);
      return done(await applyStatus(env, a, "active", event.created));
    }
  }
  return { result: "ignored", tenantId: a.tenant_id };
}
