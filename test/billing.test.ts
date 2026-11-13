import { env as rawEnv, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { aggregateUsage, billingAllowsRuns, billingLocks, billingStatus, statusAllowsRuns, type BillingProvider, type PushResult } from "../src/billing/hooks";
import { billingEnabled, keyMode, parseBillingConfig } from "../src/billing/config";
import { checkoutParams, formEncode, hourTimestamp, stripeProvider, stripeSignature, verifyStripeSignature } from "../src/billing/stripe";
import { mapSubscriptionStatus } from "../src/billing/webhooks";
import { hourKey } from "../src/lib/util";

const env = rawEnv as unknown as Env;
const SECRET = "whsec_test_geo_observability_0123456789";
const CONFIG = {
  platform_price: "price_platform",
  metered: {
    answers_run: { event_name: "geo_answers_run", price: "price_answers" },
    llm_cost_micros: { event_name: "geo_llm_cost_micros", price: "price_llm" },
  },
  portal_config: "bpc_test",
};

async function call(method: string, path: string, body?: unknown, tenant?: string) {
  const res = await SELF.fetch(`https://geo.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...(tenant ? { "x-tenant": tenant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json };
}

let seq = 0;
const nowSec = () => Math.floor(Date.now() / 1000);

async function sendEvent(type: string, object: Record<string, unknown>, opts: { created?: number; id?: string; livemode?: boolean; secret?: string } = {}) {
  const event = { id: opts.id ?? `evt_${++seq}_${type.replace(/\W/g, "")}`, object: "event", type, created: opts.created ?? nowSec(), livemode: opts.livemode ?? false, data: { object } };
  const payload = JSON.stringify(event);
  const t = nowSec();
  const sig = await stripeSignature(opts.secret ?? SECRET, t, payload);
  const res = await SELF.fetch("https://geo.test/webhooks/stripe", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` }, body: payload });
  return { status: res.status, json: (await res.json()) as { outcome?: string; error?: string }, event };
}

let billed = ""; // Stripe-billed workspace
let comped = ""; // agency workspace with no billing row

beforeAll(async () => {
  billed = (await call("POST", "/api/tenants", { name: "Billed Client", slug: "billed" })).json.id;
  comped = (await call("POST", "/api/tenants", { name: "Comped Client", slug: "comped" })).json.id;
  await env.DB.prepare("INSERT INTO billing_accounts (tenant_id, provider, customer_ref, status) VALUES (?1, 'stripe', 'cus_billed', 'incomplete')").bind(billed).run();
});

