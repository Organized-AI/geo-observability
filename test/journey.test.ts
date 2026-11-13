/**
 * One customer, start to finish, the way a Peec-style onboarding goes:
 * landing → signup → Stripe Checkout → back in the app → setup steps → first run → reports → site tracking → usage billed → sign out.
 * Stripe is a stand-in transport; everything else is the real Worker.
 */
import { env as rawEnv, createExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { readCookie, SESSION_COOKIE } from "../src/lib/session";
import { setStripeTransport, stripeProvider, stripeSignature } from "../src/billing/stripe";
import { aggregateUsage, billingStatus } from "../src/billing/hooks";
import { planPass } from "../src/workflows/scheduler";
import { askAndStore, markRun, persist, score } from "../src/workflows/pipeline";
import { today } from "../src/lib/util";

const ORIGIN = "https://geo.test";
const SECRET = "whsec_test_geo_observability_0123456789";
const CONFIG = {
  platform_price: "price_platform",
  metered: {
    answers_run: { event_name: "geo_answers_run", price: "price_answers" },
    llm_cost_micros: { event_name: "geo_llm_cost_micros", price: "price_llm" },
  },
  portal_config: "bpc_test",
};
const env = { ...(rawEnv as unknown as Env), DEV_AUTH_EMAIL: undefined, STRIPE_SECRET_KEY: "sk_test_journey", STRIPE_BILLING_CONFIG: JSON.stringify(CONFIG), STRIPE_WEBHOOK_SECRET: SECRET } as Env;

/** What the stand-in Stripe was asked, and the Checkout session it handed out. */
const stripeCalls: { method: string; path: string; body: string }[] = [];
let checkoutTenant = "";

beforeAll(() => {
  setStripeTransport(async (input, init) => {
    const url = new URL(String(input));
    const body = String(init?.body ?? "");
    stripeCalls.push({ method: init?.method ?? "GET", path: url.pathname, body });
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/customers") return json({ id: "cus_journey" });
    if (url.pathname === "/v1/checkout/sessions") {
      checkoutTenant = new URLSearchParams(body).get("client_reference_id") ?? "";
      return json({ id: "cs_test_journey", url: "https://checkout.stripe.com/c/pay/cs_test_journey" });
    }
    if (url.pathname === "/v1/checkout/sessions/cs_test_journey") {
      return json({ id: "cs_test_journey", status: "complete", payment_status: "paid", client_reference_id: checkoutTenant, subscription: "sub_journey" });
    }
    if (url.pathname === "/v1/billing/meter_events") return json({ object: "billing.meter_event" });
    if (url.pathname === "/v1/billing_portal/sessions") return json({ url: "https://billing.stripe.com/p/session/test" });
    return new Response(JSON.stringify({ error: { message: `unexpected ${url.pathname}` } }), { status: 404 });
  });
});
afterAll(() => setStripeTransport(null));

let cookie = "";

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers = new Headers({ origin: ORIGIN, ...extra });
  if (body !== undefined) headers.set("content-type", typeof body === "string" ? "text/csv" : "application/json");
  if (cookie) headers.set("cookie", `${SESSION_COOKIE}=${cookie}`);
  const res = await app.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" }),
    env,
    createExecutionContext(),
  );
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* html or csv */
  }
  return { status: res.status, json, res };
}

async function webhook(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id: `evt_journey_${type.replace(/\W/g, "")}`, object: "event", type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = await stripeSignature(SECRET, t, payload);
  const res = await app.fetch(
    new Request(`${ORIGIN}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` }, body: payload }),
    env,
    createExecutionContext(),
  );
  return res.status;
}

