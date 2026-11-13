#!/usr/bin/env node
/**
 * Infrastructure for each environment, declared by wrangler.jsonc (bindings and resource names) and
 * infra/environments.json (KV titles, which secrets each Worker needs).
 *
 *   node scripts/infra.mjs check                       offline: staging mirrors production with its own resources
 *   node scripts/infra.mjs check --strict staging      ...and staging has no placeholder ids left (deploys use this)
 *   node scripts/infra.mjs plan  --env staging         read-only: what exists in Cloudflare, what is missing
 *   node scripts/infra.mjs apply --env staging         create what is missing, write new ids into wrangler.jsonc
 *
 * plan and apply need CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment. They only read secret
 * names, never values, and never set secrets: those stay `wrangler secret put [--env staging]`.
 * Created by `wrangler deploy` itself, so not listed here: the Worker, routes, cron triggers, Workflows, the
 * Durable Object class, Analytics Engine datasets and static assets.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(ROOT, "wrangler.jsonc");
const ENVIRONMENTS = JSON.parse(readFileSync(join(ROOT, "infra/environments.json"), "utf8"));
export const PLACEHOLDER = /^REPLACE_WITH_/;

/** Resolved wrangler config for an environment ("production" is the top level). */
export async function readWrangler(env, configPath = CONFIG_PATH) {
  const { unstable_readConfig } = await import("wrangler");
  const wranglerEnv = ENVIRONMENTS.environments[env]?.wrangler_env;
  if (wranglerEnv === undefined) throw new Error(`unknown environment "${env}"`);
  return unstable_readConfig({ config: configPath, env: wranglerEnv || undefined }, { hideWarnings: true });
}

/** Everything an environment needs, by kind, from its resolved config. */
export function describe(env, c) {
  const consumers = c.queues?.consumers ?? [];
  const queues = new Set([...(c.queues?.producers ?? []).map((p) => p.queue), ...consumers.map((q) => q.queue)]);
  for (const q of consumers) if (q.dead_letter_queue) queues.add(q.dead_letter_queue);
  const titles = ENVIRONMENTS.environments[env]?.kv_titles ?? {};
  return {
    env,
    worker: c.name,
    routes: (c.routes ?? []).map((r) => (typeof r === "string" ? r : r.pattern)),
    vars: Object.keys(c.vars ?? {}).sort(),
    gateway: c.vars?.AI_GATEWAY_ID ?? "",
    d1: (c.d1_databases ?? []).map((d) => ({ binding: d.binding, name: d.database_name, id: d.database_id })),
    kv: (c.kv_namespaces ?? []).map((k) => ({ binding: k.binding, id: k.id, title: titles[k.binding] })),
    r2: (c.r2_buckets ?? []).map((b) => ({ binding: b.binding, name: b.bucket_name })),
    queues: [...queues].sort(),
    consumers: consumers.map((q) => ({ queue: q.queue, dlq: q.dead_letter_queue ?? "" })),
    workflows: (c.workflows ?? []).map((w) => ({ binding: w.binding, name: w.name })),
    datasets: (c.analytics_engine_datasets ?? []).map((d) => ({ binding: d.binding, name: d.dataset })),
    durableObjects: (c.durable_objects?.bindings ?? []).map((d) => d.name).sort(),
    ai: Boolean(c.ai?.binding),
    email: (c.send_email ?? []).map((e) => e.name).sort(),
  };
}