describe("Stripe helpers", () => {
  it("form-encodes nested params the way Stripe expects", () => {
    const s = formEncode({ a: 1, line_items: [{ price: "p1", quantity: 1 }, { price: "p2" }], meta: { k: "v w" }, skip: undefined, nul: null });
    expect(decodeURIComponent(s)).toBe("a=1&line_items[0][price]=p1&line_items[0][quantity]=1&line_items[1][price]=p2&meta[k]=v w");
  });

  it("verifies webhook signatures and rejects tampering, wrong secrets and old timestamps", async () => {
    const payload = '{"id":"evt_1"}';
    const t = nowSec();
    const good = await stripeSignature(SECRET, t, payload);
    expect(await verifyStripeSignature(payload, `t=${t},v1=${good}`, SECRET)).toBe(true);
    expect(await verifyStripeSignature(payload, `t=${t},v1=deadbeef,v1=${good}`, SECRET)).toBe(true);
    expect(await verifyStripeSignature(payload + " ", `t=${t},v1=${good}`, SECRET)).toBe(false);
    expect(await verifyStripeSignature(payload, `t=${t},v1=${good}`, "whsec_other")).toBe(false);
    const old = t - 3600;
    expect(await verifyStripeSignature(payload, `t=${old},v1=${await stripeSignature(SECRET, old, payload)}`, SECRET)).toBe(false);
    expect(await verifyStripeSignature(payload, null, SECRET)).toBe(false);
    expect(await verifyStripeSignature(payload, "garbage", SECRET)).toBe(false);
  });

  it("builds a subscription Checkout with the platform price, every metered price and tax off by default", () => {
    const cfg = parseBillingConfig(JSON.stringify(CONFIG))!;
    const p = checkoutParams(cfg, { customer: "cus_1", tenantId: "ten_1", origin: "https://geo.test", automaticTax: false }) as Record<string, any>;
    expect(p.mode).toBe("subscription");
    expect(p.customer).toBe("cus_1");
    expect(p.client_reference_id).toBe("ten_1");
    expect(p.line_items).toEqual([{ price: "price_platform", quantity: 1 }, { price: "price_answers" }, { price: "price_llm" }]);
    expect(p.subscription_data.metadata.tenant_id).toBe("ten_1");
    expect(p.automatic_tax).toBeUndefined();
    expect(p.success_url).toBe("https://geo.test/auth/checkout-return?cs={CHECKOUT_SESSION_ID}");
    const taxed = checkoutParams(cfg, { customer: "cus_1", tenantId: "ten_1", origin: "https://geo.test", automaticTax: true }) as Record<string, any>;
    expect(taxed.automatic_tax).toEqual({ enabled: true });
    expect(taxed.billing_address_collection).toBe("required");
  });

  it("only accepts test keys unless live mode is switched on", () => {
    expect(keyMode("sk_test_abc")).toBe("test");
    expect(keyMode("rk_test_abc")).toBe("test");
    expect(keyMode("sk_live_abc")).toBe("live");
    expect(keyMode("pk_test_abc")).toBe("invalid");
    const base = { ...env, STRIPE_BILLING_CONFIG: JSON.stringify(CONFIG) } as Env;
    expect(billingEnabled({ ...base, STRIPE_SECRET_KEY: "sk_test_abc" })).toBe(true);
    expect(billingEnabled({ ...base, STRIPE_SECRET_KEY: "sk_live_abc" })).toBe(false);
    expect(billingEnabled({ ...base, STRIPE_SECRET_KEY: "sk_live_abc", STRIPE_LIVE_MODE: "true" })).toBe(true);
    expect(billingEnabled({ ...base, STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_BILLING_CONFIG: "{bad" })).toBe(false);
    expect(parseBillingConfig(JSON.stringify({ ...CONFIG, platform_price: "nope" }))).toBeNull();
  });

  it("maps Stripe subscription statuses", () => {
    expect(mapSubscriptionStatus("active")).toBe("active");
    expect(mapSubscriptionStatus("incomplete_expired")).toBe("canceled");
    expect(mapSubscriptionStatus("paused")).toBe("unpaid");
    expect(mapSubscriptionStatus("something_new")).toBe("incomplete");
  });
});

describe("signup and billing routes without Stripe configured", () => {
  it("reports signup as closed and refuses to create a workspace", async () => {
    const r = await call("GET", "/api/signup");
    expect(r.status).toBe(200);
    expect(r.json.open).toBe(false);
    const p = await call("POST", "/api/signup", { name: "New Co" });
    expect(p.status).toBe(503);
    expect(p.json.error).toBe("billing_off");
  });

  it("shows billing status for a workspace", async () => {
    const r = await call("GET", "/api/billing", undefined, "billed");
    expect(r.status).toBe(200);
    expect(r.json.provider).toBe("stripe");
    expect(r.json.status).toBe("incomplete");
    expect(r.json.locked).toBe(true);
    const c = await call("GET", "/api/billing", undefined, "comped");
    expect(c.json.provider).toBe("none");
    expect(c.json.locked).toBe(false);
  });
});

