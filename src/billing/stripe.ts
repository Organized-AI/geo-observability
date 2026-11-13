/**
 * A small Stripe REST client over fetch (no SDK: keeps the bundle small and the calls explicit),
 * webhook signature checks with WebCrypto, and the meter-event BillingProvider.
 */
import type { Env } from "../env";
import { HttpError } from "../lib/util";
import { STRIPE_API_VERSION, cleanKey, parseBillingConfig, keyMode, type StripeBillingConfig } from "./config";
import type { BillingProvider, PushResult, UsagePush } from "./hooks";

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type Param = string | number | boolean | null | undefined | Param[] | { [k: string]: Param };

/** Stripe's form encoding: nested objects as a[b][c]=v, arrays as a[0]=v. Null and undefined are dropped. */
export function formEncode(params: Record<string, Param>): string {
  const out: string[] = [];
  const walk = (prefix: string, v: Param) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
      return;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(`${prefix}[${k}]`, x);
      return;
    }
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.join("&");
}

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
  /** Worth trying again later: rate limited, Stripe-side error or no response. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 409 || this.status === 429 || this.status >= 500;
  }
}

/** Default transport. Tests swap it for a stand-in with setStripeTransport; production always uses fetch. */
let transport: Fetcher = (input, init) => fetch(input, init);
export function setStripeTransport(f: Fetcher | null): void {
  transport = f ?? ((input, init) => fetch(input, init));
}

export class Stripe {
  private readonly key: string;
  constructor(
    key: string,
    private readonly fetcher: Fetcher = (input, init) => transport(input, init),
    private readonly base = "https://api.stripe.com",
  ) {
    this.key = cleanKey(key);
  }

  async request<T = Record<string, any>>(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, Param> = {}, idempotencyKey?: string): Promise<T> {
    const body = formEncode(params);
    const url = method === "GET" && body ? `${this.base}${path}?${body}` : `${this.base}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.key}`,
      "stripe-version": STRIPE_API_VERSION,
    };
    if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let res: Response;
    try {
      // Call the fetcher as a plain function: on Workers, fetch called as a method of another object throws "Illegal invocation".
      const send = this.fetcher;
      res = await send(url, { method, headers, body: method === "POST" ? body : undefined });
    } catch (e) {
      throw new StripeError(0, "network", `Couldn't reach Stripe: ${String((e as Error)?.message ?? e)}`);
    }
    const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } & T;
    if (!res.ok) throw new StripeError(res.status, data?.error?.code ?? null, data?.error?.message ?? `Stripe returned ${res.status}`);
    return data;
  }

  createCustomer(p: { email: string; name: string; tenantId: string }) {
    return this.request<{ id: string }>(
      "POST",
      "/v1/customers",
      { email: p.email, name: p.name, metadata: { tenant_id: p.tenantId, app: "geo-observability" } },
      `geo-customer-${p.tenantId}`,
    );
  }

  createCheckoutSession(params: Record<string, Param>) {
    return this.request<{ id: string; url: string }>("POST", "/v1/checkout/sessions", params);
  }

  createPortalSession(p: { customer: string; returnUrl: string; configuration?: string }) {
    return this.request<{ url: string }>("POST", "/v1/billing_portal/sessions", { customer: p.customer, return_url: p.returnUrl, configuration: p.configuration });
  }

  createMeterEvent(p: { eventName: string; customer: string; value: number; identifier: string; timestamp: number }) {
    return this.request("POST", "/v1/billing/meter_events", {
      event_name: p.eventName,
      identifier: p.identifier,
      timestamp: p.timestamp,
      payload: { stripe_customer_id: p.customer, value: String(p.value) },
    });
  }
}

