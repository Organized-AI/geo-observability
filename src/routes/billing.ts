/**
 * Billing routes.
 *
 *  GET  /api/signup            who's signed in, whether self-serve signup is open, workspaces they own
 *  POST /api/signup            create a workspace + Stripe customer, return a Checkout URL (card on file)
 *  GET  /api/billing           status, period end, this month's usage pushes
 *  POST /api/billing/checkout  owner: (re)start Checkout for a workspace with no live subscription
 *  POST /api/billing/portal    owner: Stripe customer portal link (card, invoices, cancel)
 *  POST /webhooks/stripe       signed Stripe events (mounted in src/index.ts)
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { identify, requireOwner, resolveSession, type Session } from "../lib/auth";
import { assertSameOrigin, clientIp, normalizeEmail, rateLimit } from "../lib/session";
import { mailerKind } from "../lib/mailer";
import { sendSignInLink } from "./auth";
import { HttpError, newId, nowIso } from "../lib/util";
import { appOrigin, billingEnabled, requireBilling } from "../billing/config";
import { billingLocks, billingStatus } from "../billing/hooks";
import { Stripe, checkoutParams, verifyStripeSignature } from "../billing/stripe";
import { handleStripeEvent, type StripeEvent } from "../billing/webhooks";

type BillingEnv = { Bindings: Env; Variables: { session: Session } };

async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "bad_json", "Body must be JSON");
  }
}

function cleanText(v: unknown, max: number, field: string, required: boolean): string {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, "bad_request", `${field} is required`);
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, "bad_request", `${field} must be text`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, "bad_request", `${field} is longer than ${max} characters`);
  if (required && !s) throw new HttpError(400, "bad_request", `${field} is required`);
  return s;
}

const cleanDomain = (d: string) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").slice(0, 120);

/** Opens Checkout for a workspace's Stripe customer. */
async function startCheckout(env: Env, req: Request, tenantId: string, customer: string): Promise<string> {
  const { key, config } = requireBilling(env);
  const stripe = new Stripe(key);
  const session = await stripe.createCheckoutSession(
    checkoutParams(config, { customer, tenantId, origin: appOrigin(env, req), automaticTax: env.STRIPE_AUTOMATIC_TAX === "true" }),
  );
  await env.DB.prepare("UPDATE billing_accounts SET checkout_ref = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id = ?1").bind(tenantId, session.id).run();
  return session.url;
}

async function stripeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error("stripe", e);
    throw new HttpError(502, "billing_unavailable", "We couldn't reach the payment provider. Try again in a minute.");
  }
}

// ------------------------------------------------------------------ signup (no workspace needed)

export const signupApi = new Hono<{ Bindings: Env }>();

signupApi.get("/", async (c) => {
  const who = await identify(c.req.raw, c.env);
  let workspaces: { id: string; name: string; slug: string; billing_status: string }[] = [];
  if (who) {
    const owned = await c.env.DB.prepare(
      `SELECT t.id, t.name, t.slug, COALESCE(b.status, 'active') AS billing_status
       FROM users u JOIN memberships m ON m.user_id = u.id AND m.role = 'owner' JOIN tenants t ON t.id = m.tenant_id
       LEFT JOIN billing_accounts b ON b.tenant_id = t.id WHERE u.email = ?1 ORDER BY t.created_at`,
    )
      .bind(who.email)
      .all<{ id: string; name: string; slug: string; billing_status: string }>();
    workspaces = owned.results ?? [];
  }
  return c.json({ signed_in: !!who, email: who?.email ?? null, open: billingEnabled(c.env), email_ready: mailerKind(c.env) !== "none", workspaces });
});

/**
 * Public signup. Anyone can start one with an email and a workspace name; the card is taken by Stripe Checkout.
 * If the email already belongs to an account, we email a sign-in link instead of touching that account.
 */
