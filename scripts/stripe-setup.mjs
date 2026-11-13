#!/usr/bin/env node
// Sets up Stripe billing for GEO Observability in a Stripe SANDBOX (test mode). Safe to run again:
// it finds what already exists (by metadata, lookup key, meter event name and webhook URL) and only adds what's missing.
//
//   export STRIPE_SECRET_KEY=sk_test_...        # the sandbox's secret key, from your own shell; never paste it anywhere else
//   node scripts/stripe-setup.mjs --url https://geo-observability.example.workers.dev --dry-run
//   node scripts/stripe-setup.mjs --url https://geo-observability.example.workers.dev --put-secrets
//
// Options
//   --url <origin>          the deployed Worker's public origin; the webhook goes to <origin>/webhooks/stripe (required unless --skip-webhook)
//   --dry-run               read only: print what would be created, create nothing
//   --put-secrets           run `npx wrangler secret put` for STRIPE_SECRET_KEY, STRIPE_BILLING_CONFIG and (when new) STRIPE_WEBHOOK_SECRET
//   --wrangler-env <name>   pass --env <name> to wrangler (e.g. staging)
//   --skip-webhook          don't create or check the webhook endpoint
//   --config <path>         plan file (default CONFIG/stripe-plan.json)
//
// It refuses any key that isn't a test-mode key (sk_test_ / rk_test_). It never prints the secret key.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

const API = "https://api.stripe.com";
const API_VERSION = "2025-03-31.basil"; // keep in sync with src/billing/config.ts
const APP = "geo-observability";
const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
];

// ------------------------------------------------------------------ args and guards

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const DRY = flag("--dry-run");
const PUT = flag("--put-secrets");
const SKIP_WEBHOOK = flag("--skip-webhook");
const WRANGLER_ENV = opt("--wrangler-env");
const CONFIG_PATH = opt("--config") ?? "CONFIG/stripe-plan.json";
const rawUrl = opt("--url");

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

const KEY = process.env.STRIPE_SECRET_KEY ?? "";
if (!KEY) die("Set STRIPE_SECRET_KEY in this shell to the sandbox's test secret key (sk_test_…), then run again.");
if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(KEY)) {
  die("STRIPE_SECRET_KEY isn't a test-mode key. This script only runs against a Stripe sandbox or test mode (sk_test_… or rk_test_…).");
}

let origin = null;
if (!SKIP_WEBHOOK) {
  if (!rawUrl) die("Pass --url with the Worker's public origin, e.g. --url https://geo-observability.<you>.workers.dev (or --skip-webhook).");
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") throw new Error("https only");
    origin = u.origin;
  } catch {
    die(`--url must be an https origin like https://geo-observability.<you>.workers.dev (got "${rawUrl}").`);
  }
}

let plan;
try {
  plan = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch (e) {
  die(`Couldn't read ${CONFIG_PATH}: ${e.message}`);
}
if (!plan.currency || !plan.platform || !plan.meters) die(`${CONFIG_PATH} needs currency, platform and meters.`);

// ------------------------------------------------------------------ Stripe calls

function encode(params, prefix = "", out = []) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === "object" ? encode(x, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(x))}`)));
    else if (typeof v === "object") encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

async function stripe(method, path, params = {}, idem) {
  const body = encode(params).join("&");
  const url = method === "GET" && body ? `${API}${path}?${body}` : `${API}${path}`;
  const headers = { authorization: `Bearer ${KEY}`, "stripe-version": API_VERSION };
  if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
  if (idem) headers["idempotency-key"] = idem;
  const res = await fetch(url, { method, headers, body: method === "POST" ? body : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data?.error?.message ?? "unknown error"}`);
  if (data && data.livemode === true) die("Stripe answered in live mode. Stopping without changes beyond this point.");
  return data;
}

async function listAll(path, params = {}) {
  const items = [];
  let after;
  for (let page = 0; page < 50; page++) {
    const r = await stripe("GET", path, { limit: 100, ...params, starting_after: after });
    items.push(...(r.data ?? []));
    if (!r.has_more || !r.data?.length) break;
    after = r.data[r.data.length - 1].id;
  }
  return items;
}

const created = [];
const reused = [];
const runId = Date.now().toString(36);

async function create(label, path, params, idemKey) {
  if (DRY) {
    created.push(`${label} (dry run: not created)`);
    return { id: `dry_${label.replace(/\W+/g, "_")}` };
  }
  const obj = await stripe("POST", path, params, idemKey ? `${APP}-${idemKey}-${runId}` : undefined);
  created.push(`${label}: ${obj.id}`);
  return obj;
}

// ------------------------------------------------------------------ steps