describe("a new customer, start to finish", () => {
  let tenantId = "";
  let projectId = "";

  it("lands, signs up and pays through Checkout", async () => {
    expect((await call("GET", "/api/signup")).json).toMatchObject({ signed_in: false, open: true });

    const signup = await call("POST", "/api/signup", { email: "founder@journey.test", name: "Journey Co", website: "https://journey.test/" });
    expect(signup.status, JSON.stringify(signup.json)).toBe(201);
    expect(signup.json.status).toBe("checkout");
    expect(signup.json.checkout_url).toContain("checkout.stripe.com");
    tenantId = signup.json.tenant_id;
    expect(checkoutTenant).toBe(tenantId);

    // Checkout asks for the flat price and every metered price, and comes back to our return page.
    const checkoutBody = new URLSearchParams(stripeCalls.find((c) => c.path === "/v1/checkout/sessions")!.body);
    expect(checkoutBody.get("mode")).toBe("subscription");
    expect(checkoutBody.get("line_items[0][price]")).toBe("price_platform");
    expect(checkoutBody.get("success_url")).toBe(`${ORIGIN}/auth/checkout-return?cs={CHECKOUT_SESSION_ID}`);
    expect(checkoutBody.get("automatic_tax[enabled]")).toBeNull(); // sales tax stays off until he decides
    expect((await billingStatus(env, tenantId)).status).toBe("incomplete");
  });

  it("comes back from Checkout signed in, with the workspace active before any webhook", async () => {
    const back = await call("GET", "/auth/checkout-return?cs=cs_test_journey");
    expect(back.status).toBe(303);
    expect(back.res.headers.get("location")).toBe("/app/?billing=success#/setup");
    const set = back.res.headers.get("set-cookie") ?? "";
    cookie = readCookie(new Request(ORIGIN, { headers: { cookie: set.split(";")[0] } }), SESSION_COOKIE) ?? "";
    expect(cookie).toBeTruthy();
    expect((await billingStatus(env, tenantId)).status).toBe("active");

    // The welcome email with a sign-in link went out.
    const mail = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE to_email = 'founder@journey.test'").first<{ n: number }>();
    expect(mail?.n).toBeGreaterThan(0);

    // The webhooks then land and agree.
    expect(await webhook("checkout.session.completed", { id: "cs_test_journey", object: "checkout.session", status: "complete", payment_status: "paid", customer: "cus_journey", client_reference_id: tenantId, subscription: "sub_journey", metadata: { tenant_id: tenantId } })).toBe(200);
    expect(await webhook("customer.subscription.created", { id: "sub_journey", object: "subscription", status: "active", customer: "cus_journey", metadata: { tenant_id: tenantId } })).toBe(200);
    expect((await billingStatus(env, tenantId)).status).toBe("active");

    const me = await call("GET", "/api/me");
    expect(me.status, JSON.stringify(me.json)).toBe(200);
    expect(me.json.user.email).toBe("founder@journey.test");
    expect(me.json.tenant.id).toBe(tenantId);
    expect(me.json.demo).toBe(false);
    expect(me.json.tenant.signup_website).toBe("journey.test"); // setup starts from the website given at signup
  });

  it("walks the setup steps: brand, profile, topics, prompts, competitors, engines, countries", async () => {
    const proj = await call("POST", "/api/projects", { name: "Journey Co", domain: "journey.test" });
    expect(proj.status, JSON.stringify(proj.json)).toBe(201);
    projectId = proj.json.id;
    const P = `/api/projects/${projectId}`;

    expect((await call("PUT", `${P}/profile`, { what_you_sell: "Accounting software", buyers: "Freelancers", markets: [{ country: "US", language: "en" }], facts: ["Free plan"] })).status).toBe(200);
    expect((await call("POST", `${P}/topics`, { name: "Invoicing" })).status).toBe(201);
    expect((await call("POST", `${P}/prompts`, { text: "Best invoicing app for freelancers?", country: "US" })).status).toBe(201);
    const imp = await call("POST", `${P}/prompts/import`, "prompt,country\nJourney Co vs Ledgerly,US\n");
    expect(imp.json.imported).toBe(1);
    expect((await call("POST", `${P}/brands`, { name: "Ledgerly", domains: ["ledgerly.test"] })).status).toBe(201);

    // Starter tracks all four engines.
    const models = await call("PUT", `${P}/models`, { engines: ["chatgpt", "claude", "gemini", "perplexity"] });
    expect(models.status, JSON.stringify(models.json)).toBe(200);
    expect(models.json.engines).toHaveLength(4);
    expect((await call("PUT", `${P}/countries`, { countries: ["US"] })).status).toBe(200);

    const finish = await call("POST", `${P}/onboarding/finish`);
    expect(finish.status, JSON.stringify(finish.json)).toBe(200);
  });

  it("runs the first pass and fills every report", async () => {
    const jobs = await planPass(env, tenantId, projectId, today());
    expect(jobs.length).toBe(2 * 4); // 2 prompts × 4 engines
    for (const job of jobs) {
      await markRun(env, job, "running");
      const answer = await askAndStore(env, job);
      await persist(env, job, answer, await score(env, job, answer));
    }
    const P = `/api/projects/${projectId}`;
    const ov = await call("GET", `${P}/overview`);
    expect(ov.status).toBe(200);
    expect(ov.json.kpis.answers.value).toBe(8);
    for (const path of ["chats", "sources/domains", "sources/urls", "prompts/performance", "insights", "actions", "perception", "website/pages", "website/crawlers", "website/referrals", "tracking"]) {
      const r = await call("GET", `${P}/${path}`);
      expect(r.status, `${path}: ${JSON.stringify(r.json).slice(0, 200)}`).toBe(200);
    }
    const csv = await call("GET", `${P}/export/chats.csv`);
    expect(csv.status).toBe(200);
  });

  it("connects the site: tap and edge traffic tie AI crawlers, referrals and conversions to pages", async () => {
    const key = await call("POST", "/api/keys", { name: "site", scope: "ingest" });
    expect(key.status, JSON.stringify(key.json)).toBe(201);
    const headers = { "x-ingest-key": key.json.secret };
    const edge = await call("POST", "/ingest/edge", { project_id: projectId, events: [{ path: "/pricing", ua: "GPTBot/1.1", status: 200 }, { path: "/pricing", ua: "Mozilla/5.0", referer: "https://chatgpt.com/" }] }, headers);
    expect(edge.json).toEqual({ crawl: 1, referrals: 1 });
    const conv = await call("POST", "/ingest/conversion", { project_id: projectId, events: [{ event_id: "j-1", event_name: "signup", landing_path: "/pricing", utm_source: "chatgpt.com", value: 0, source: "gtm" }] }, headers);
    expect(conv.json.kept).toBe(1);
    const pages = await call("GET", `/api/projects/${projectId}/website/pages`);
    const row = pages.json.items.find((i: any) => i.path === "/pricing");
    expect(row.training_hits).toBe(1);
    expect(row.conversions).toBe(1);
  });

  it("bills the answers it ran to Stripe once, then signs out", async () => {
    const provider = stripeProvider(env);
    expect(provider).not.toBeNull();
    const later = new Date(Date.now() + 2 * 3600_000); // the hour the answers ran has finished
    await aggregateUsage(env, provider, later);
    const meterCalls = stripeCalls.filter((c) => c.path === "/v1/billing/meter_events").map((c) => new URLSearchParams(c.body));
    const answers = meterCalls.find((p) => p.get("event_name") === "geo_answers_run");
    expect(answers?.get("payload[value]")).toBe("8");
    expect(answers?.get("payload[stripe_customer_id]")).toBe("cus_journey");
    expect(answers?.get("identifier")).toMatch(new RegExp(`^${tenantId}:answers_run:`));

    // A second hourly run sends nothing new.
    const before = stripeCalls.length;
    await aggregateUsage(env, provider, later);
    expect(stripeCalls.filter((c) => c.path === "/v1/billing/meter_events").length).toBe(meterCalls.length);
    expect(stripeCalls.length).toBe(before);

    const billing = await call("GET", "/api/billing");
    expect(billing.status, JSON.stringify(billing.json)).toBe(200);
    expect((await call("POST", "/api/billing/portal")).json.url).toContain("billing.stripe.com");

    expect((await call("POST", "/auth/logout", undefined, { accept: "application/json" })).status).toBe(200);
    expect((await call("GET", "/api/me")).status).toBe(401);
  });
});
