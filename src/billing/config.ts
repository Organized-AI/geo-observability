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
 * APP_URL                  public address for Checkout returns and sign-in links (may carry a base path); defaults to the request.
 */
import type { Env } from "../env";
import { publicUrl, requestBase } from "../lib/basepath";
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

/** The stored key without stray whitespace, line breaks or quotes, which a pasted secret often carries. */
export function cleanKey(key: string | undefined): string {
  return (key ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
}

export function keyMode(rawKey: string | undefined): KeyMode {
  const key = cleanKey(rawKey);
  if (!key) return "invalid";
  if (!/^[A-Za-z0-9_]+$/.test(key)) return "invalid";
  if (/^(sk|rk)_test_/.test(key)) return "test";
  if (/^(sk|rk)_live_/.test(key)) return "live";
  return "invalid";
}

/** Why the stored key can't be used, in words for the owner, or null when it looks fine. */
export function keyProblem(env: Env): string | null {
  const key = cleanKey(env.STRIPE_SECRET_KEY);
  if (!key) return "STRIPE_SECRET_KEY isn't set on the Worker.";
  if (!/^[A-Za-z0-9_]+$/.test(key)) return "The STRIPE_SECRET_KEY stored on the Worker has characters a Stripe key can't contain. Set it again.";
  if (!/^(sk|rk)_(test|live)_/.test(key)) return "STRIPE_SECRET_KEY isn't a Stripe secret key (sk_test_… or rk_test_…).";
  return null;
}

/** True when the Worker has what it needs to take cards and push usage. */
export function billingEnabled(env: Env): boolean {
  if (keyProblem(env)) return false;
  const mode = keyMode(env.STRIPE_SECRET_KEY);
  if (mode === "invalid") return false;
  if (mode === "live" && env.STRIPE_LIVE_MODE !== "true") return false;
  return parseBillingConfig(env.STRIPE_BILLING_CONFIG) !== null;
}

export function requireBilling(env: Env): { key: string; config: StripeBillingConfig } {
  if (!billingEnabled(env)) throw new HttpError(503, "billing_off", "Card billing isn't switched on for this site yet.");
  return { key: cleanKey(env.STRIPE_SECRET_KEY), config: parseBillingConfig(env.STRIPE_BILLING_CONFIG) as StripeBillingConfig };
}

export function graceDays(env: Env): number {
  const n = Number(env.BILLING_GRACE_DAYS ?? "7");
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 60) : 7;
}

/** Public address for links the Worker writes: APP_URL (may include a base path) or the request's origin + base. */
export function appOrigin(env: Env, req: Request): string {
  const pub = publicUrl(env);
  if (pub) return `${pub.origin}${pub.base}`;
  return `${new URL(req.url).origin}${requestBase(req)}`;
}