/** Offline checks. Errors fail CI; warnings print. */
export function checkConfig(envs, { strict = [] } = {}) {
  const errors = [];
  const warnings = [];
  const prod = envs.production;
  for (const e of Object.values(envs)) {
    for (const d of e.d1) if (PLACEHOLDER.test(d.id ?? "")) (e.env === "production" || strict.includes(e.env) ? errors : warnings).push(`${e.env}: D1 ${d.binding} (${d.name}) has placeholder id ${d.id}; run: npm run infra:apply -- --env ${e.env}`);
    for (const k of e.kv) {
      if (PLACEHOLDER.test(k.id ?? "")) (e.env === "production" || strict.includes(e.env) ? errors : warnings).push(`${e.env}: KV ${k.binding} has placeholder id ${k.id}; run: npm run infra:apply -- --env ${e.env}`);
      if (!k.title) errors.push(`${e.env}: KV ${k.binding} has no title in infra/environments.json`);
    }
    for (const q of e.consumers) if (!q.dlq) errors.push(`${e.env}: queue consumer ${q.queue} has no dead_letter_queue`);
    if (!e.gateway) errors.push(`${e.env}: vars.AI_GATEWAY_ID is not set`);
    if (e === prod) continue;

    const same = (label, a, b) => {
      const x = JSON.stringify([...a].sort());
      const y = JSON.stringify([...b].sort());
      if (x !== y) errors.push(`${e.env}: ${label} differ from production (${y} here vs ${x})`);
    };
    same("D1 bindings", prod.d1.map((d) => d.binding), e.d1.map((d) => d.binding));
    same("KV bindings", prod.kv.map((d) => d.binding), e.kv.map((d) => d.binding));
    same("R2 bindings", prod.r2.map((d) => d.binding), e.r2.map((d) => d.binding));
    same("Workflow bindings", prod.workflows.map((d) => d.binding), e.workflows.map((d) => d.binding));
    same("Analytics Engine bindings", prod.datasets.map((d) => d.binding), e.datasets.map((d) => d.binding));
    same("Durable Object bindings", prod.durableObjects, e.durableObjects);
    same("send_email bindings", prod.email, e.email);
    same("vars", prod.vars, e.vars);
    if (prod.ai !== e.ai) errors.push(`${e.env}: AI binding differs from production`);

    // Never share a production resource.
    const shared = (label, a, b) => {
      for (const v of b) if (v && a.includes(v)) errors.push(`${e.env}: shares ${label} "${v}" with production`);
    };
    shared("Worker name", [prod.worker], [e.worker]);
    shared("route", prod.routes, e.routes);
    shared("D1 database", prod.d1.flatMap((d) => [d.name, d.id]), e.d1.flatMap((d) => [d.name, d.id]));
    shared("KV namespace", prod.kv.flatMap((d) => [d.id, d.title]), e.kv.flatMap((d) => [d.id, d.title]));
    shared("R2 bucket", prod.r2.map((d) => d.name), e.r2.map((d) => d.name));
    shared("queue", prod.queues, e.queues);
    shared("Workflow", prod.workflows.map((d) => d.name), e.workflows.map((d) => d.name));
    shared("Analytics Engine dataset", prod.datasets.map((d) => d.name), e.datasets.map((d) => d.name));
    shared("AI Gateway", [prod.gateway], [e.gateway]);
  }
  return { errors, warnings };
}