async function ensureProduct(component, name, products) {
  const found = products.find((p) => p.metadata?.app === APP && p.metadata?.component === component);
  if (found) {
    reused.push(`product ${component}: ${found.id}`);
    return found;
  }
  return create(`product ${component}`, "/v1/products", { name, metadata: { app: APP, component } }, `product-${component}`);
}

async function ensurePrice(label, lookupKey, want, matches) {
  const existing = (await stripe("GET", "/v1/prices", { lookup_keys: [lookupKey], active: true })).data?.[0];
  if (existing && matches(existing)) {
    reused.push(`price ${label}: ${existing.id}`);
    return existing;
  }
  const params = { ...want, lookup_key: lookupKey, metadata: { app: APP, component: label } };
  if (existing) params.transfer_lookup_key = true; // amount changed: new price takes the lookup key, old one stays for existing subscriptions
  return create(`price ${label}${existing ? " (amount changed)" : ""}`, "/v1/prices", params, `price-${lookupKey}`);
}

async function ensureMeter(meterKey, m, meters) {
  const found = meters.find((x) => x.event_name === m.event_name);
  if (found) {
    if (found.status === "inactive") {
      if (DRY) created.push(`reactivate meter ${meterKey} ${found.id} (dry run)`);
      else {
        await stripe("POST", `/v1/billing/meters/${found.id}/reactivate`);
        created.push(`reactivated meter ${meterKey}: ${found.id}`);
      }
    } else reused.push(`meter ${meterKey}: ${found.id}`);
    return found;
  }
  return create(
    `meter ${meterKey}`,
    "/v1/billing/meters",
    {
      display_name: m.display_name ?? meterKey,
      event_name: m.event_name,
      default_aggregation: { formula: "sum" },
      customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
      value_settings: { event_payload_key: "value" },
    },
    `meter-${m.event_name}`,
  );
}

async function ensurePortal() {
  const configs = await listAll("/v1/billing_portal/configurations", { active: true });
  const found = configs.find((c) => c.metadata?.app === APP);
  if (found) {
    reused.push(`customer portal configuration: ${found.id}`);
    return found;
  }
  return create(
    "customer portal configuration",
    "/v1/billing_portal/configurations",
    {
      business_profile: { headline: plan.portal?.headline ?? "Manage your billing" },
      features: {
        payment_method_update: { enabled: true },
        invoice_history: { enabled: true },
        customer_update: { enabled: true, allowed_updates: ["email", "address", "name", "tax_id"] },
        subscription_cancel: { enabled: true, mode: "at_period_end" },
      },
      metadata: { app: APP },
    },
    "portal",
  );
}

async function ensureWebhook() {
  const url = `${origin}/webhooks/stripe`;
  const endpoints = await listAll("/v1/webhook_endpoints");
  const found = endpoints.find((e) => e.url === url);
  if (found) {
    const missing = WEBHOOK_EVENTS.filter((e) => !found.enabled_events?.includes(e) && !found.enabled_events?.includes("*"));
    if (missing.length && !DRY) await stripe("POST", `/v1/webhook_endpoints/${found.id}`, { enabled_events: [...new Set([...(found.enabled_events ?? []), ...WEBHOOK_EVENTS])] });
    reused.push(`webhook endpoint: ${found.id}${missing.length ? ` (added ${missing.length} event types${DRY ? ", dry run" : ""})` : ""}`);
    if (found.api_version && found.api_version !== API_VERSION) {
      console.warn(`! The existing webhook endpoint uses API version ${found.api_version}; the Worker expects ${API_VERSION}. Delete it in the Stripe dashboard and run this again to recreate it.`);
    }
    return { endpoint: found, secret: null };
  }
  const ep = await create(
    "webhook endpoint",
    "/v1/webhook_endpoints",
    { url, enabled_events: WEBHOOK_EVENTS, api_version: API_VERSION, description: "GEO Observability billing", metadata: { app: APP } },
    "webhook",
  );
  return { endpoint: ep, secret: ep.secret ?? null };
}

// ------------------------------------------------------------------ main