/** Checkout in subscription mode: flat platform price plus every metered price. Pure, so it's testable. */
export function checkoutParams(
  config: StripeBillingConfig,
  o: { customer: string; tenantId: string; origin: string; automaticTax: boolean },
): Record<string, Param> {
  const lineItems: Param[] = [{ price: config.platform_price, quantity: 1 }];
  for (const m of Object.values(config.metered)) lineItems.push({ price: m.price });
  const subscriptionData: Record<string, Param> = { metadata: { tenant_id: o.tenantId, app: "geo-observability" } };
  if (config.trial_days) subscriptionData.trial_period_days = config.trial_days;
  const p: Record<string, Param> = {
    mode: "subscription",
    customer: o.customer,
    client_reference_id: o.tenantId,
    line_items: lineItems,
    payment_method_collection: "always",
    success_url: `${o.origin}/auth/checkout-return?cs={CHECKOUT_SESSION_ID}`,
    cancel_url: `${o.origin}/signup/?canceled=1`,
    metadata: { tenant_id: o.tenantId, app: "geo-observability" },
    subscription_data: subscriptionData,
  };
  if (o.automaticTax) {
    p.automatic_tax = { enabled: true };
    p.customer_update = { address: "auto", name: "auto" };
    p.billing_address_collection = "required";
  }
  return p;
}

// ------------------------------------------------------------------ webhooks

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function stripeSignature(secret: string, timestamp: number, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${payload}`)));
}

/**
 * Checks a Stripe-Signature header (t=…,v1=…[,v1=…]) against the raw body, the way Stripe's libraries do:
 * HMAC-SHA256 of "t.payload" with the endpoint secret, any v1 may match, timestamp within the tolerance.
 */
export async function verifyStripeSignature(payload: string, header: string | null, secret: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!header || !secret) return false;
  let t = NaN;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((s) => s.trim());
    if (k === "t") t = Number(v);
    else if (k === "v1" && v) sigs.push(v);
  }
  if (!Number.isFinite(t) || !sigs.length) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = await stripeSignature(secret, t, payload);
  return sigs.some((s) => safeEqual(s, expected));
}

// ------------------------------------------------------------------ usage push

/** Stripe accepts meter events up to 35 days old; keep a margin. */
export const MAX_EVENT_AGE_SEC = 34 * 24 * 3600;

export function hourTimestamp(hour: string): number {
  // Middle of the hour, so the event never lands in the following hour or in the future.
  return Math.floor(Date.parse(`${hour}:00:00Z`) / 1000) + 1800;
}

export function stripeProvider(env: Env, fetcher?: Fetcher): BillingProvider | null {
  const mode = keyMode(env.STRIPE_SECRET_KEY);
  if (mode === "invalid" || (mode === "live" && env.STRIPE_LIVE_MODE !== "true")) return null;
  const config = parseBillingConfig(env.STRIPE_BILLING_CONFIG);
  if (!config) return null;
  const stripe = new Stripe(env.STRIPE_SECRET_KEY as string, fetcher);
  return {
    name: "stripe",
    async pushUsage(_env, push: UsagePush & { customer: string }): Promise<PushResult> {
      const meter = config.metered[push.meter];
      if (!meter) return { status: "skipped", error: `no Stripe meter configured for ${push.meter}` };
      if (push.quantity <= 0) return { status: "skipped", error: "nothing to bill" };
      const ts = hourTimestamp(push.hour);
      if (Math.floor(Date.now() / 1000) - ts > MAX_EVENT_AGE_SEC) return { status: "skipped", error: "older than Stripe accepts (35 days)" };
      try {
        await stripe.createMeterEvent({ eventName: meter.event_name, customer: push.customer, value: push.quantity, identifier: push.identifier, timestamp: ts });
        return { status: "pushed" };
      } catch (e) {
        const err = e as StripeError;
        // A repeat of an identifier Stripe already has means the earlier push landed: count it as pushed.
        if (err.status === 400 && /identifier/i.test(err.message) && /(already|exists|duplicate)/i.test(err.message)) return { status: "pushed" };
        if (err instanceof StripeError && err.retryable) return { status: "retry", error: err.message, stop: err.status === 429 };
        return { status: "failed", error: err?.message ?? String(e) };
      }
    },
  };
}

export function stripeFromEnv(env: Env, fetcher?: Fetcher): Stripe {
  const mode = keyMode(env.STRIPE_SECRET_KEY);
  if (mode === "invalid" || (mode === "live" && env.STRIPE_LIVE_MODE !== "true")) {
    throw new HttpError(503, "billing_off", "Card billing isn't switched on for this site yet.");
  }
  return new Stripe(env.STRIPE_SECRET_KEY as string, fetcher);
}
