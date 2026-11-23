import { env as rawEnv, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { fitAttributes, LIMITS } from "../src/tracing/store";
import { b64ToBytes, OTLP_JSON, OTLP_PROTOBUF_B64, OTLP_PROTOBUF_GZIP_B64 } from "./fixtures/otlp";

const env = rawEnv as unknown as Env;
const TRACE = "0af7651916cd43dd8448eb211c80319c";
const URL_TRACES = "https://geo.test/ingest/otlp/v1/traces";

async function call<T = any>(method: string, path: string, body?: unknown, tenant?: string): Promise<{ status: number; json: T }> {
  const res = await SELF.fetch(`https://geo.test${path}`, { method, headers: { "content-type": "application/json", ...(tenant ? { "x-tenant": tenant } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json };
}

const kv = (key: string, value: string | number) => ({ key, value: typeof value === "number" ? (Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }) : { stringValue: value } });
const hex = (n: number, len: number) => n.toString(16).padStart(len, "0");

interface SpanSpec {
  trace: number;
  span: number;
  parent?: number;
  name: string;
  start: number; // ms after BASE
  dur: number;
  attrs?: Record<string, string | number>;
  error?: string;
}
const BASE = Date.UTC(2026, 10, 20, 12, 0, 0);
function otlpJson(specs: SpanSpec[], resource: Record<string, string> = { "service.name": "shop-assistant" }) {
  return {
    resourceSpans: [
      {
        resource: { attributes: Object.entries(resource).map(([k, v]) => kv(k, v)) },
        scopeSpans: [
          {
            spans: specs.map((s) => ({
              traceId: hex(s.trace, 32),
              spanId: hex(s.span, 16),
              ...(s.parent ? { parentSpanId: hex(s.parent, 16) } : {}),
              name: s.name,
              startTimeUnixNano: `${BASE + s.start}000000`,
              endTimeUnixNano: `${BASE + s.start + s.dur}000000`,
              attributes: Object.entries(s.attrs ?? {}).map(([k, v]) => kv(k, v)),
              status: s.error ? { code: 2, message: s.error } : { code: 1 },
            })),
          },
        ],
      },
    ],
  };
}

function send(key: string | null, body: BodyInit, headers: Record<string, string> = { "content-type": "application/json" }) {
  return SELF.fetch(URL_TRACES, { method: "POST", headers: { ...(key ? { "x-ingest-key": key } : {}), ...headers }, body });
}
const sendJson = (key: string, payload: unknown, headers: Record<string, string> = {}) => send(key, JSON.stringify(payload), { "content-type": "application/json", ...headers });

const traceRow = (tenantId: string, traceId: string) => env.DB.prepare("SELECT * FROM llm_traces WHERE tenant_id = ?1 AND trace_id = ?2").bind(tenantId, traceId).first<Record<string, any>>();
const spanCount = async (tenantId: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM llm_spans WHERE tenant_id = ?1").bind(tenantId).first<{ n: number }>())!.n;

let tenantA = "";
let tenantB = "";
let keyA = "";
let keyB = "";
let readKeyA = "";

beforeAll(async () => {
  tenantA = (await call("POST", "/api/tenants", { name: "Trace Client A", slug: "trace-a" })).json.id;
  tenantB = (await call("POST", "/api/tenants", { name: "Trace Client B", slug: "trace-b" })).json.id;
  keyA = (await call("POST", "/api/keys", { name: "otlp", scope: "ingest" }, "trace-a")).json.secret;
  keyB = (await call("POST", "/api/keys", { name: "otlp", scope: "ingest" }, "trace-b")).json.secret;
  readKeyA = (await call("POST", "/api/keys", { name: "reader", scope: "read" }, "trace-a")).json.secret;
});

describe("OTLP ingest", () => {
  it("refuses requests without an ingest key", async () => {
    expect((await send(null, JSON.stringify(OTLP_JSON))).status).toBe(401);
    expect((await send("geo_this-key-does-not-exist-0123456789", JSON.stringify(OTLP_JSON))).status).toBe(401);
    expect((await send(readKeyA, JSON.stringify(OTLP_JSON))).status).toBe(401);
    expect(await spanCount(tenantA)).toBe(0);
  });

  it("stores a protobuf export and summarises the trace", async () => {
    const res = await send(keyA, b64ToBytes(OTLP_PROTOBUF_B64), { "content-type": "application/x-protobuf" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-protobuf");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    const t = await traceRow(tenantA, TRACE);
    expect(t).toMatchObject({
      name: "answer_question", kind: "AGENT", status: "ERROR", root_span_id: "b7ad6b7169203331", session_id: "sess-42", user_id: "user-7",
      start_ms: 1763900000000, end_ms: 1763900002500, span_count: 3, error_count: 1, llm_count: 1,
      prompt_tokens: 812, completion_tokens: 96, total_tokens: 908, cost_micros: 1234, model: "gpt-5-mini",
      input_preview: "How do I reset my password?", output_preview: "Open Settings, then Security.",
    });
    const app = await env.DB.prepare("SELECT name, last_seen_at FROM trace_apps WHERE id = ?1").bind(t!.app_id).first<{ name: string; last_seen_at: string | null }>();
    expect(app!.name).toBe("support-bot-prod");
    expect(app!.last_seen_at).toBeTruthy();
  });

  it("ignores a resend in any encoding", async () => {
    const before = await traceRow(tenantA, TRACE);
    expect((await send(keyA, b64ToBytes(OTLP_PROTOBUF_GZIP_B64), { "content-type": "application/x-protobuf", "content-encoding": "gzip" })).status).toBe(200);
    expect((await send(keyA, JSON.stringify(OTLP_JSON), { "content-type": "application/json", authorization: "Bearer ignored-because-x-ingest-key-wins" })).status).toBe(200);
    const bearer = await SELF.fetch(URL_TRACES, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${keyA}` }, body: JSON.stringify(OTLP_JSON) });
    expect(bearer.status).toBe(200);
    expect(await bearer.json()).toEqual({});
    expect(await spanCount(tenantA)).toBe(3);
    const after = await traceRow(tenantA, TRACE);
    for (const k of ["span_count", "error_count", "prompt_tokens", "completion_tokens", "total_tokens", "cost_micros", "start_ms", "end_ms", "status"]) expect(after![k]).toBe(before![k]);
  });

  it("gets the same totals when children arrive before their parent", async () => {
    const llm = (span: number, start: number, tokens: number): SpanSpec => ({ trace: 0xa1, span, parent: 1, name: "chat", start, dur: 400, attrs: { "openinference.span.kind": "LLM", "llm.model_name": "claude-sonnet-5-5", "llm.token_count.prompt": tokens, "llm.token_count.completion": 10, "llm.cost.total": 0.002 } });
    // Children first: the earliest child stands in as the trace's name until the root arrives.
    expect((await sendJson(keyA, otlpJson([llm(3, 900, 200), llm(2, 100, 100)]))).status).toBe(200);
    const partial = await traceRow(tenantA, hex(0xa1, 32));
    expect(partial).toMatchObject({ name: "chat", root_span_id: hex(2, 16), span_count: 2, prompt_tokens: 300, total_tokens: 320, cost_micros: 4000, status: "OK" });
    // The root repeats its children's usage; only model-calling spans count towards totals.
    const root: SpanSpec = { trace: 0xa1, span: 1, name: "plan_trip", start: 0, dur: 1500, attrs: { "openinference.span.kind": "CHAIN", "input.value": "Plan a weekend in Lisbon", "output.value": "Here is a two-day plan.", "llm.token_count.total": 320 } };
    expect((await sendJson(keyA, otlpJson([root]))).status).toBe(200);
    expect(await traceRow(tenantA, hex(0xa1, 32))).toMatchObject({
      name: "plan_trip", kind: "CHAIN", root_span_id: hex(1, 16), span_count: 3, llm_count: 2, prompt_tokens: 300, completion_tokens: 20, total_tokens: 320, cost_micros: 4000,
      start_ms: BASE, end_ms: BASE + 1500, input_preview: "Plan a weekend in Lisbon", output_preview: "Here is a two-day plan.", model: "claude-sonnet-5-5",
    });
  });

  it("names the app from the header, then the resource", async () => {
    const one = (trace: number): SpanSpec[] => [{ trace, span: 1, name: "x", start: 0, dur: 5 }];
    await sendJson(keyA, otlpJson(one(0xb1), { "service.name": "svc", "openinference.project.name": "proj" }));
    await sendJson(keyA, otlpJson(one(0xb2), { "service.name": "svc" }));
    await sendJson(keyA, otlpJson(one(0xb3), {}));
    await sendJson(keyA, otlpJson(one(0xb4), { "service.name": "svc", "openinference.project.name": "proj" }), { "x-project-name": "  from-header  " });
    const names = await env.DB.prepare("SELECT t.trace_id, a.name FROM llm_traces t JOIN trace_apps a ON a.id = t.app_id WHERE t.tenant_id = ?1 AND t.trace_id IN (?2, ?3, ?4, ?5) ORDER BY t.trace_id")
      .bind(tenantA, hex(0xb1, 32), hex(0xb2, 32), hex(0xb3, 32), hex(0xb4, 32))
      .all<{ name: string }>();
    expect(names.results.map((r) => r.name)).toEqual(["proj", "svc", "default", "from-header"]);
  });

  it("skips spans without valid ids and reports them", async () => {
    const payload = otlpJson([{ trace: 0xc1, span: 1, name: "ok", start: 0, dur: 5 }]);
    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans as Record<string, unknown>[];
    spans.push({ traceId: "nope", spanId: hex(2, 16), name: "bad trace id" }, { traceId: hex(0, 32), spanId: hex(3, 16), name: "zero trace id" });
    const before = await spanCount(tenantA);
    const res = await sendJson(keyA, payload);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partialSuccess: { rejectedSpans: "2", errorMessage: "spans without a valid trace id and span id were skipped" } });
    expect(await spanCount(tenantA)).toBe(before + 1);
    // Nothing usable at all is still a success with a count, as OTLP asks.
    expect((await (await sendJson(keyA, { resourceSpans: [] })).json())).toEqual({});
  });

  it("cuts oversized values and flags the span", async () => {
    const big = "x".repeat(LIMITS.attrValueChars + 500);
    await sendJson(keyA, otlpJson([{ trace: 0xd1, span: 1, name: "big", start: 0, dur: 5, attrs: { "input.value": big, "output.value": "short" } }]));
    const row = await env.DB.prepare("SELECT input_text, output_text, attributes, truncated FROM llm_spans WHERE tenant_id = ?1 AND trace_id = ?2").bind(tenantA, hex(0xd1, 32)).first<{ input_text: string; output_text: string; attributes: string; truncated: number }>();
    expect(row!.truncated).toBe(1);
    expect(row!.input_text.length).toBe(LIMITS.textChars);
    expect(row!.input_text.endsWith("…[cut]")).toBe(true);
    expect(row!.output_text).toBe("short");
    expect((JSON.parse(row!.attributes)["input.value"] as string).length).toBe(LIMITS.attrValueChars);

    const many: Record<string, string> = {};
    for (let i = 0; i < 12; i++) many[`blob.${i}`] = "y".repeat(30_000);
    many.small = "kept";
    const fit = fitAttributes(many);
    expect(fit.truncated).toBe(true);
    expect(fit.json.length).toBeLessThanOrEqual(LIMITS.attrJsonChars);
    expect(JSON.parse(fit.json).small).toBe("kept");
  });

  it("keeps workspaces apart", async () => {
    const beforeA = await spanCount(tenantA);
    // Same trace id as workspace A already holds: it is a separate trace in workspace B.
    expect((await send(keyB, b64ToBytes(OTLP_PROTOBUF_B64), { "content-type": "application/x-protobuf" })).status).toBe(200);
    expect(await spanCount(tenantB)).toBe(3);
    expect(await spanCount(tenantA)).toBe(beforeA);
    const a = await traceRow(tenantA, TRACE);
    const b = await traceRow(tenantB, TRACE);
    expect(b!.app_id).not.toBe(a!.app_id);
    const appsB = await env.DB.prepare("SELECT name FROM trace_apps WHERE tenant_id = ?1").bind(tenantB).all<{ name: string }>();
    expect(appsB.results.map((r) => r.name)).toEqual(["support-bot-prod"]);
  });
});

describe("tracing API", () => {
  const get = <T = any>(path: string, tenant = "trace-a") => call<T>("GET", `/api/tracing${path}`, undefined, tenant);

  beforeAll(async () => {
    // 25 small traces a second apart in their own app, with two sessions, one failure and one slow trace.
    const specs: SpanSpec[] = [];
    for (let i = 0; i < 25; i++) {
      specs.push({
        trace: 0xe000 + i, span: 1, name: i === 7 ? "refund_request" : "chat_turn", start: 10_000 + i * 1000, dur: i === 20 ? 9000 : 300,
        attrs: { "openinference.span.kind": "LLM", "llm.model_name": i % 2 ? "gpt-5-mini" : "sonar", "llm.token_count.total": 10, "input.value": `question ${i} about 50%_off`, "output.value": `answer ${i}`, ...(i < 6 ? { "session.id": i < 4 ? "s-one" : "s-two", "user.id": "u1" } : {}) },
        ...(i === 3 ? { error: "rate limited" } : {}),
      });
    }
    expect((await sendJson(keyA, otlpJson(specs, { "service.name": "paging-app" }))).status).toBe(200);
  });

  it("lists apps with trace counts for this workspace only", async () => {
    const a = await get("/apps");
    expect(a.status).toBe(200);
    const byName = Object.fromEntries(a.json.map((x: any) => [x.name, x.trace_count]));
    expect(byName["paging-app"]).toBe(25);
    expect(byName["support-bot-prod"]).toBe(1);
    const b = await get("/apps", "trace-b");
    expect(b.json.map((x: any) => x.name)).toEqual(["support-bot-prod"]);
  });

  it("pages through every trace once, newest first", async () => {
    const app = (await get("/apps")).json.find((x: any) => x.name === "paging-app").id;
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: { status: number; json: any } = await get(`/traces?app=${app}&limit=10${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.status).toBe(200);
      if (!cursor) expect(r.json.totals).toMatchObject({ traces: 25, errors: 1, total_tokens: 250 });
      else expect(r.json.totals).toBeNull();
      seen.push(...r.json.items.map((t: any) => t.trace_id));
      cursor = r.json.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen[0]).toBe(hex(0xe000 + 24, 32));
    expect(seen[24]).toBe(hex(0xe000, 32));
    expect((await get("/traces?cursor=garbage")).status).toBe(400);
  });

  it("filters by status, text, session, model, latency and date", async () => {
    const app = (await get("/apps")).json.find((x: any) => x.name === "paging-app").id;
    const ids = async (qs: string) => (await get(`/traces?app=${app}&limit=200&${qs}`)).json.items.map((t: any) => parseInt(t.trace_id.slice(-4), 16) - 0xe000);
    expect(await ids("status=error")).toEqual([3]);
    expect((await ids("status=ok")).length).toBe(24);
    expect(await ids("q=refund")).toEqual([7]);
    expect(await ids("q=answer%2012")).toEqual([12]);
    // % and _ in a search are literal characters, not wildcards.
    expect((await ids("q=50%25_off")).length).toBe(25);
    expect(await ids("q=5_%25off")).toEqual([]);
    expect(await ids(`q=${hex(0xe000 + 9, 32).toUpperCase()}`)).toEqual([9]);
    expect(await ids("session=s-two")).toEqual([5, 4]);
    expect((await ids("model=sonar")).length).toBe(13);
    expect(await ids("min_ms=5000")).toEqual([20]);
    expect((await ids("from=2026-11-20&to=2026-11-20")).length).toBe(25);
    expect(await ids("from=2026-11-21")).toEqual([]);
    expect(await ids("to=2026-11-19")).toEqual([]);
    expect((await get("/traces?from=2026-11-21&to=2026-11-20")).status).toBe(400);
    expect((await get("/traces?status=weird")).status).toBe(400);
  });

  it("returns a trace with its spans in start order and span bodies on demand", async () => {
    const r = await get(`/traces/${TRACE}`);
    expect(r.status).toBe(200);
    expect(r.json.trace).toMatchObject({ trace_id: TRACE, app: "support-bot-prod", name: "answer_question", latency_ms: 2500, span_count: 3 });
    expect(r.json.spans.map((s: any) => s.name)).toEqual(["answer_question", "ChatCompletion", "search_docs"]);
    expect(r.json.spans[0].attributes).toBeUndefined();
    expect(r.json.spans_truncated).toBe(false);

    const llm = await get(`/traces/${TRACE}/spans/00f067aa0ba902b7`);
    expect(llm.json).toMatchObject({ kind: "LLM", model: "gpt-5-mini", provider: "openai", prompt_tokens: 812, cost_micros: 1234, truncated: false });
    expect(llm.json.input_messages.map((m: any) => m.role)).toEqual(["system", "user"]);
    expect(llm.json.output_messages[0].tool_calls[0].name).toBe("search_docs");
    expect(llm.json.attributes["llm.model_name"]).toBe("gpt-5-mini");
    expect(llm.json.events).toEqual([{ name: "first_token", time_ms: 1763900000400, attributes: { n: 1 } }]);
    const tool = await get(`/traces/${TRACE}/spans/53995c3f42cd8ad8`);
    expect(tool.json).toMatchObject({ status_code: "ERROR", status_message: "index timeout" });

    expect((await get(`/traces/${hex(0xdead, 32)}`)).status).toBe(404);
    expect((await get("/traces/not-a-trace-id")).status).toBe(404);
    expect((await get(`/traces/${TRACE}/spans/${hex(0xdead, 16)}`)).status).toBe(404);
  });

  it("groups traces into sessions", async () => {
    const app = (await get("/apps")).json.find((x: any) => x.name === "paging-app").id;
    const s = await get(`/sessions?app=${app}`);
    expect(s.json.map((x: any) => [x.session_id, x.traces, x.errors, x.total_tokens])).toEqual([["s-two", 2, 0, 20], ["s-one", 4, 1, 40]]);
    expect(s.json[1]).toMatchObject({ first_input: "question 0 about 50%_off", last_output: "answer 3", user_id: "u1" });
  });

  it("totals usage by person and filters traces to one person", async () => {
    const people = await get("/people");
    expect(people.status).toBe(200);
    expect(people.json.map((p: any) => [p.user_id, p.traces, p.sessions, p.total_tokens, p.errors, p.active_days, p.apps])).toEqual([
      ["user-7", 1, 1, 908, 1, 1, ["support-bot-prod"]],
      ["u1", 6, 2, 60, 1, 1, ["paging-app"]],
    ]);
    expect(people.json[1].last_active_ms).toBe(BASE + 10_000 + 5 * 1000 + 300);
    const app = (await get("/apps")).json.find((x: any) => x.name === "paging-app").id;
    expect((await get(`/people?app=${app}`)).json.map((p: any) => p.user_id)).toEqual(["u1"]);
    expect((await get("/people?from=2026-11-21")).json).toEqual([]);
    const mine = await get("/traces?user=u1&limit=200");
    expect(mine.json.items).toHaveLength(6);
    expect(mine.json.totals).toMatchObject({ traces: 6, total_tokens: 60 });
    expect((await get("/traces?user=nobody")).json.items).toEqual([]);
    // Another workspace sees only its own people.
    expect((await get("/people", "trace-b")).json.map((p: any) => p.user_id)).toEqual(["user-7"]);
    expect((await get("/traces?user=u1", "trace-b")).json.items).toEqual([]);
  });

  it("never returns another workspace's traces or spans", async () => {
    // Workspace B holds only the fixture trace; A's other traces are invisible to it by id and by listing.
    expect((await get("/traces?limit=200", "trace-b")).json.items.map((t: any) => t.trace_id)).toEqual([TRACE]);
    expect((await get(`/traces/${hex(0xe000, 32)}`, "trace-b")).status).toBe(404);
    expect((await get(`/traces/${hex(0xe000, 32)}/spans/${hex(1, 16)}`, "trace-b")).status).toBe(404);
    const appA = (await get("/apps")).json.find((x: any) => x.name === "paging-app").id;
    expect((await get(`/traces?app=${appA}`, "trace-b")).json.items).toEqual([]);
    expect((await call("DELETE", `/api/tracing/apps/${appA}`, undefined, "trace-b")).status).toBe(404);
    expect((await get("/apps")).json.find((x: any) => x.name === "paging-app").trace_count).toBe(25);
  });

  it("says where to send traces", async () => {
    const s = await get("/setup");
    expect(s.json).toMatchObject({ endpoint: "https://geo.test/ingest/otlp", traces_url: "https://geo.test/ingest/otlp/v1/traces", key_header: "x-ingest-key" });
  });

  it("lets an owner delete an app with its traces and spans", async () => {
    const appA = (await get("/apps")).json.find((x: any) => x.name === "paging-app").id;
    const before = await spanCount(tenantA);
    expect((await call("DELETE", `/api/tracing/apps/${appA}`, undefined, "trace-a")).status).toBe(200);
    expect(await spanCount(tenantA)).toBe(before - 25);
    expect((await get("/apps")).json.some((x: any) => x.name === "paging-app")).toBe(false);
    expect((await get(`/traces/${hex(0xe000, 32)}`)).status).toBe(404);
    expect(await spanCount(tenantB)).toBe(3);
  });
});