describe("Stripe webhook", () => {
  it("rejects a bad signature", async () => {
    const r = await sendEvent("customer.subscription.created", { customer: "cus_billed", status: "active" }, { secret: "whsec_wrong" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("bad_signature");
  });

  it("walks a subscription through active, failed payment, recovery and cancellation", async () => {
    const t0 = nowSec() - 100;
    const periodEnd = t0 + 30 * 86400;
    const sub = { id: "sub_1", object: "subscription", customer: "cus_billed", status: "active", metadata: { tenant_id: billed }, items: { data: [{ current_period_end: periodEnd }] } };

    const created = await sendEvent("customer.subscription.created", sub, { created: t0 });
    expect(created.json.outcome).toBe("applied");
    let b = await billingStatus(env, billed);
    expect(b.status).toBe("active");
    expect(b.subscription_ref).toBe("sub_1");
    expect(b.current_period_end).toBe(new Date(periodEnd * 1000).toISOString());
    expect(await billingAllowsRuns(env, billed)).toBe(true);

    // Redelivery of the same event is a no-op.
    const again = await sendEvent("customer.subscription.created", sub, { created: t0, id: created.event.id });
    expect(again.json.outcome).toBe("duplicate");

    const failed = await sendEvent("invoice.payment_failed", { id: "in_1", customer: "cus_billed" }, { created: t0 + 10 });
    expect(failed.json.outcome).toBe("applied");
    b = await billingStatus(env, billed);
    expect(b.status).toBe("past_due");
    const graceMs = Date.parse(b.grace_until!) - Date.now();
    expect(graceMs).toBeGreaterThan(6.9 * 86_400_000);
    expect(graceMs).toBeLessThan(7.1 * 86_400_000);
    expect(await billingAllowsRuns(env, billed)).toBe(true); // still inside the grace period

    // An older event arriving late doesn't undo the newer status.
    const late = await sendEvent("customer.subscription.updated", { ...sub, status: "active" }, { created: t0 + 5 });
    expect(late.json.outcome).toBe("stale");
    expect((await billingStatus(env, billed)).status).toBe("past_due");

    const paid = await sendEvent("invoice.paid", { id: "in_1", customer: "cus_billed" }, { created: t0 + 20 });
    expect(paid.json.outcome).toBe("applied");
    b = await billingStatus(env, billed);
    expect(b.status).toBe("active");
    expect(b.grace_until).toBeNull();

    const deleted = await sendEvent("customer.subscription.deleted", { ...sub, status: "canceled" }, { created: t0 + 30 });
    expect(deleted.json.outcome).toBe("applied");
    b = await billingStatus(env, billed);
    expect(b.status).toBe("canceled");
    expect(await billingAllowsRuns(env, billed)).toBe(false);
    expect(billingLocks(b.status)).toBe(true);

    // Put it back to active for the metering tests.
    await sendEvent("customer.subscription.updated", { ...sub, status: "active" }, { created: t0 + 40 });
    expect((await billingStatus(env, billed)).status).toBe("active");
  });

  it("ignores live-mode events, unknown customers and unhandled types", async () => {
    expect((await sendEvent("customer.subscription.deleted", { customer: "cus_billed", status: "canceled" }, { livemode: true })).json.outcome).toBe("ignored");
    expect((await billingStatus(env, billed)).status).toBe("active");
    expect((await sendEvent("customer.subscription.updated", { customer: "cus_nobody", status: "active" })).json.outcome).toBe("no_account");
    expect((await sendEvent("charge.refunded", { customer: "cus_billed" })).json.outcome).toBe("ignored");
  });

  it("past due runs stop once the grace period ends", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(statusAllowsRuns("past_due", future)).toBe(true);
    expect(statusAllowsRuns("past_due", past)).toBe(false);
    expect(statusAllowsRuns("incomplete", null)).toBe(false);
    expect(statusAllowsRuns("trialing", null)).toBe(true);
  });
});

describe("usage metering", () => {
  const now = new Date();
  const h = (ago: number) => hourKey(new Date(now.getTime() - ago * 3600_000));

  async function addUsage(tenant: string, meter: string, qty: number, hour: string) {
    await env.DB.prepare("INSERT INTO usage_events (id, tenant_id, meter, quantity, hour) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(`use_${++seq}`, tenant, meter, qty, hour)
      .run();
  }

  function recorder(result: (n: number) => PushResult = () => ({ status: "pushed" })) {
    const calls: { identifier: string; quantity: number; customer: string; meter: string }[] = [];
    const provider: BillingProvider = {
      name: "test",
      async pushUsage(_env, p) {
        calls.push({ identifier: p.identifier, quantity: p.quantity, customer: p.customer, meter: p.meter });
        return result(calls.length);
      },
    };
    return { calls, provider };
  }

  it("pushes each finished tenant-meter-hour once, with a stable identifier", async () => {
    await env.DB.prepare("DELETE FROM usage_events").run();
    await env.DB.prepare("DELETE FROM usage_pushes").run();
    await addUsage(billed, "answers_run", 1, h(3));
    await addUsage(billed, "answers_run", 1, h(3));
    await addUsage(billed, "llm_cost_micros", 2500, h(3));
    await addUsage(billed, "answers_run", 1, h(2));
    await addUsage(billed, "answers_run", 1, h(0)); // current hour: not finished, not pushed
    await addUsage(comped, "answers_run", 5, h(3)); // not billed through Stripe

    const first = recorder();
    expect(await aggregateUsage(env, first.provider, now)).toBe(3);
    expect(first.calls.map((c) => c.identifier).sort()).toEqual([`${billed}:answers_run:${h(2)}`, `${billed}:answers_run:${h(3)}`, `${billed}:llm_cost_micros:${h(3)}`].sort());
    expect(first.calls.find((c) => c.identifier.endsWith(`answers_run:${h(3)}`))?.quantity).toBe(2);
    expect(first.calls.every((c) => c.customer === "cus_billed")).toBe(true);

    const comp = await env.DB.prepare("SELECT state FROM usage_pushes WHERE tenant_id = ?1").bind(comped).first<{ state: string }>();
    expect(comp?.state).toBe("skipped");
    const current = await env.DB.prepare("SELECT 1 FROM usage_pushes WHERE hour = ?1").bind(h(0)).first();
    expect(current).toBeNull();

    // Running again pushes nothing new, and late rows can't change an hour that was already pushed.
    await addUsage(billed, "answers_run", 1, h(3));
    const second = recorder();
    expect(await aggregateUsage(env, second.provider, now)).toBe(0);
    expect(second.calls).toHaveLength(0);
    const row = await env.DB.prepare("SELECT quantity, state FROM usage_pushes WHERE identifier = ?1").bind(`${billed}:answers_run:${h(3)}`).first<{ quantity: number; state: string }>();
    expect(row).toEqual({ quantity: 2, state: "pushed" });
  });

  it("keeps a row pending on a retryable error and stops the batch when rate limited", async () => {
    await addUsage(billed, "answers_run", 1, h(5));
    await addUsage(billed, "llm_cost_micros", 100, h(5));
    const limited = recorder(() => ({ status: "retry", error: "rate limited", stop: true }));
    expect(await aggregateUsage(env, limited.provider, now)).toBe(0);
    expect(limited.calls).toHaveLength(1);
    const pending = await env.DB.prepare("SELECT state, attempts, last_error FROM usage_pushes WHERE identifier = ?1").bind(limited.calls[0].identifier).first<{ state: string; attempts: number; last_error: string }>();
    expect(pending).toEqual({ state: "pending", attempts: 1, last_error: "rate limited" });

    const ok = recorder();
    expect(await aggregateUsage(env, ok.provider, now)).toBe(2);
    expect(ok.calls.map((c) => c.identifier)).toContain(limited.calls[0].identifier);
  });

  it("sends Stripe meter events with the identifier and treats a repeat as already pushed", async () => {
    const requests: { url: string; body: string; headers: Record<string, string> }[] = [];
    let mode: "ok" | "dup" | "limit" = "ok";
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: String(init?.body ?? ""), headers: init?.headers as Record<string, string> });
      if (mode === "dup") return new Response(JSON.stringify({ error: { message: "An event already exists with identifier x." } }), { status: 400 });
      if (mode === "limit") return new Response(JSON.stringify({ error: { message: "Too many requests" } }), { status: 429 });
      return new Response(JSON.stringify({ object: "billing.meter_event" }), { status: 200 });
    };
    const stripeEnv = { ...env, STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_BILLING_CONFIG: JSON.stringify(CONFIG) } as Env;
    const provider = stripeProvider(stripeEnv, fakeFetch)!;
    expect(provider).not.toBeNull();
    const hour = h(1);
    const push = { tenantId: billed, meter: "answers_run", hour, quantity: 7, identifier: `${billed}:answers_run:${hour}`, customer: "cus_billed" };

    expect(await provider.pushUsage(stripeEnv, push)).toEqual({ status: "pushed" });
    const sent = new URLSearchParams(requests[0].body);
    expect(requests[0].url).toBe("https://api.stripe.com/v1/billing/meter_events");
    expect(requests[0].headers["authorization"]).toBe("Bearer sk_test_fake");
    expect(sent.get("event_name")).toBe("geo_answers_run");
    expect(sent.get("identifier")).toBe(push.identifier);
    expect(sent.get("payload[stripe_customer_id]")).toBe("cus_billed");
    expect(sent.get("payload[value]")).toBe("7");
    expect(Number(sent.get("timestamp"))).toBe(hourTimestamp(hour));

    mode = "dup";
    expect((await provider.pushUsage(stripeEnv, push)).status).toBe("pushed");
    mode = "limit";
    expect(await provider.pushUsage(stripeEnv, push)).toMatchObject({ status: "retry", stop: true });
    expect((await provider.pushUsage(stripeEnv, { ...push, meter: "browser_minutes" })).status).toBe("skipped");
    expect(stripeProvider({ ...stripeEnv, STRIPE_SECRET_KEY: "sk_live_fake" })).toBeNull();
  });
});
