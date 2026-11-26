/** G2: personal tracing keys stamp the person on every turn, and coding-tool content is private to its person. */
import { env as rawEnv, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { createSession, SESSION_COOKIE } from "../src/lib/session";

const env = rawEnv as unknown as Env;
const SLUG = "trace-keys";
const T_SAM = "1".repeat(32);
const T_KIM = "2".repeat(32);
const T_APP = "3".repeat(32);

let tenantId = "";
let samCookie = "";
let kimCookie = "";

async function call<T = any>(method: string, path: string, body?: unknown, cookie?: string): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-tenant": SLUG };
  if (cookie) headers.cookie = `${SESSION_COOKIE}=${cookie}`;
  const res = await SELF.fetch(`https://geo.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json };
}

const str = (key: string, v: string) => ({ key, value: { stringValue: v } });

function turn(traceId: string, claimedUser: string, prompt: string, harness = true) {
  const start = Date.now() - 60_000;
  return {
    resourceSpans: [
      {
        resource: { attributes: [str("service.name", harness ? "claude-code" : "support-bot")] },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId: traceId.slice(0, 16),
                name: "turn",
                startTimeUnixNano: `${start}000000`,
                endTimeUnixNano: `${start + 1000}000000`,
                attributes: [str("openinference.span.kind", "AGENT"), str("user.id", claimedUser), str("input.value", prompt), ...(harness ? [str("harness.name", "claude-code")] : [])],
              },
            ],
          },
        ],
      },
    ],
  };
}

const send = (key: string, payload: unknown) =>
  SELF.fetch("https://geo.test/ingest/otlp/v1/traces", { method: "POST", headers: { "content-type": "application/json", "x-ingest-key": key }, body: JSON.stringify(payload) });

async function member(email: string, role: "editor" | "viewer"): Promise<string> {
  const id = `usr_${email.split("@")[0]}`;
  await env.DB.prepare("INSERT INTO users (id, email) VALUES (?1, ?2)").bind(id, email).run();
  await env.DB.prepare("INSERT INTO memberships (tenant_id, user_id, role) VALUES (?1, ?2, ?3)").bind(tenantId, id, role).run();
  return (await createSession(env, id, true)).token;
}

beforeAll(async () => {
  tenantId = (await call("POST", "/api/tenants", { name: "Trace Keys", slug: SLUG })).json.id;
  samCookie = await member("sam@keys.test", "editor");
  kimCookie = await member("kim@keys.test", "viewer");
});

describe("personal tracing keys", () => {
  let samKey = "";
  let samKeyId = "";

  it("lets anyone make a key for themselves, and only an owner make one for someone else", async () => {
    const mine = await call("POST", "/api/tracing/keys", {}, samCookie);
    expect(mine.status).toBe(201);
    expect(mine.json.person).toBe("sam@keys.test");
    samKey = mine.json.secret;
    samKeyId = mine.json.id;

    expect((await call("POST", "/api/tracing/keys", {}, kimCookie)).status).toBe(201); // a viewer may send their own
    expect((await call("POST", "/api/tracing/keys", { person: "kim@keys.test" }, samCookie)).status).toBe(403);
    expect((await call("POST", "/api/tracing/keys", { person: "not an email" })).status).toBe(400);
    const forKim = await call("POST", "/api/tracing/keys", { person: "Kim@Keys.test" });
    expect(forKim.status).toBe(201);
    expect(forKim.json.person).toBe("kim@keys.test");
  });

  it("stamps the key's person on every span, whatever user.id claims", async () => {
    expect((await send(samKey, turn(T_SAM, "ceo@keys.test", "sam's secret plan"))).status).toBe(200);
    const row = await env.DB.prepare("SELECT user_id FROM llm_traces WHERE tenant_id = ?1 AND trace_id = ?2").bind(tenantId, T_SAM).first<{ user_id: string }>();
    expect(row!.user_id).toBe("sam@keys.test");
    const spans = await env.DB.prepare("SELECT DISTINCT user_id FROM llm_spans WHERE tenant_id = ?1 AND trace_id = ?2").bind(tenantId, T_SAM).all<{ user_id: string }>();
    expect(spans.results.map((r) => r.user_id)).toEqual(["sam@keys.test"]);
  });

  it("lists only your own keys unless you are an owner, and hides them from the general key list", async () => {
    const samList = (await call("GET", "/api/tracing/keys", undefined, samCookie)).json as { person: string }[];
    expect(new Set(samList.map((k) => k.person))).toEqual(new Set(["sam@keys.test"]));
    const all = (await call("GET", "/api/tracing/keys")).json as { person: string; secret?: string }[];
    expect(new Set(all.map((k) => k.person))).toEqual(new Set(["sam@keys.test", "kim@keys.test"]));
    expect(all.every((k) => k.secret === undefined)).toBe(true);
    const general = (await call("GET", "/api/keys")).json as unknown[];
    expect(general).toHaveLength(0);
  });

  it("lets a person revoke their own key but not someone else's", async () => {
    const kimKeys = (await call("GET", "/api/tracing/keys", undefined, kimCookie)).json as { id: string }[];
    expect((await call("DELETE", `/api/tracing/keys/${kimKeys[0]!.id}`, undefined, samCookie)).status).toBe(403);
    const spare = (await call("POST", "/api/tracing/keys", {}, samCookie)).json;
    expect((await call("DELETE", `/api/tracing/keys/${spare.id}`, undefined, samCookie)).status).toBe(200);
    expect((await send(spare.secret, turn("4".repeat(32), "x", "y"))).status).toBe(401);
    expect(samKeyId).toBeTruthy();
  });
});

describe("who can read coding-tool content", () => {
  beforeAll(async () => {
    const kimKey = (await call("POST", "/api/tracing/keys", {}, kimCookie)).json.secret;
    expect((await send(kimKey, turn(T_KIM, "kim@keys.test", "kim's draft"))).status).toBe(200);
    // An ordinary app's trace (not a coding tool) stays visible to the workspace.
    const appKey = (await call("POST", "/api/keys", { name: "app", scope: "ingest" })).json.secret;
    expect((await send(appKey, turn(T_APP, "end-user-1", "customer question", false))).status).toBe(200);
  });

  it("shows a member only their own turns, plus shared app traces", async () => {
    const ids = ((await call("GET", "/api/tracing/traces", undefined, samCookie)).json.items as { trace_id: string }[]).map((t) => t.trace_id);
    expect(ids).toContain(T_SAM);
    expect(ids).toContain(T_APP);
    expect(ids).not.toContain(T_KIM);
    const owner = ((await call("GET", "/api/tracing/traces")).json.items as { trace_id: string }[]).map((t) => t.trace_id);
    expect(owner).toEqual(expect.arrayContaining([T_SAM, T_KIM, T_APP]));
  });

  it("hides someone else's trace, spans, sessions, report and export", async () => {
    expect((await call("GET", `/api/tracing/traces/${T_KIM}`, undefined, samCookie)).status).toBe(404);
    expect((await call("GET", `/api/tracing/traces/${T_KIM}/spans/${T_KIM.slice(0, 16)}`, undefined, samCookie)).status).toBe(404);
    expect((await call("GET", `/api/tracing/traces/${T_SAM}`, undefined, samCookie)).status).toBe(200);
    expect((await call("GET", `/api/tracing/traces/${T_KIM}`)).status).toBe(200);

    expect((await call("GET", "/api/tracing/people/kim@keys.test", undefined, samCookie)).status).toBe(403);
    expect((await call("GET", "/api/tracing/people/kim@keys.test/reports", undefined, samCookie)).status).toBe(403);
    expect((await call("GET", "/api/tracing/people/sam@keys.test", undefined, samCookie)).status).toBe(200);
    expect((await call("GET", "/api/tracing/people/kim@keys.test")).status).toBe(200);

    const csv = await call("GET", "/api/tracing/export/traces.csv", undefined, samCookie);
    expect(String(csv.json)).toContain(T_SAM);
    expect(String(csv.json)).not.toContain(T_KIM);
    const jsonl = await call("GET", "/api/tracing/export/traces.jsonl", undefined, samCookie);
    expect(String(jsonl.json)).not.toContain("kim's draft");
  });

  it("still shows usage numbers for everyone on People", async () => {
    const people = (await call("GET", "/api/tracing/people", undefined, samCookie)).json as { user_id: string }[];
    expect(people.map((p) => p.user_id)).toEqual(expect.arrayContaining(["sam@keys.test", "kim@keys.test"]));
  });
});

describe("capture level and redaction", () => {
  let ownerKey = "";
  const T_TOOL = "5".repeat(32);

  function codingSpans(traceId: string, prompt: string) {
    const body = turn(traceId, "x", prompt);
    const root = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    const tool = {
      ...root,
      spanId: "6".repeat(16),
      parentSpanId: root.spanId,
      name: "Bash",
      attributes: [str("openinference.span.kind", "TOOL"), str("harness.name", "claude-code"), str("tool.name", "Bash"), str("input.value", "cat .env"), str("output.value", "DB_PASSWORD=hunter2hunter2")],
    };
    body.resourceSpans[0]!.scopeSpans[0]!.spans.push(tool as typeof root);
    return body;
  }
  const spanText = (traceId: string) =>
    env.DB.prepare("SELECT span_id, input_text, output_text, attributes FROM llm_spans WHERE tenant_id = ?1 AND trace_id = ?2 ORDER BY span_id").bind(tenantId, traceId).all<{ span_id: string; input_text: string | null; output_text: string | null; attributes: string }>();

  beforeAll(async () => {
    ownerKey = (await call("POST", "/api/tracing/keys", {})).json.secret;
  });

  it("lets only an owner change the level, and tells a key what it is", async () => {
    expect((await call("GET", "/api/tracing/settings", undefined, samCookie)).json).toEqual({ capture: "full", email_reports: false });
    expect((await call("PUT", "/api/tracing/settings", { capture: "metadata" }, samCookie)).status).toBe(403);
    expect((await call("PUT", "/api/tracing/settings", { capture: "everything" })).status).toBe(400);
    expect((await call("PUT", "/api/tracing/settings", { capture: "prompts" })).status).toBe(200);
    const res = await SELF.fetch("https://geo.test/ingest/otlp/policy", { headers: { "x-ingest-key": ownerKey } });
    expect(await res.json()).toEqual({ capture: "prompts", person: "owner@agency.test" });
    expect((await SELF.fetch("https://geo.test/ingest/otlp/policy")).status).toBe(401);
  });

  it("prompts: keeps the prompt but drops tool inputs and outputs", async () => {
    expect((await send(ownerKey, codingSpans(T_TOOL, "please deploy"))).status).toBe(200);
    const rows = (await spanText(T_TOOL)).results;
    const tool = rows.find((r) => r.span_id === "6".repeat(16))!;
    const root = rows.find((r) => r.span_id !== "6".repeat(16))!;
    expect(root.input_text).toBe("please deploy");
    expect(tool.input_text).toBeNull();
    expect(tool.output_text).toBeNull();
    expect(tool.attributes).not.toContain("hunter2");
    expect(JSON.parse(tool.attributes)["tool.name"]).toBe("Bash");
  });

  it("metadata: no text at all from coding tools; other apps are unaffected", async () => {
    expect((await call("PUT", "/api/tracing/settings", { capture: "metadata" })).status).toBe(200);
    const T_META = "7".repeat(32);
    expect((await send(ownerKey, turn(T_META, "x", "secret roadmap"))).status).toBe(200);
    const row = (await spanText(T_META)).results[0]!;
    expect(row.input_text).toBeNull();
    expect(row.attributes).not.toContain("secret roadmap");
    const appKey = (await call("POST", "/api/keys", { name: "app2", scope: "ingest" })).json.secret;
    const T_APP2 = "8".repeat(32);
    expect((await send(appKey, turn(T_APP2, "u", "app question", false))).status).toBe(200);
    expect((await spanText(T_APP2)).results[0]!.input_text).toBe("app question");
    await call("PUT", "/api/tracing/settings", { capture: "full" });
  });

  it("redacts secrets in any span before storing it", async () => {
    const T_SECRET = "9".repeat(32);
    expect((await send(ownerKey, turn(T_SECRET, "x", "use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 please"))).status).toBe(200);
    const row = (await spanText(T_SECRET)).results[0]!;
    expect(row.input_text).toBe("use key [redacted:anthropic-key] please");
    expect(row.attributes).not.toContain("sk-ant-api03");
  });
});

describe("capacity: R2 bodies and the monthly quota", () => {
  let key = "";
  const T_BIG = "a".repeat(32);

  beforeAll(async () => {
    key = (await call("POST", "/api/keys", { name: "cap", scope: "ingest" })).json.secret;
  });

  it("deletes a trace's R2 body when the trace expires", async () => {
    const { pruneTenant } = await import("../src/tracing/retention");
    const { TenantDB } = await import("../src/lib/db");
    expect((await send(key, turn(T_BIG, "u", "z".repeat(12_000), false))).status).toBe(200);
    const row = await env.DB.prepare("SELECT body_key FROM llm_spans WHERE tenant_id = ?1 AND trace_id = ?2").bind(tenantId, T_BIG).first<{ body_key: string }>();
    expect(await env.ANSWERS.head(row!.body_key)).not.toBeNull();
    await pruneTenant(new TenantDB(env.DB, tenantId), Date.now() + 1000, 2000, env);
    expect(await env.ANSWERS.head(row!.body_key)).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM llm_spans WHERE tenant_id = ?1 AND trace_id = ?2").bind(tenantId, T_BIG).first()).toBeNull();
  });

  it("counts spans per month and refuses them past the limit", async () => {
    const usage = (await call("GET", "/api/tracing/usage")).json;
    expect(usage.limit).toBe(2_000_000);
    expect(usage.spans).toBeGreaterThan(0);
    expect(usage.bytes).toBeGreaterThan(0);
    await env.DB.prepare("UPDATE tenants SET trace_span_limit = ?2 WHERE id = ?1").bind(tenantId, usage.spans + 1).run();
    expect((await send(key, turn("b".repeat(32), "u", "last one", false))).status).toBe(200);
    const res = await send(key, turn("c".repeat(32), "u", "over", false));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("quota_exceeded");
    await env.DB.prepare("UPDATE tenants SET trace_span_limit = 2000000 WHERE id = ?1").bind(tenantId).run();
  });
});

describe("team rollout", () => {
  it("lets an owner make keys for many people at once, as a CSV only they download", async () => {
    expect((await call("POST", "/api/tracing/keys/bulk", { people: ["a@keys.test"] }, samCookie)).status).toBe(403);
    const res = await SELF.fetch("https://geo.test/api/tracing/keys/bulk", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": SLUG },
      body: JSON.stringify({ people: "New1@keys.test, new2@keys.test\nnot-an-email new1@keys.test" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("trace-keys-");
    const rows = (await res.text()).trim().split("\n").slice(1).map((l) => l.split(","));
    expect(rows.map((r) => r[0])).toEqual(["new1@keys.test", "new2@keys.test"]);
    const secret = rows[0]![1]!;
    const policy = await SELF.fetch("https://geo.test/ingest/otlp/policy", { headers: { "x-ingest-key": secret } });
    expect(((await policy.json()) as { person: string }).person).toBe("new1@keys.test");
  });

  it("skips people already at their key limit", async () => {
    for (let i = 0; i < 5; i++) await call("POST", "/api/tracing/keys", { person: "full@keys.test" });
    const res = await call("POST", "/api/tracing/keys/bulk", { people: ["full@keys.test"] });
    expect(String(res.json)).toContain("full@keys.test,,already has 5 keys");
  });
});
