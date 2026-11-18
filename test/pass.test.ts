import { env as rawEnv, createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { serveWithBase } from "../src/lib/basepath";
import { sha256Hex } from "../src/lib/util";

const ORIGIN = "https://geo.test";
const base = rawEnv as unknown as Env;
const env = { ...base, DEMO_MODE: "true", DEMO_TENANT_SLUG: "demo" } as Env;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    createExecutionContext(),
  );
}

async function issuePass() {
  const res = await call("POST", "/api/pass");
  expect(res.status).toBe(201);
  return (await res.json()) as {
    pass_id: string;
    api_key: string;
    mcp_url: string;
    api_url: string;
    project_id: string;
    project_name: string;
    limits: { api: number; mcp: number };
    remaining: { api: number; mcp: number };
    days_left: number;
  };
}

beforeAll(async () => {
  await base.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, name, slug, plan, prompt_limit, project_limit, model_limit, country_limit) VALUES ('ten_demo','Demo workspace','demo','pro',150,2,4,3)",
  ).run();
  await base.DB.prepare(
    "INSERT OR IGNORE INTO projects (id, tenant_id, name, domain, schedule, onboarding_step) VALUES ('prj_demo','ten_demo','Northwind Desk','northwind-desk.example','paused','done')",
  ).run();
});

describe("visibility pass", () => {
  it("issues a read-only key and a self-contained MCP URL", async () => {
    const pass = await issuePass();
    expect(pass.api_key.startsWith("geo_")).toBe(true);
    expect(pass.mcp_url).toContain("/mcp?pass=ps_");
    expect(pass.api_url).toBe(`${ORIGIN}/api/v1`);
    expect(pass.project_id).toBe("prj_demo");
    expect(pass.project_name).toBe("Northwind Desk");
    expect(pass.limits).toEqual({ api: 200, mcp: 50 });
    expect(pass.remaining).toEqual({ api: 200, mcp: 50 });
    expect(pass.days_left).toBe(14);
  });

  it("counts REST calls and reports remaining usage", async () => {
    const pass = await issuePass();
    const projects = await call("GET", "/api/v1/projects", undefined, { "x-api-key": pass.api_key });
    expect(projects.status).toBe(200);
    const body = (await projects.json()) as { data: { id: string }[] };
    expect(body.data.some((project) => project.id === "prj_demo")).toBe(true);

    const me = await call("GET", "/api/pass/me", undefined, { "x-api-key": pass.api_key });
    expect(me.status).toBe(200);
    const usage = (await me.json()) as { usage: { api: number }; remaining: { api: number } };
    expect(usage.usage.api).toBe(1);
    expect(usage.remaining.api).toBe(199);
  });

  it("authenticates MCP from the pass URL", async () => {
    const pass = await issuePass();
    const token = new URL(pass.mcp_url).searchParams.get("pass");
    const mcp = await call("POST", `/mcp?pass=${token}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(mcp.status).toBe(200);
    const payload = (await mcp.json()) as { result: { serverInfo: { name: string } } };
    expect(payload.result.serverInfo.name).toBe("geo-observability");

    const me = await call("GET", "/api/pass/me", undefined, { "x-api-key": pass.api_key });
    const usage = (await me.json()) as { usage: { mcp: number }; remaining: { mcp: number } };
    expect(usage.usage.mcp).toBe(1);
    expect(usage.remaining.mcp).toBe(49);
  });

  it("stops at the API limit", async () => {
    const pass = await issuePass();
    const token = new URL(pass.mcp_url).searchParams.get("pass") ?? "";
    await base.DB.prepare("UPDATE demo_passes SET api_calls = api_limit WHERE token_hash = ?1")
      .bind(await sha256Hex(token)).run();

    const res = await call("GET", "/api/v1/projects", undefined, { "x-api-key": pass.api_key });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("pass_limit");
  });

  it("revokes the key", async () => {
    const pass = await issuePass();
    const revoked = await call("POST", "/api/pass/revoke", undefined, { "x-api-key": pass.api_key });
    expect(revoked.status).toBe(200);
    const after = await call("GET", "/api/v1/projects", undefined, { "x-api-key": pass.api_key });
    expect(after.status).toBe(401);
    expect((await call("POST", new URL(pass.mcp_url).pathname + new URL(pass.mcp_url).search, { jsonrpc: "2.0", id: 1, method: "initialize" })).status).toBe(401);
  });

  it("rejects expired passes on REST and MCP even after KV has expired", async () => {
    const pass = await issuePass();
    await base.DB.prepare("UPDATE demo_passes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1").bind(pass.pass_id).run();
    expect((await call("GET", "/api/v1/projects", undefined, { "x-api-key": pass.api_key })).status).toBe(401);
    expect((await call("POST", new URL(pass.mcp_url).pathname + new URL(pass.mcp_url).search, { jsonrpc: "2.0", id: 1, method: "initialize" })).status).toBe(401);
  });

  it("allows only the final remaining call under concurrent requests", async () => {
    const pass = await issuePass();
    await base.DB.prepare("UPDATE demo_passes SET api_calls = api_limit - 1 WHERE id = ?1").bind(pass.pass_id).run();
    const responses = await Promise.all(Array.from({ length: 4 }, () => call("GET", "/api/v1/projects", undefined, { "x-api-key": pass.api_key })));
    expect(responses.filter(r => r.status === 200)).toHaveLength(1);
    expect(responses.filter(r => r.status === 429)).toHaveLength(3);
  });

  it("returns usable pass URLs on the shared-host base path", async () => {
    const configured = { ...env, APP_URL: "https://app.example/geo-observability" } as Env;
    const res = await serveWithBase(new Request("https://app.example/geo-observability/api/pass", { method: "POST" }), configured,
      r => app.fetch(r, configured, createExecutionContext()), () => new Response("asset"));
    expect(res.status).toBe(201);
    const pass = await res.json() as { api_url: string; mcp_url: string };
    expect(pass.api_url).toBe("https://app.example/geo-observability/api/v1");
    expect(pass.mcp_url).toContain("https://app.example/geo-observability/mcp?pass=");
  });

  it("is unavailable when demo mode is off", async () => {
    const off = { ...base, DEMO_MODE: "false" } as Env;
    const res = await app.fetch(new Request(`${ORIGIN}/api/pass`, { method: "POST" }), off, createExecutionContext());
    expect(res.status).toBe(404);
  });
});
