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
