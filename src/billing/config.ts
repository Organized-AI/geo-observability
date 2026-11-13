/**
 * Stripe billing configuration, read from Worker secrets and vars.
 *
 * STRIPE_SECRET_KEY        sk_test_… (or rk_test_…). Live keys are refused unless STRIPE_LIVE_MODE is "true".
 * STRIPE_WEBHOOK_SECRET    whsec_… for the /webhooks/stripe endpoint.
 * STRIPE_BILLING_CONFIG    JSON printed by scripts/stripe-setup.mjs:
 *   { "platform_price": "price_…",
 *     "metered": { "answers_run": { "event_name": "geo_answers_run", "price": "price_…" }, … },
 *     "portal_config": "bpc_…", "trial_days": 0 }
 * STRIPE_AUTOMATIC_TAX     "true" turns on Stripe Tax in Checkout. Off by default: the owner decides.
 * APP_URL                  optional public origin for Checkout return links; defaults to the request's origin.
 */
import type { Env } from "../env";
import { HttpError } from "../lib/util";

export interface MeteredPrice {
  event_name: string;
  price: string;
}

export interface StripeBillingConfig {
  platform_price: string;
  metered: Record<string, MeteredPrice>;
  portal_config?: string;
  trial_days?: number;
}

/** Pinned so request and webhook payload shapes don't change under us. The setup script pins the webhook endpoint to the same version. */
export const STRIPE_API_VERSION = "2025-03-31.basil";

export function parseBillingConfig(raw: string | undefined): StripeBillingConfig | null {
  if (!raw) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  if (typeof o.platform_price !== "string" || !o.platform_price.startsWith("price_")) return null;
  const metered: Record<string, MeteredPrice> = {};
  if (o.metered && typeof o.metered === "object") {
    for (const [meter, v] of Object.entries(o.metered as Record<string, unknown>)) {
      const m = v as Record<string, unknown> | null;
      if (m && typeof m.event_name === "string" && typeof m.price === "string" && m.price.startsWith("price_")) {
        metered[meter] = { event_name: m.event_name, price: m.price };
      }
    }
  }
  return {
    platform_price: o.platform_price,
    metered,
    portal_config: typeof o.portal_config === "string" && o.portal_config ? o.portal_config : undefined,
    trial_days: typeof o.trial_days === "number" && o.trial_days > 0 ? Math.floor(o.trial_days) : undefined,
  };
}

export type KeyMode = "test" | "live" | "invalid";

export function keyMode(key: string | undefined): KeyMode {
  if (!key) return "invalid";
  if (/^(sk|rk)_test_/.test(key)) return "test";
  if (/^(sk|rk)_live_/.test(key)) return "live";
  return "invalid";
}

/** True when the Worker has what it needs to take cards and push usage. */
export function billingEnabled(env: Env): boolean {
  const mode = keyMode(env.STRIPE_SECRET_KEY);
  if (mode === "invalid") return false;
  if (mode === "live" && env.STRIPE_LIVE_MODE !== "true") return false;
  return parseBillingConfig(env.STRIPE_BILLING_CONFIG) !== null;
}

export function requireBilling(env: Env): { key: string; config: StripeBillingConfig } {
  if (!billingEnabled(env)) throw new HttpError(503, "billing_off", "Card billing isn't switched on for this site yet.");
  return { key: env.STRIPE_SECRET_KEY as string, config: parseBillingConfig(env.STRIPE_BILLING_CONFIG) as StripeBillingConfig };
}

export function graceDays(env: Env): number {
  const n = Number(env.BILLING_GRACE_DAYS ?? "7");
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 60) : 7;
}

export function appOrigin(env: Env, req: Request): string {
  const fromEnv = (env.APP_URL ?? "").trim().replace(/\/+$/, "");
  if (/^https?:\/\/[^/]+$/.test(fromEnv)) return fromEnv;
  return new URL(req.url).origin;
}