/** Minimal Cloudflare API client. `fetchImpl` is injectable for tests. */
export function cloudflare({ token, accountId, fetchImpl = fetch }) {
  if (!token || !accountId) throw new Error("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (see infra/README.md for the token's permissions)");
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  return async function call(method, path, body) {
    const res = await fetchImpl(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404) return { status: 404, result: null };
    let json = {};
    try {
      json = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (!res.ok || json.success === false) {
      const why = (json.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
      const err = new Error(`${method} ${path} failed (${why})`);
      err.status = res.status;
      throw err;
    }
    return { status: res.status, result: json.result };
  };
}

/** What exists and what is missing. Each item: { kind, name, status: ok|missing|mismatch|info, detail?, fix? }. */
export async function plan(e, call) {
  const items = [];
  const worker = await call("GET", `/workers/scripts/${encodeURIComponent(e.worker)}/settings`);
  items.push({ kind: "Worker", name: e.worker, status: worker.result ? "ok" : "info", detail: worker.result ? "deployed" : "not deployed yet (the first deploy creates it)" });

  for (const d of e.d1) {
    const found = (await call("GET", `/d1/database?name=${encodeURIComponent(d.name)}`)).result ?? [];
    const db = found.find((x) => x.name === d.name);
    if (!db) items.push({ kind: "D1", name: d.name, status: "missing", fix: { type: "d1", binding: d.binding, name: d.name, placeholder: d.id } });
    else if (db.uuid !== d.id) items.push({ kind: "D1", name: d.name, status: PLACEHOLDER.test(d.id) ? "missing" : "mismatch", detail: `exists as ${db.uuid}, wrangler.jsonc has ${d.id}`, fix: PLACEHOLDER.test(d.id) ? { type: "write-id", placeholder: d.id, id: db.uuid } : undefined });
    else items.push({ kind: "D1", name: d.name, status: "ok", detail: d.id });
  }

  const namespaces = e.kv.length ? (await call("GET", "/storage/kv/namespaces?per_page=100")).result ?? [] : [];
  for (const k of e.kv) {
    const byId = namespaces.find((n) => n.id === k.id);
    const byTitle = namespaces.find((n) => n.title === k.title);
    if (byId) items.push({ kind: "KV", name: byId.title, status: "ok", detail: k.id });
    else if (byTitle) items.push({ kind: "KV", name: k.title, status: PLACEHOLDER.test(k.id) ? "missing" : "mismatch", detail: `exists as ${byTitle.id}, wrangler.jsonc has ${k.id}`, fix: PLACEHOLDER.test(k.id) ? { type: "write-id", placeholder: k.id, id: byTitle.id } : undefined });
    else items.push({ kind: "KV", name: k.title, status: "missing", fix: { type: "kv", title: k.title, placeholder: k.id } });
  }

  for (const b of e.r2) {
    const found = (await call("GET", `/r2/buckets/${encodeURIComponent(b.name)}`)).result;
    items.push(found ? { kind: "R2", name: b.name, status: "ok" } : { kind: "R2", name: b.name, status: "missing", fix: { type: "r2", name: b.name } });
  }

  const queues = e.queues.length ? (await call("GET", "/queues?per_page=100")).result ?? [] : [];
  for (const q of e.queues) {
    const found = queues.some((x) => x.queue_name === q);
    items.push(found ? { kind: "Queue", name: q, status: "ok" } : { kind: "Queue", name: q, status: "missing", fix: { type: "queue", name: q } });
  }

  const gw = (await call("GET", `/ai-gateway/gateways/${encodeURIComponent(e.gateway)}`)).result;
  items.push(gw ? { kind: "AI Gateway", name: e.gateway, status: "ok" } : { kind: "AI Gateway", name: e.gateway, status: "missing", fix: { type: "gateway", id: e.gateway } });

  if (worker.result) {
    const names = new Set(((await call("GET", `/workers/scripts/${encodeURIComponent(e.worker)}/secrets`)).result ?? []).map((s) => s.name));
    const s = ENVIRONMENTS.secrets;
    for (const [group, list] of Object.entries(s)) {
      const missing = list.filter((n) => !names.has(n));
      const status = missing.length === 0 ? "ok" : group === "required" ? "missing" : "info";
      items.push({ kind: "Secrets", name: group, status, detail: missing.length ? `not set: ${missing.join(", ")}` : "all set" });
    }
  }
  return items;
}

/** Create what plan found missing and write new ids into wrangler.jsonc (placeholders only). */
export async function apply(items, call, { configPath = CONFIG_PATH, log = console.log } = {}) {
  const writes = [];
  for (const it of items) {
    const f = it.fix;
    if (!f) continue;
    if (f.type === "d1") {
      const r = (await call("POST", "/d1/database", { name: f.name, primary_location_hint: "enam" })).result;
      log(`created D1 ${f.name} (${r.uuid})`);
      if (PLACEHOLDER.test(f.placeholder ?? "")) writes.push([f.placeholder, r.uuid]);
    } else if (f.type === "kv") {
      const r = (await call("POST", "/storage/kv/namespaces", { title: f.title })).result;
      log(`created KV ${f.title} (${r.id})`);
      if (PLACEHOLDER.test(f.placeholder ?? "")) writes.push([f.placeholder, r.id]);
    } else if (f.type === "r2") {
      await call("POST", "/r2/buckets", { name: f.name });
      log(`created R2 bucket ${f.name}`);
    } else if (f.type === "queue") {
      await call("POST", "/queues", { queue_name: f.name });
      log(`created queue ${f.name}`);
    } else if (f.type === "gateway") {
      await call("POST", "/ai-gateway/gateways", {
        id: f.id,
        cache_invalidate_on_update: false,
        cache_ttl: 0,
        collect_logs: true,
        rate_limiting_interval: 0,
        rate_limiting_limit: 0,
        rate_limiting_technique: "fixed",
        authentication: true,
      });
      log(`created AI Gateway ${f.id} (logging and authentication on; set CF_AIG_TOKEN on the Worker)`);
    } else if (f.type === "write-id") {
      writes.push([f.placeholder, f.id]);
    }
  }
  if (writes.length) {
    let text = readFileSync(configPath, "utf8");
    for (const [placeholder, id] of writes) {
      const quoted = `"${placeholder}"`;
      if (text.split(quoted).length !== 2) throw new Error(`expected ${placeholder} exactly once in wrangler.jsonc`);
      text = text.replace(quoted, `"${id}"`);
      log(`wrangler.jsonc: ${placeholder} -> ${id}`);
    }
    writeFileSync(configPath, text);
  }
  return writes;
}

export async function loadAll(configPath = CONFIG_PATH) {
  const envs = {};
  for (const name of Object.keys(ENVIRONMENTS.environments)) envs[name] = describe(name, await readWrangler(name, configPath));
  return envs;
}

function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  const cmd = argv[0];
  const envs = await loadAll();
  if (cmd === "check") {
    const strict = arg(argv, "--strict") ? [arg(argv, "--strict")] : [];
    const { errors, warnings } = checkConfig(envs, { strict });
    for (const w of warnings) console.log(`warning: ${w}`);
    for (const e of errors) console.log(`error: ${e}`);
    if (!errors.length) console.log(`infra config ok: ${Object.keys(envs).join(", ")}`);
    return errors.length ? 1 : 0;
  }
  if (cmd === "plan" || cmd === "apply") {
    const env = arg(argv, "--env");
    if (!envs[env]) throw new Error(`--env must be one of: ${Object.keys(envs).join(", ")}`);
    if (cmd === "apply" && env === "production" && !argv.includes("--confirm-production")) {
      throw new Error("apply on production needs --confirm-production");
    }
    const call = cloudflare({ token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID });
    const items = await plan(envs[env], call);
    const mark = { ok: "ok     ", missing: "MISSING", mismatch: "DIFFERS", info: "note   " };
    for (const it of items) console.log(`${mark[it.status]}  ${it.kind.padEnd(10)} ${it.name}${it.detail ? `  (${it.detail})` : ""}`);
    if (cmd === "plan") {
      const todo = items.filter((i) => i.fix).length;
      console.log(todo ? `\n${todo} to create or record: npm run infra:apply -- --env ${env}` : "\nnothing to create");
      return items.some((i) => i.status === "mismatch") ? 1 : 0;
    }
    await apply(items, call);
    console.log("\ndone. Commit wrangler.jsonc if it changed, then set secrets: npx wrangler secret put <NAME>" + (env === "production" ? "" : ` --env ${env}`));
    return 0;
  }
  console.log("usage: node scripts/infra.mjs check [--strict <env>] | plan --env <env> | apply --env <env>");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`error: ${err.message}`);
      process.exit(1);
    },
  );
}