signupApi.post("/", async (c) => {
  assertSameOrigin(c.req.raw, c.env.APP_URL);
  requireBilling(c.env);
  await rateLimit(c.env, "signup_ip", clientIp(c.req.raw), 10, 60);
  const b = await readJson<{ email?: unknown; name?: unknown; website?: unknown }>(c.req.raw);
  const name = cleanText(b.name, 120, "Workspace name", true);
  const website = cleanText(b.website, 200, "Website", false);
  const domain = website ? cleanDomain(website) : "";
  if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new HttpError(400, "bad_request", "Website should look like example.com");

  const who = await identify(c.req.raw, c.env);
  let email: string;
  if (who) email = who.email;
  else {
    const e = normalizeEmail(b.email);
    if (!e) throw new HttpError(400, "bad_request", "Enter a valid email address.");
    email = e;
  }

  let user = await c.env.DB.prepare("SELECT id, signup_pending FROM users WHERE email = ?1").bind(email).first<{ id: string; signup_pending: number }>();
  if (!who && user) {
    // An account already exists (or a signup was paid for but never confirmed): it's only reachable by its owner's inbox.
    const paid = await c.env.DB.prepare(
      `SELECT 1 FROM memberships m JOIN billing_accounts b ON b.tenant_id = m.tenant_id
       WHERE m.user_id = ?1 AND (b.status != 'incomplete' OR b.checkout_claimed_at IS NOT NULL) LIMIT 1`,
    )
      .bind(user.id)
      .first();
    const other = await c.env.DB.prepare(
      `SELECT 1 FROM memberships m LEFT JOIN billing_accounts b ON b.tenant_id = m.tenant_id WHERE m.user_id = ?1 AND b.tenant_id IS NULL LIMIT 1`,
    )
      .bind(user.id)
      .first();
    if (!user.signup_pending || paid || other) {
      await rateLimit(c.env, "login_email", email, 5, 60);
      await sendSignInLink(c.env, c.req.raw, email, "Someone (hopefully you) tried to create a workspace with this email. Sign in first, then create it from the signup page.");
      return c.json({ status: "check_email", message: "That email already has an account. We've sent it a sign-in link; sign in, then create the workspace." });
    }
  }
  if (!user) {
    user = { id: newId("usr"), signup_pending: who ? 0 : 1 };
    await c.env.DB.prepare("INSERT INTO users (id, email, signup_pending) VALUES (?1, ?2, ?3)").bind(user.id, email, user.signup_pending).run();
  }

  // Someone who started signup and left Checkout gets their unfinished workspace back instead of a second one.
  const unfinished = await c.env.DB.prepare(
    `SELECT t.id, b.customer_ref FROM memberships m JOIN tenants t ON t.id = m.tenant_id JOIN billing_accounts b ON b.tenant_id = t.id
     WHERE m.user_id = ?1 AND m.role = 'owner' AND b.provider = 'stripe' AND b.status = 'incomplete' AND b.checkout_claimed_at IS NULL
     ORDER BY t.created_at LIMIT 1`,
  )
    .bind(user.id)
    .first<{ id: string; customer_ref: string | null }>();
  if (unfinished?.customer_ref) {
    await c.env.DB.prepare("UPDATE tenants SET name = ?2 WHERE id = ?1").bind(unfinished.id, name).run();
    const url = await stripeCall(() => startCheckout(c.env, c.req.raw, unfinished.id, unfinished.customer_ref as string));
    return c.json({ status: "checkout", tenant_id: unfinished.id, checkout_url: url, resumed: true });
  }

  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "workspace";
  let slug = base;
  for (let i = 0; i < 5 && (await c.env.DB.prepare("SELECT 1 FROM tenants WHERE slug = ?1").bind(slug).first()); i++) {
    slug = `${base}-${crypto.randomUUID().slice(0, 4)}`;
  }
  const tenantId = newId("ten");
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO tenants (id, name, slug, plan) VALUES (?1, ?2, ?3, 'starter')").bind(tenantId, name, slug),
    c.env.DB.prepare("INSERT INTO memberships (tenant_id, user_id, role) VALUES (?1, ?2, 'owner')").bind(tenantId, user.id),
    c.env.DB.prepare("INSERT INTO billing_accounts (tenant_id, provider, status) VALUES (?1, 'stripe', 'incomplete')").bind(tenantId),
    c.env.DB.prepare("INSERT INTO audit_log (id, tenant_id, user_email, action, detail) VALUES (?1, ?2, ?3, 'workspace.signup', ?4)").bind(
      newId("aud"),
      tenantId,
      email,
      JSON.stringify({ website: domain || null }),
    ),
  ]);

  const { key } = requireBilling(c.env);
  const url = await stripeCall(async () => {
    const customer = await new Stripe(key).createCustomer({ email, name, tenantId });
    await c.env.DB.prepare("UPDATE billing_accounts SET customer_ref = ?2 WHERE tenant_id = ?1").bind(tenantId, customer.id).run();
    return startCheckout(c.env, c.req.raw, tenantId, customer.id);
  });
  return c.json({ status: "checkout", tenant_id: tenantId, slug, website: domain || null, checkout_url: url }, 201);
});

