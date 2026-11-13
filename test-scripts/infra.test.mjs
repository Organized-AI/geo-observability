import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, checkConfig, cloudflare, describe, loadAll, plan } from "../scripts/infra.mjs";

test("the repository's config passes, with staging placeholders as warnings only", async () => {
  const envs = await loadAll();
  const { errors } = checkConfig(envs);
  assert.deepEqual(errors, []);
});

test("staging that inherits production routes or shares a resource fails", async () => {
  const envs = await loadAll();
  const leaky = structuredClone(envs);
  leaky.staging.routes = [...envs.production.routes];
  leaky.staging.r2 = [...envs.production.r2];
  leaky.staging.consumers = [{ queue: "q", dlq: "" }];
  const { errors } = checkConfig(leaky);
  assert.ok(errors.some((e) => e.includes('shares route "app.organizedai.vip/geo-observability"')), errors.join("\n"));
  assert.ok(errors.some((e) => e.includes("shares R2 bucket")));
  assert.ok(errors.some((e) => e.includes("no dead_letter_queue")));
});

test("staging placeholders fail when staging is being deployed", async () => {
  const envs = await loadAll();
  envs.staging.d1[0].id = "REPLACE_WITH_STAGING_D1_ID";
  assert.ok(checkConfig(envs, { strict: ["staging"] }).errors.some((e) => e.includes("placeholder")));
});

test("a missing var in staging fails", () => {
  const base = { name: "w", vars: { AI_GATEWAY_ID: "g", A: "1" }, d1_databases: [], kv_namespaces: [], r2_buckets: [] };
  const prod = describe("production", base);
  const staging = describe("staging", { ...base, name: "w-staging", vars: { AI_GATEWAY_ID: "g-staging" } });
  assert.ok(checkConfig({ production: prod, staging }).errors.some((e) => e.includes("vars differ")));
});

function fakeCloudflare(state) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace(/^.*\/accounts\/acct/, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push(`${init.method} ${path}`);
    const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    const nf = () => new Response("{}", { status: 404 });
    if (init.method === "GET") {
      if (path.startsWith("/workers/scripts/") && path.endsWith("/settings")) return state.worker ? ok({}) : nf();
      if (path.endsWith("/secrets")) return ok(state.secrets.map((name) => ({ name, type: "secret_text" })));
      if (path.startsWith("/d1/database?name=")) return ok(state.d1.filter((d) => path.endsWith(encodeURIComponent(d.name))));
      if (path.startsWith("/storage/kv/namespaces")) return ok(state.kv);
      if (path.startsWith("/r2/buckets/")) return state.r2.includes(decodeURIComponent(path.split("/").pop())) ? ok({}) : nf();
      if (path.startsWith("/queues")) return ok(state.queues.map((queue_name) => ({ queue_name })));
      if (path.startsWith("/ai-gateway/gateways/")) return state.gateways.includes(path.split("/").pop()) ? ok({}) : nf();
    }
    if (init.method === "POST") {
      if (path === "/d1/database") return ok({ uuid: "new-d1-uuid", name: body.name });
      if (path === "/storage/kv/namespaces") return ok({ id: "newkvid", title: body.title });
      return ok({});
    }
    return nf();
  };
  return { call: cloudflare({ token: "t", accountId: "acct", fetchImpl }), calls };
}

test("plan finds what is missing and apply creates it and records new ids", async () => {
  const envs = await loadAll();
  const staging = envs.staging;
  const { call, calls } = fakeCloudflare({ worker: false, secrets: [], d1: [], kv: [], r2: [], queues: ["geo-observability-runs-staging"], gateways: [] });
  const items = await plan(staging, call);
  const missing = items.filter((i) => i.status === "missing").map((i) => `${i.kind}:${i.name}`);
  assert.deepEqual(missing.sort(), [
    "AI Gateway:geo-observability-staging",
    "D1:geo-observability-staging",
    "KV:geo-observability-config-staging",
    "Queue:geo-observability-runs-staging-dlq",
    "R2:geo-observability-answers-staging",
  ]);
  assert.ok(calls.every((c) => c.startsWith("GET")), "plan only reads");

  const dir = mkdtempSync(join(tmpdir(), "infra-"));
  const config = join(dir, "wrangler.jsonc");
  writeFileSync(config, '{ "a": "REPLACE_WITH_STAGING_D1_ID", "b": "REPLACE_WITH_STAGING_KV_ID" }');
  const writes = await apply(items, call, { configPath: config, log: () => {} });
  assert.equal(writes.length, 2);
  assert.equal(readFileSync(config, "utf8"), '{ "a": "new-d1-uuid", "b": "newkvid" }');
  assert.deepEqual(calls.filter((c) => c.startsWith("POST")).sort(), ["POST /ai-gateway/gateways", "POST /d1/database", "POST /queues", "POST /r2/buckets", "POST /storage/kv/namespaces"]);
});

test("plan on production reports matching ids, deployed Worker and missing required secrets", async () => {
  const envs = await loadAll();
  const p = envs.production;
  const { call } = fakeCloudflare({
    worker: true,
    secrets: ["EMAIL_FROM", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_BILLING_CONFIG"],
    d1: [{ name: p.d1[0].name, uuid: p.d1[0].id }],
    kv: [{ id: p.kv[0].id, title: "geo-observability-config" }],
    r2: [p.r2[0].name],
    queues: p.queues,
    gateways: [p.gateway],
  });
  const items = await plan(p, call);
  const notOk = items.filter((i) => i.status !== "ok").map((i) => `${i.kind}:${i.name}:${i.status}`);
  assert.deepEqual(notOk, ["Secrets:required:missing", "Secrets:ai_gateway:info", "Secrets:engines:info", "Secrets:optional:info"]);
  assert.match(items.find((i) => i.name === "required").detail, /SHARE_LINK_SECRET/);
});

test("a D1 id that differs from the account is reported, never overwritten", async () => {
  const envs = await loadAll();
  const { call } = fakeCloudflare({ worker: false, secrets: [], d1: [{ name: envs.production.d1[0].name, uuid: "other" }], kv: [], r2: [], queues: [], gateways: [] });
  const items = await plan(envs.production, call);
  const d1 = items.find((i) => i.kind === "D1");
  assert.equal(d1.status, "mismatch");
  assert.equal(d1.fix, undefined);
});