async function main() {
  console.log(`Stripe setup for ${APP}${DRY ? " (dry run: nothing will be created)" : ""}`);
  try {
    const acct = await stripe("GET", "/v1/account");
    const name = acct?.settings?.dashboard?.display_name || acct?.business_profile?.name || "";
    console.log(`Account: ${acct.id}${name ? ` · ${name}` : ""} · test mode`);
  } catch {
    console.log("Account: (couldn't read account details with this key; carrying on in test mode)");
  }

  const products = await listAll("/v1/products", { active: true });
  const meters = await listAll("/v1/billing/meters");

  const platformProduct = await ensureProduct("platform", plan.platform.product_name, products);
  const platformPrice = await ensurePrice(
    "platform",
    plan.platform.lookup_key,
    { currency: plan.currency, product: platformProduct.id, unit_amount: plan.platform.unit_amount, recurring: { interval: plan.platform.interval ?? "month" } },
    (p) => p.currency === plan.currency && p.unit_amount === plan.platform.unit_amount && p.recurring?.interval === (plan.platform.interval ?? "month") && p.recurring?.usage_type === "licensed",
  );

  const metered = {};
  for (const [meterKey, m] of Object.entries(plan.meters)) {
    const meter = await ensureMeter(meterKey, m, meters);
    const product = await ensureProduct(`meter_${meterKey}`, m.product_name ?? m.display_name ?? meterKey, products);
    const price = await ensurePrice(
      meterKey,
      m.lookup_key,
      {
        currency: plan.currency,
        product: product.id,
        unit_amount_decimal: String(m.unit_amount_decimal),
        billing_scheme: "per_unit",
        recurring: { interval: plan.platform.interval ?? "month", usage_type: "metered", meter: meter.id },
      },
      (p) =>
        p.currency === plan.currency &&
        p.recurring?.usage_type === "metered" &&
        p.recurring?.meter === meter.id &&
        Number(p.unit_amount_decimal) === Number(m.unit_amount_decimal),
    );
    metered[meterKey] = { event_name: m.event_name, price: price.id };
  }

  const portal = await ensurePortal();
  const webhook = SKIP_WEBHOOK ? null : await ensureWebhook();

  const billingConfig = { platform_price: platformPrice.id, metered, portal_config: portal.id };
  if (plan.trial_days > 0) billingConfig.trial_days = plan.trial_days;

  console.log("\nReused:");
  for (const r of reused) console.log(`  · ${r}`);
  if (!reused.length) console.log("  · nothing");
  console.log("Created:");
  for (const c of created) console.log(`  + ${c}`);
  if (!created.length) console.log("  · nothing (everything already existed)");

  console.log("\nSTRIPE_BILLING_CONFIG:");
  console.log(JSON.stringify(billingConfig, null, 2));

  if (DRY) {
    console.log("\nDry run finished. Run again without --dry-run to create the missing pieces.");
    return;
  }

  const envArgs = WRANGLER_ENV ? ["--env", WRANGLER_ENV] : [];
  const envFlag = WRANGLER_ENV ? ` --env ${WRANGLER_ENV}` : "";
  const configFile = ".tmp/stripe-billing-config.json";
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(billingConfig));

  const secrets = [
    ["STRIPE_SECRET_KEY", KEY],
    ["STRIPE_BILLING_CONFIG", JSON.stringify(billingConfig)],
  ];
  if (webhook?.secret) secrets.push(["STRIPE_WEBHOOK_SECRET", webhook.secret]);

  if (PUT) {
    console.log(`\nSetting Worker secrets with wrangler${envFlag}…`);
    for (const [name, value] of secrets) {
      execFileSync("npx", ["wrangler", "secret", "put", name, ...envArgs], { input: value, stdio: ["pipe", "inherit", "inherit"] });
    }
    rmSync(configFile, { force: true });
    console.log("Secrets set.");
  } else {
    let webhookFile = null;
    if (webhook?.secret) {
      webhookFile = ".tmp/stripe-webhook-secret";
      writeFileSync(webhookFile, webhook.secret, { mode: 0o600 });
    }
    console.log("\nSet the Worker secrets (run from the repo root):");
    console.log(`  printf %s "$STRIPE_SECRET_KEY" | npx wrangler secret put STRIPE_SECRET_KEY${envFlag}`);
    console.log(`  npx wrangler secret put STRIPE_BILLING_CONFIG${envFlag} < ${configFile}`);
    if (webhookFile) console.log(`  npx wrangler secret put STRIPE_WEBHOOK_SECRET${envFlag} < ${webhookFile} && rm ${webhookFile}`);
    console.log(`  rm ${configFile}`);
  }

  if (webhook && !webhook.secret) {
    console.log(
      "\nThe webhook endpoint already existed, so Stripe won't show its signing secret again here. If STRIPE_WEBHOOK_SECRET isn't set on the Worker yet, " +
        "open the endpoint in the Stripe dashboard (Developers → Webhooks), reveal the signing secret, and run: npx wrangler secret put STRIPE_WEBHOOK_SECRET" +
        envFlag,
    );
  }
  console.log("\nThen deploy: npm run deploy:production");
}

main().catch((e) => die(e.message));