// ------------------------------------------------------------------ billing for an existing workspace

export const billingApi = new Hono<BillingEnv>();

billingApi.use("*", async (c, next) => {
  assertSameOrigin(c.req.raw, c.env.APP_URL);
  c.set("session", await resolveSession(c.req.raw, c.env));
  await next();
});

billingApi.get("/", async (c) => {
  const s = c.get("session");
  const b = await billingStatus(c.env, s.tenant.id);
  const month = nowIso().slice(0, 7);
  const pushes = await s.tdb.all<{ meter: string; state: string; quantity: number; rows: number }>(
    "SELECT meter, state, SUM(quantity) AS quantity, COUNT(*) AS rows FROM usage_pushes WHERE tenant_id = ?1 AND substr(hour, 1, 7) = ?2 GROUP BY meter, state",
    month,
  );
  return c.json({
    enabled: billingEnabled(c.env),
    provider: b.provider,
    status: b.status,
    locked: b.provider === "stripe" && billingLocks(b.status),
    grace_until: b.grace_until,
    current_period_end: b.current_period_end,
    cancel_at_period_end: b.cancel_at_period_end,
    can_manage: s.role === "owner" && !s.demo && b.provider === "stripe",
    month,
    pushes,
  });
});

billingApi.post("/checkout", async (c) => {
  const s = c.get("session");
  if (s.demo) throw new HttpError(403, "read_only", "The demo is read-only.");
  requireOwner(s);
  requireBilling(c.env);
  const b = await billingStatus(c.env, s.tenant.id);
  if (b.provider === "stripe" && (b.status === "active" || b.status === "trialing" || b.status === "past_due")) {
    throw new HttpError(409, "already_subscribed", "This workspace already has a subscription. Use Manage billing to change the card.");
  }
  let customer = b.customer_ref;
  if (!customer) {
    const { key } = requireBilling(c.env);
    customer = (await stripeCall(() => new Stripe(key).createCustomer({ email: s.email, name: s.tenant.name, tenantId: s.tenant.id }))).id;
    await c.env.DB.prepare(
      `INSERT INTO billing_accounts (tenant_id, provider, customer_ref, status) VALUES (?1, 'stripe', ?2, 'incomplete')
       ON CONFLICT(tenant_id) DO UPDATE SET provider = 'stripe', customer_ref = excluded.customer_ref`,
    )
      .bind(s.tenant.id, customer)
      .run();
  }
  const url = await stripeCall(() => startCheckout(c.env, c.req.raw, s.tenant.id, customer as string));
  return c.json({ url });
});

billingApi.post("/portal", async (c) => {
  const s = c.get("session");
  if (s.demo) throw new HttpError(403, "read_only", "The demo is read-only.");
  requireOwner(s);
  const { key, config } = requireBilling(c.env);
  const b = await billingStatus(c.env, s.tenant.id);
  if (b.provider !== "stripe" || !b.customer_ref) throw new HttpError(409, "no_billing", "This workspace isn't billed by card.");
  const portal = await stripeCall(() =>
    new Stripe(key).createPortalSession({ customer: b.customer_ref as string, returnUrl: `${appOrigin(c.env, c.req.raw)}/app/#/usage`, configuration: config.portal_config }),
  );
  return c.json({ url: portal.url });
});

// ------------------------------------------------------------------ webhook

export async function stripeWebhook(req: Request, env: Env): Promise<Response> {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (!env.STRIPE_WEBHOOK_SECRET) return json(503, { error: "billing_off", message: "Webhook secret not configured" });
  const payload = await req.text();
  if (!(await verifyStripeSignature(payload, req.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET))) {
    return json(400, { error: "bad_signature", message: "Signature check failed" });
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return json(400, { error: "bad_json", message: "Body must be JSON" });
  }
  if (!event?.id || !event.type || typeof event.created !== "number") return json(400, { error: "bad_event", message: "Not a Stripe event" });
  // A live-mode event reaching a test-mode deployment changes nothing.
  if ((event as { livemode?: boolean }).livemode === true && env.STRIPE_LIVE_MODE !== "true") return json(200, { received: true, outcome: "ignored" });
  const outcome = await handleStripeEvent(env, event);
  return json(200, { received: true, outcome });
}
