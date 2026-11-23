import { env as rawEnv, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { fitAttributes, LIMITS } from "../src/tracing/store";
import { TenantDB } from "../src/lib/db";
import { pruneTenant, pruneTraces, retentionDays } from "../src/tracing/retention";
import { generateDailyReports, generateTenantReports, observe, toolKind, type PersonSummary } from "../src/tracing/people";
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

  it("exports traces as a CSV summary and as full JSON Lines", async () => {
    const raw = async (path: string, tenant = "trace-a") => {
      const res = await SELF.fetch(`https://geo.test/api/tracing${path}`, { headers: { "x-tenant": tenant } });
      return { status: res.status, type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition"), truncated: res.headers.get("x-export-truncated"), text: await res.text() };
    };
    const app = (await get("/apps")).json.find((x: any) => x.name === "paging-app").id;
    const csv = await raw(`/export/traces.csv?app=${app}`);
    expect(csv.status).toBe(200);
    expect(csv.type).toContain("text/csv");
    expect(csv.disposition).toMatch(/^attachment; filename="traces-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(csv.truncated).toBe("false");
    const lines = csv.text.trim().split("\n");
    expect(lines[0]).toBe("started_at,app,name,kind,status,user,session,latency_ms,spans,model_calls,errors,prompt_tokens,completion_tokens,total_tokens,cost_usd,model,trace_id,input,output");
    expect(lines).toHaveLength(26);
    expect(lines[1]).toBe(`2026-11-20T12:00:34.000Z,paging-app,chat_turn,LLM,OK,,,300,1,1,0,0,0,10,,sonar,${hex(0xe000 + 24, 32)},question 24 about 50%_off,answer 24`);
    expect(lines.filter((l) => l.includes(",ERROR,"))).toHaveLength(1);
    // The same filters as the list apply.
    expect((await raw(`/export/traces.csv?app=${app}&status=error`)).text.trim().split("\n")).toHaveLength(2);
    expect((await raw(`/export/traces.csv?user=u1`)).text.trim().split("\n")).toHaveLength(7);
    expect((await raw("/export/traces.csv?status=nope")).status).toBe(400);

    const jsonl = await raw(`/export/traces.jsonl?q=${TRACE}`);
    expect(jsonl.status).toBe(200);
    expect(jsonl.type).toContain("application/x-ndjson");
    const rows = jsonl.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trace_id: TRACE, app: "support-bot-prod", name: "answer_question", started_at: "2025-11-23T12:13:20.000Z", span_count: 3, total_tokens: 908 });
    expect(rows[0].spans.map((s: any) => s.name)).toEqual(["answer_question", "ChatCompletion", "search_docs"]);
    expect(rows[0].spans[1]).toMatchObject({ kind: "LLM", model: "gpt-5-mini", truncated: false, attributes: { "llm.model_name": "gpt-5-mini", "llm.token_count.prompt": 812 }, events: [{ name: "first_token" }] });
    expect(rows[0].spans[2]).toMatchObject({ status_code: "ERROR", status_message: "index timeout" });
    // More than one page of traces streams through complete, each with its spans.
    const all = (await raw(`/export/traces.jsonl?app=${app}`)).text.trim().split("\n").map((l) => JSON.parse(l));
    expect(all).toHaveLength(25);
    expect(new Set(all.map((r: any) => r.trace_id)).size).toBe(25);
    expect(all.every((r: any) => r.spans.length === 1 && r.spans[0].attributes["input.value"].startsWith("question "))).toBe(true);

    const people = await raw("/export/people.csv");
    expect(people.text.trim().split("\n").slice(0, 2)).toEqual(["person,tools,sessions,turns,active_days,prompt_tokens,completion_tokens,total_tokens,cost_usd,errors,last_active_at", "user-7,support-bot-prod,1,1,1,812,96,908,0.001234,1,2025-11-23T12:13:22.500Z"]);

    // Another workspace exports only its own.
    expect((await raw("/export/traces.csv", "trace-b")).text.trim().split("\n")).toHaveLength(2);
    expect((await raw(`/export/traces.jsonl?app=${app}`, "trace-b")).text).toBe("");
    expect((await raw("/export/people.csv", "trace-b")).text.trim().split("\n")).toHaveLength(2);
  });

  it("deletes traces older than a quarter and nothing else", async () => {
    expect(retentionDays({})).toBe(92);
    expect(retentionDays({ TRACE_RETENTION_DAYS: "30" })).toBe(30);
    expect(retentionDays({ TRACE_RETENTION_DAYS: "soon" })).toBe(92);
    const DAY = 86_400_000;
    const old = (trace: number, daysAgo: number): SpanSpec[] => [
      { trace, span: 1, name: "old_run", start: -daysAgo * DAY, dur: 500, attrs: { "openinference.span.kind": "CHAIN", "user.id": "old-timer" } },
      { trace, span: 2, parent: 1, name: "old_llm", start: -daysAgo * DAY + 10, dur: 100, attrs: { "openinference.span.kind": "LLM", "llm.token_count.total": 5 } },
    ];
    expect((await sendJson(keyA, otlpJson([...old(0xf001, 93), ...old(0xf002, 200), ...old(0xf003, 91)], { "service.name": "aging-app" }))).status).toBe(200);
    expect((await sendJson(keyB, otlpJson(old(0xf004, 150), { "service.name": "aging-app" }))).status).toBe(200);
    const now = BASE; // "today" for this test is the day the paging traces were sent
    const status = (await get("/retention")).json;
    expect(status).toMatchObject({ days: 92 });
    expect(status.oldest_ms).toBe(1763900000000); // the fixture trace, from a year earlier
    expect(status.traces).toBeGreaterThan(30);

    const before = { a: await spanCount(tenantA), b: await spanCount(tenantB) };
    // One workspace at a time: B's expired trace is untouched when A is pruned.
    // In A: the 93 and 200 day old traces, and the fixture trace, which is a year old.
    expect(await pruneTenant(new TenantDB(env.DB, tenantA), now - 92 * DAY)).toBe(3);
    expect(await spanCount(tenantA)).toBe(before.a - 4 - 3);
    expect(await spanCount(tenantB)).toBe(before.b);
    expect((await get(`/traces/${hex(0xf001, 32)}`)).status).toBe(404);
    expect((await get(`/traces/${hex(0xf002, 32)}`)).status).toBe(404);
    expect((await get(`/traces/${TRACE}`)).status).toBe(404);
    expect((await get(`/traces/${hex(0xf003, 32)}`)).json.spans).toHaveLength(2);
    expect((await get(`/traces/${hex(0xe000, 32)}`)).status).toBe(200);
    expect(await pruneTenant(new TenantDB(env.DB, tenantA), now - 92 * DAY)).toBe(0);

    // The scheduled job covers every workspace: B still holds its fixture trace and a 150 day old one.
    expect(await pruneTraces(env, new Date(now))).toBe(2);
    expect(await spanCount(tenantB)).toBe(0);
    expect(await spanCount(tenantA)).toBe(before.a - 7);
    expect((await get(`/traces/${hex(0xf003, 32)}`)).status).toBe(200);
    expect((await get("/apps")).json.find((x: any) => x.name === "paging-app").trace_count).toBe(25);
  });

  it("breaks one person's usage down by tool, skill, plugin, subagent, program and model", async () => {
    const DAY = 86_400_000;
    const who = { "user.id": "dev@acme.test", "harness.name": "claude-code" };
    const tool = (trace: number, span: number, name: string, start: number, attrs: Record<string, string | number> = {}, error?: string): SpanSpec => ({ trace, span, parent: 1, name, start, dur: 200, attrs: { "openinference.span.kind": "TOOL", "tool.name": name, ...who, ...attrs }, ...(error ? { error } : {}) });
    const specs: SpanSpec[] = [
      // Today, turn 1: a review with a skill, a plugin's MCP tool, a subagent and five shell calls (two failing).
      { trace: 0x9001, span: 1, name: "turn", start: 3_600_000, dur: 60_000, attrs: { "openinference.span.kind": "AGENT", "session.id": "claude-code:s1", "project.name": "shop", "slash.command": "review", "input.value": "/review the checkout", ...who } },
      { trace: 0x9001, span: 2, parent: 1, name: "model response", start: 3_600_100, dur: 900, attrs: { "openinference.span.kind": "LLM", "llm.model_name": "claude-opus-5-5", "llm.token_count.prompt": 300_000, "llm.token_count.completion": 100, "llm.token_count.total": 300_100, "llm.token_count.prompt_details.cache_read": 100_000, ...who } },
      tool(0x9001, 3, "Skill", 3_601_000, { "tool.kind": "skill", "skill.name": "stripe:test-cards", "plugin.name": "stripe" }),
      tool(0x9001, 4, "mcp__plugin_browser-use_browser-use__browser_exec", 3_602_000, { "tool.kind": "mcp", "mcp.server": "browser-use", "plugin.name": "browser-use" }),
      tool(0x9001, 5, "Agent", 3_603_000, { "tool.kind": "subagent", "subagent.type": "Explore" }),
      tool(0x9001, 6, "Read", 3_604_000),
      tool(0x9001, 7, "Bash", 3_605_000, { "command.program": "git" }),
      tool(0x9001, 8, "Bash", 3_606_000, { "command.program": "git" }, "The tool call failed."),
      tool(0x9001, 9, "Bash", 3_607_000, { "command.program": "npm" }, "The tool call failed."),
      tool(0x9001, 10, "Bash", 3_608_000, { "command.program": "git" }),
      tool(0x9001, 11, "Bash", 3_609_000, { "command.program": "git" }),
      // Today, turns 2 and 3: cut short.
      { trace: 0x9002, span: 1, name: "turn", start: 4_000_000, dur: 5000, attrs: { "openinference.span.kind": "AGENT", "session.id": "claude-code:s1", "project.name": "shop", "turn.incomplete": 1, ...who } },
      { trace: 0x9003, span: 1, name: "turn", start: 5_000_000, dur: 5000, attrs: { "openinference.span.kind": "AGENT", "session.id": "claude-code:s2", "project.name": "docs", "turn.incomplete": 1, ...who } },
    ];
    // Two days earlier: ten plain turns, the person's "usual".
    for (let i = 0; i < 10; i++) specs.push({ trace: 0x9100 + i, span: 1, name: "turn", start: -2 * DAY + i * 60_000, dur: 1000, attrs: { "openinference.span.kind": "AGENT", "session.id": "claude-code:s0", ...who } });
    expect((await sendJson(keyA, otlpJson(specs, { "service.name": "claude-code" }))).status).toBe(200);

    const user = encodeURIComponent("dev@acme.test");
    const s = await get<PersonSummary>(`/people/${user}?from=2026-11-20&to=2026-11-20`);
    expect(s.status).toBe(200);
    expect(s.json.totals).toMatchObject({
      turns: 3, sessions: 2, active_days: 1, failed_turns: 1, unfinished_turns: 2, model_calls: 1, prompt_tokens: 300_000, completion_tokens: 100, total_tokens: 300_100,
      cache_read_tokens: 100_000, largest_prompt_tokens: 300_000, max_model_calls_in_turn: 1, tool_calls: 9, tool_failures: 2, longest_turn_ms: 60_000,
    });
    expect(s.json.days).toEqual([{ day: "2026-11-20", turns: 3, tokens: 300_100, tool_calls: 9 }]);
    expect(s.json.tools.map((x) => [x.name, x.kind, x.calls, x.failures, x.avg_ms])).toEqual([
      ["Bash", "shell", 5, 2, 200], ["Agent", "subagent", 1, 0, 200], ["mcp__plugin_browser-use_browser-use__browser_exec", "mcp", 1, 0, 200], ["Read", "builtin", 1, 0, 200], ["Skill", "skill", 1, 0, 200],
    ]);
    expect(s.json.skills).toEqual([{ name: "stripe:test-cards", calls: 1, failures: 0 }]);
    expect(s.json.plugins.map((x) => [x.name, x.calls])).toEqual([["browser-use", 1], ["stripe", 1]]);
    expect(s.json.mcp_servers.map((x) => [x.name, x.calls])).toEqual([["browser-use", 1]]);
    expect(s.json.subagents.map((x) => [x.name, x.calls])).toEqual([["Explore", 1]]);
    expect(s.json.programs.map((x) => [x.name, x.calls, x.failures])).toEqual([["git", 4, 1], ["npm", 1, 1]]);
    expect(s.json.commands.map((x) => [x.name, x.calls])).toEqual([["review", 1]]);
    expect(s.json.models).toEqual([{ name: "claude-opus-5-5", calls: 1, tokens: 300_100 }]);
    expect(s.json.projects.map((x) => [x.name, x.calls])).toEqual([["shop", 2], ["docs", 1]]);
    expect(s.json.apps).toEqual([{ name: "claude-code", calls: 3, tokens: 300_100 }]);
    expect(s.json.sessions.map((x) => [x.session_id, x.turns])).toEqual([["claude-code:s2", 1], ["claude-code:s1", 2]]);
    // A wider range brings in the earlier day; another workspace sees nobody by that name.
    expect((await get<PersonSummary>(`/people/${user}?from=2026-11-10&to=2026-11-20`)).json.totals).toMatchObject({ turns: 13, active_days: 2 });
    expect((await get(`/people/${user}?from=2026-11-20&to=2026-11-20`, "trace-b")).status).toBe(404);
    expect((await get("/people/nobody?from=2026-11-20&to=2026-11-20")).status).toBe(404);
    expect(toolKind("mcp__claude_ai_Slack__slack_send_message")).toEqual({ kind: "mcp", server: "claude_ai_Slack" });
  });

  it("writes a daily report per person with observations drawn from the numbers", async () => {
    const user = encodeURIComponent("dev@acme.test");
    // Not written yet: built on the spot for the day asked.
    const live = await get(`/people/${user}/reports/2026-11-20`);
    expect(live.status).toBe(200);
    expect(live.json).toMatchObject({ user_id: "dev@acme.test", day: "2026-11-20", stored: false, usual: { active_days: 1, turns_per_day: 10 } });
    expect(live.json.observations.map((o: any) => [o.level, o.title])).toEqual([
      ["watch", "Bash failed 2 of 5 times"],
      ["watch", "2 turns of 3 were cut short"],
      ["watch", "One model call carried 300,000 tokens of context"],
      ["tip", "33% of input was reused from cache"],
      ["tip", "Quieter than usual: 3 turns against about 10 a day"],
      ["good", "Used 1 skill"],
      ["good", "Delegated to 1 subagent"],
    ]);
    expect(live.json.top_tools[0]).toMatchObject({ name: "Bash", calls: 5, failures: 2 });
    expect((await get(`/people/${user}/reports`)).json).toEqual([]);
    expect((await get(`/people/${user}/reports/2026-11-19`)).status).toBe(404);
    expect((await get(`/people/${user}/reports/not-a-day`)).status).toBe(404);

    // The scheduled job, run on the 21st, writes the 20th for everyone active that day in every workspace.
    const written = await generateDailyReports(env, new Date(Date.UTC(2026, 10, 21, 1, 0, 0)));
    expect(written).toBeGreaterThanOrEqual(2); // dev@acme.test and u1 (the paging traces) at least
    const stored = await get(`/people/${user}/reports`);
    expect(stored.json.map((r: any) => r.day)).toEqual(["2026-11-20"]);
    expect(stored.json[0].observations).toHaveLength(7);
    expect((await get(`/people/${user}/reports/2026-11-20`)).json.stored).toBe(true);
    // Running it again rewrites the same row; an earlier day can be written on request.
    const rowsFor20th = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM trace_reports WHERE tenant_id = ?1 AND day = '2026-11-20'").bind(tenantA).first<{ n: number }>())!.n;
    const before = await rowsFor20th();
    expect(await generateTenantReports(new TenantDB(env.DB, tenantA), "2026-11-20")).toBe(before);
    expect(await rowsFor20th()).toBe(before);
    expect(await generateTenantReports(new TenantDB(env.DB, tenantA), "2026-11-18")).toBe(1);
    expect((await get(`/people/${user}/reports`)).json.map((r: any) => [r.day, r.totals.turns, r.observations.length])).toEqual([["2026-11-20", 3, 7], ["2026-11-18", 10, 1]]);
    expect((await get(`/people/${user}/reports`, "trace-b")).json).toEqual([]);

    // A quiet, clean day earns no warnings.
    const clean = { totals: { turns: 4, tool_calls: 12, tool_failures: 0, unfinished_turns: 0, largest_prompt_tokens: 20_000, max_model_calls_in_turn: 5, prompt_tokens: 300_000, cache_read_tokens: 280_000 }, tools: [{ name: "Read", kind: "builtin", calls: 12, failures: 0 }], skills: [], subagents: [], programs: [] } as unknown as PersonSummary;
    const none = { totals: { turns: 0, active_days: 0 } } as unknown as PersonSummary;
    expect(observe(clean, none).map((o) => [o.level, o.title])).toEqual([["good", "12 tool calls and none failed"], ["good", "93% of input was reused from cache"]]);
    expect(observe(none, none)).toEqual([]);
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
    expect(await spanCount(tenantB)).toBe(0);
  });
});
