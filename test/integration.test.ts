import { env as rawEnv, SELF } from "cloudflare:test";
import type { Env } from "../src/env";
import { describe, expect, it, beforeAll } from "vitest";
import { TenantDB } from "../src/lib/db";
import { planPass } from "../src/workflows/scheduler";
import { askAndStore, markRun, persist, score } from "../src/workflows/pipeline";
import { rollupDay } from "../src/metrics/rollup";
import { generateInsights } from "../src/insights/engine";
import { aggregateUsage } from "../src/billing/hooks";
import { today } from "../src/lib/util";

const env = rawEnv as unknown as Env;

const H = (tenant?: string) => ({ "content-type": "application/json", ...(tenant ? { "x-tenant": tenant } : {}) });

async function call<T = any>(method: string, path: string, body?: unknown, tenant?: string): Promise<{ status: number; json: T }> {
  const res = await SELF.fetch(`https://geo.test${path}`, { method, headers: H(tenant), body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* csv */
  }
  return { status: res.status, json };
}

let tenantA = "";
let tenantB = "";
let projectA = "";
let projectB = "";

/** Run every planned job through the same steps the Workflow runs (stub engines: no keys in tests). */
async function runPass(tenantId: string, projectId: string, day = today()) {
  const jobs = await planPass(env, tenantId, projectId, day);
  for (const job of jobs) {
    await markRun(env, job, "running");
    const answer = await askAndStore(env, job);
    const scored = await score(env, job, answer);
    await persist(env, job, answer, scored);
  }
  return jobs.length;
}

beforeAll(async () => {
  const a = await call("POST", "/api/tenants", { name: "Acme Client", slug: "acme" });
  const b = await call("POST", "/api/tenants", { name: "Other Client", slug: "other" });
  tenantA = a.json.id;
  tenantB = b.json.id;
  projectA = (await call("POST", "/api/projects", { name: "Acme", domain: "acme.com" }, "acme")).json.id;
  projectB = (await call("POST", "/api/projects", { name: "Other", domain: "other.com" }, "other")).json.id;
});

describe("onboarding to first numbers", () => {
  it("creates prompts, competitors and runs a pass", async () => {
    const t = "acme";
    expect((await call("PUT", `/api/projects/${projectA}/profile`, { what_you_sell: "CRM software", buyers: "Small sales teams", markets: [{ country: "US", language: "en" }], facts: ["Has a free plan"] }, t)).status).toBe(200);
    expect((await call("POST", `/api/projects/${projectA}/brands`, { name: "Globex", domains: ["globex.com"] }, t)).status).toBe(201);
    expect((await call("POST", `/api/projects/${projectA}/brands`, { name: "Initech", aliases: ["Initrode"], domains: ["initech.io"] }, t)).status).toBe(201);
    const csv = "prompt,country,topic,tag\nWhat is the best CRM for a small team?,US,crm,core\nAcme vs Globex,US,comparisons,branded\nToo long " + "x".repeat(200) + ",US,,\nBad country,USA,,\n";
    const imp = await call("POST", `/api/projects/${projectA}/prompts/import`, csv, t);
    expect(imp.json.imported).toBe(2);
    expect(imp.json.errors).toHaveLength(2);
    const gen = await call("POST", `/api/projects/${projectA}/onboarding/prompts`, { count: 6, branded_share: 0.2 }, t);
    expect(gen.json.prompts.length).toBeGreaterThan(0);
    await call("PATCH", `/api/projects/${projectA}/prompts/${gen.json.prompts[0].id}`, { status: "active" }, t);
    const models = await call("GET", `/api/projects/${projectA}/models`, undefined, t);
    expect(models.json.find((m: any) => m.engine === "alexa").available).toBe(false);
    expect(models.json.find((m: any) => m.engine === "chatgpt").channel).toBe("stub");

    const n = await runPass(tenantA, projectA);
    expect(n).toBe(3 * 3); // 3 active prompts × chatgpt, claude, gemini
    await call("PATCH", `/api/projects/${projectA}`, { onboarding_step: "done" }, t);

    const ov = await call("GET", `/api/projects/${projectA}/overview`, undefined, t);
    expect(ov.status, JSON.stringify(ov.json)).toBe(200);
    expect(ov.json.kpis.answers.value).toBe(9);
    expect(ov.json.leaderboard.length).toBe(3);
    const vis = ov.json.kpis.visibility.value;
    expect(vis).toBeGreaterThanOrEqual(0);
    expect(vis).toBeLessThanOrEqual(1);
    expect(ov.json.top_sources.length).toBeGreaterThan(0);

    const chats = await call("GET", `/api/projects/${projectA}/chats?limit=3`, undefined, t);
    expect(chats.json.items).toHaveLength(3);
    expect(chats.json.next_cursor).toBeTruthy();
    const detail = await call("GET", `/api/projects/${projectA}/chats/${encodeURIComponent(chats.json.items[0].run_id)}`, undefined, t);
    expect(detail.json.answer_text.length).toBeGreaterThan(10);
    expect(detail.json.run.channel).toBe("stub");

    const perf = await call("GET", `/api/projects/${projectA}/prompts/performance`, undefined, t);
    expect(perf.json.items).toHaveLength(3);
    const gaps = await call("GET", `/api/projects/${projectA}/sources/domains?gap=1`, undefined, t);
    expect(Array.isArray(gaps.json.items)).toBe(true);
    const csvOut = await call("GET", `/api/projects/${projectA}/export/chats.csv`, undefined, t);
    expect(String(csvOut.json).split("\n")[0]).toContain("prompt");
  });

  it("rolls up, writes insights and aggregates usage", async () => {
    await rollupDay(env, tenantA, projectA, today());
    const tdb = new TenantDB(env.DB, tenantA);
    const r = await tdb.first<{ answers: number }>("SELECT SUM(answers) AS answers FROM daily_brand_metrics WHERE tenant_id = ?1 AND project_id = ?2 AND brand_id = (SELECT id FROM brands WHERE tenant_id = ?1 AND project_id = ?2 AND is_own = 1)", projectA);
    expect(r?.answers).toBe(9);
    const out = await generateInsights(env, tenantA, projectA, today());
    expect(out.actions).toBeGreaterThanOrEqual(0);
    const usage = await tdb.first<{ n: number }>("SELECT SUM(quantity) AS n FROM usage_events WHERE tenant_id = ?1 AND meter = 'answers_run'");
    expect(usage?.n).toBe(9);
    await aggregateUsage(env);
  });
});

describe("plan limits", () => {
  it("refuses more engines than the plan allows with a message the portal can show", async () => {
    const r = await call("PUT", `/api/projects/${projectA}/models`, { engines: ["chatgpt", "claude", "gemini", "perplexity"] }, "acme");
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("limit");
    expect(r.json.message).toMatch(/up to 3 engines/);
    const ok = await call("PUT", `/api/projects/${projectA}/models`, { engines: ["chatgpt", "claude", "gemini"] }, "acme");
    expect(ok.status).toBe(200);
  });
});

describe("tenant isolation", () => {
  it("TenantDB refuses unscoped queries", async () => {
    const tdb = new TenantDB(env.DB, tenantA);
    await expect(tdb.all("SELECT * FROM runs")).rejects.toThrow(/tenant_id/);
  });

  it("one tenant cannot read another's project or rows", async () => {
    await runPass(tenantB, projectB).catch(() => 0);
    const cross = await call("GET", `/api/projects/${projectA}/overview`, undefined, "other");
    expect(cross.status).toBe(404);
    const tdbB = new TenantDB(env.DB, tenantB);
    const rows = await tdbB.all("SELECT id FROM runs WHERE tenant_id = ?1 AND project_id = ?2", projectA);
    expect(rows).toHaveLength(0);
    const leakedChat = await call("GET", `/api/projects/${projectB}/chats`, undefined, "other");
    expect(leakedChat.json.items.every((i: any) => !String(i.prompt).toLowerCase().includes("acme"))).toBe(true);
  });
});

describe("observability layer", () => {
  it("ingests edge hits, referrals and deduplicated conversions into the Pages table", async () => {
    const key = await call("POST", "/api/keys", { name: "edge", scope: "ingest" }, "acme");
    expect(key.status).toBe(201);
    const k = key.json.secret;
    const ingest = (path: string, body: unknown) => SELF.fetch(`https://geo.test${path}`, { method: "POST", headers: { "content-type": "application/json", "x-ingest-key": k }, body: JSON.stringify(body) });
    const edge = await ingest("/ingest/edge", {
      project_id: projectA,
      events: [
        { path: "/pricing", ua: "Mozilla/5.0; compatible; ChatGPT-User/1.0", status: 200 },
        { path: "/pricing/", ua: "GPTBot/1.1", status: 200 },
        { path: "/pricing", ua: "Mozilla/5.0 Safari", referer: "https://chatgpt.com/" },
        { path: "/blog", ua: "Mozilla/5.0 Safari", referer: "https://www.google.com/" },
      ],
    });
    expect(await edge.json()).toEqual({ crawl: 2, referrals: 1 });
    const conv = await ingest("/ingest/conversion", {
      project_id: projectA,
      events: [
        { event_id: "o-1", event_name: "purchase", landing_path: "/pricing", utm_source: "chatgpt.com", value: 120, source: "shopify" },
        { event_id: "o-1", event_name: "purchase", landing_path: "/pricing", utm_source: "chatgpt.com", value: 120, source: "sgtm" },
        { event_id: "o-2", event_name: "purchase", landing_path: "/pricing", value: 50, source: "sgtm" },
      ],
    });
    expect(await conv.json()).toEqual({ kept: 1, duplicates: 1, unattributed: 1 });
    const hit = await SELF.fetch("https://geo.test/ingest/hit", { method: "POST", body: JSON.stringify({ k, p: projectA, url: "https://acme.com/pricing", ref: "https://claude.ai/" }) });
    expect(((await hit.json()) as any).assistant).toBe("claude");

    const pages = await call("GET", `/api/projects/${projectA}/website/pages`, undefined, "acme");
    const row = pages.json.items.find((i: any) => i.path === "/pricing");
    expect(row.retrievals).toBe(1);
    expect(row.training_hits).toBe(1);
    expect(row.sessions).toBe(2);
    expect(row.conversions).toBe(1);
    expect(row.revenue_micros).toBe(120_000_000);

    const wrongKey = await SELF.fetch("https://geo.test/ingest/edge", { method: "POST", headers: { "x-ingest-key": "geo_nope_nope_nope_nope_nope" }, body: "{}" });
    expect(wrongKey.status).toBe(401);
  });
});

describe("public API, MCP and sharing", () => {
  it("serves reports with a read key and MCP tools", async () => {
    const key = (await call("POST", "/api/keys", { name: "api", scope: "read" }, "acme")).json.secret;
    const res = await SELF.fetch("https://geo.test/api/v1/reports/brands", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectA, dimensions: ["engine"], order_by: [{ field: "visibility", direction: "desc" }], compare_previous: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.total).toBe(9); // 3 brands × 3 engines
    expect(body.data[0]).toHaveProperty("previous");

    const otherProject = await SELF.fetch("https://geo.test/api/v1/prompts?project_id=" + projectB, { headers: { "x-api-key": key } });
    expect(otherProject.status).toBe(404);

    const rpc = (m: any) => SELF.fetch("https://geo.test/mcp", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(m) }).then((r) => r.json() as Promise<any>);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).result.serverInfo.name).toBe("geo-observability");
    expect((await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools.length).toBeGreaterThanOrEqual(8);
    const projects = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_projects", arguments: {} } });
    expect(projects.result.structuredContent.data.map((p: any) => p.id)).toEqual([projectA]);
    const noAuth = await SELF.fetch("https://geo.test/mcp", { method: "POST", body: "{}" });
    expect(noAuth.status).toBe(401);
  });

  it("creates a signed, read-only share link", async () => {
    const view = await call("POST", `/api/projects/${projectA}/views`, { name: "Weekly", filters: { days: 7 } }, "acme");
    const share = await call("POST", `/api/projects/${projectA}/views/${view.json.id}/share`, { days: 7 }, "acme");
    const token = share.json.url.split("/shared/")[1];
    const pub = await SELF.fetch(`https://geo.test/api/shared/${token}`);
    expect(pub.status, await pub.clone().text()).toBe(200);
    const data = (await pub.json()) as any;
    expect(data.project.name).toBe("Acme");
    expect(data.overview.recent_chats).toEqual([]);
    const bad = await SELF.fetch(`https://geo.test/api/shared/${token.slice(0, -2)}xx`);
    expect(bad.status).toBe(404);
  });
});
