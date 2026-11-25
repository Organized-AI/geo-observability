/**
 * Writing decoded spans for one workspace.
 *
 * A span is stored once. Sending it again changes nothing, unless the new copy ends later: a span sent while its
 * work was still running (a turn imported mid-way) is then replaced by the finished one. Every trace touched by the
 * request has its summary row recomputed from the spans now stored. Because the summary is always derived from stored spans, the order
 * spans arrive in and how often they are resent cannot change the totals.
 */
import { applyPolicy, getCapture } from "./policy";
import type { Env } from "../env";
import { TenantDB } from "../lib/db";
import { chunk, newId, nowIso } from "../lib/util";
import type { Attrs, AttrValue, OtlpSpan } from "./otlp";
import { spanFacts } from "./openinference";

export const LIMITS = {
  spansPerRequest: 2000,
  appsPerTenant: 50,
  nameChars: 300,
  textChars: 16_000, // input_text and output_text columns
  attrValueChars: 32_000, // any one string attribute
  attrJsonChars: 200_000, // the whole attributes blob for a span
  eventsPerSpan: 50,
  previewChars: 400,
};

export const DEFAULT_APP = "default";
const CUT = " …[cut]";
const TOO_LARGE = "[removed: too large to store]";

export interface IngestResult {
  accepted: number;
  rejected: number;
  reason: string;
  traces: number;
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const cut = (s: string | null, max: number): string | null => (s === null ? null : s.length > max ? s.slice(0, max - CUT.length) + CUT : s);

/** App name for a span: the request header wins, then the resource's project name, then its service name. */
export function appNameFor(span: OtlpSpan, headerName: string | null): string {
  const pick = (v: AttrValue | undefined) => (typeof v === "string" ? clean(v, 120) : "");
  return clean(headerName ?? "", 120) || pick(span.resource["openinference.project.name"]) || pick(span.resource["service.name"]) || DEFAULT_APP;
}

/** Fits attributes into the per-span budget: long strings are cut, then the largest values are dropped. */
export function fitAttributes(attrs: Attrs): { json: string; truncated: boolean } {
  let truncated = false;
  const out: Attrs = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "string" && v.length > LIMITS.attrValueChars) {
      out[k] = cut(v, LIMITS.attrValueChars);
      truncated = true;
    } else out[k] = v;
  }
  let json = JSON.stringify(out);
  if (json.length <= LIMITS.attrJsonChars) return { json, truncated };
  const bySize = Object.keys(out)
    .map((k) => ({ k, size: JSON.stringify(out[k]).length }))
    .sort((a, b) => b.size - a.size);
  let size = json.length;
  for (const { k, size: s } of bySize) {
    if (size <= LIMITS.attrJsonChars) break;
    out[k] = TOO_LARGE;
    size -= s - TOO_LARGE.length - 2;
  }
  json = JSON.stringify(out);
  return { json, truncated: true };
}

const INSERT_SPAN = `INSERT INTO llm_spans
  (tenant_id, app_id, trace_id, span_id, parent_span_id, name, kind, status_code, status_message, start_ms, end_ms,
   model, provider, prompt_tokens, completion_tokens, total_tokens, cost_micros, session_id, user_id,
   input_text, output_text, attributes, events, truncated)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)
  ON CONFLICT (tenant_id, trace_id, span_id) DO UPDATE SET
    parent_span_id = excluded.parent_span_id, name = excluded.name, kind = excluded.kind, status_code = excluded.status_code,
    status_message = excluded.status_message, start_ms = excluded.start_ms, end_ms = excluded.end_ms, model = excluded.model, provider = excluded.provider,
    prompt_tokens = excluded.prompt_tokens, completion_tokens = excluded.completion_tokens, total_tokens = excluded.total_tokens, cost_micros = excluded.cost_micros,
    session_id = excluded.session_id, user_id = excluded.user_id, input_text = excluded.input_text, output_text = excluded.output_text,
    attributes = excluded.attributes, events = excluded.events, truncated = excluded.truncated
  WHERE excluded.end_ms > llm_spans.end_ms`;

/**
 * Token and cost totals count model-calling spans only, so a parent span that repeats its children's usage
 * is not counted twice.
 */
const SUMMARISE = `WITH s AS (SELECT * FROM llm_spans WHERE tenant_id = ?1 AND trace_id = ?2),
  root AS (SELECT * FROM s ORDER BY (parent_span_id IS NOT NULL), start_ms, span_id LIMIT 1),
  agg AS (SELECT MIN(start_ms) AS start_ms, MAX(end_ms) AS end_ms, COUNT(*) AS span_count,
            SUM(status_code = 'ERROR') AS error_count, SUM(kind = 'LLM') AS llm_count,
            COALESCE(SUM(CASE WHEN kind IN ('LLM','EMBEDDING','DECISION') THEN prompt_tokens END), 0) AS prompt_tokens,
            COALESCE(SUM(CASE WHEN kind IN ('LLM','EMBEDDING','DECISION') THEN completion_tokens END), 0) AS completion_tokens,
            COALESCE(SUM(CASE WHEN kind IN ('LLM','EMBEDDING','DECISION') THEN total_tokens END), 0) AS total_tokens,
            COALESCE(SUM(CASE WHEN kind IN ('LLM','EMBEDDING','DECISION') THEN cost_micros END), 0) AS cost_micros
          FROM s)
  INSERT INTO llm_traces
    (tenant_id, app_id, trace_id, session_id, user_id, root_span_id, name, kind, status, start_ms, end_ms,
     span_count, error_count, llm_count, prompt_tokens, completion_tokens, total_tokens, cost_micros,
     model, input_preview, output_preview, updated_at)
  SELECT ?1, root.app_id, ?2,
    (SELECT session_id FROM s WHERE session_id IS NOT NULL ORDER BY start_ms, span_id LIMIT 1),
    (SELECT user_id FROM s WHERE user_id IS NOT NULL ORDER BY start_ms, span_id LIMIT 1),
    root.span_id, root.name, root.kind,
    CASE WHEN agg.error_count > 0 THEN 'ERROR' ELSE root.status_code END,
    agg.start_ms, agg.end_ms, agg.span_count, agg.error_count, agg.llm_count,
    agg.prompt_tokens, agg.completion_tokens, agg.total_tokens, agg.cost_micros,
    (SELECT model FROM s WHERE model IS NOT NULL ORDER BY start_ms, span_id LIMIT 1),
    substr(COALESCE(root.input_text, (SELECT input_text FROM s WHERE input_text IS NOT NULL ORDER BY start_ms, span_id LIMIT 1)), 1, ${LIMITS.previewChars}),
    substr(COALESCE(root.output_text, (SELECT output_text FROM s WHERE output_text IS NOT NULL ORDER BY end_ms DESC, span_id LIMIT 1)), 1, ${LIMITS.previewChars}),
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM agg, root WHERE true
  ON CONFLICT (tenant_id, trace_id) DO UPDATE SET
    app_id = excluded.app_id, session_id = excluded.session_id, user_id = excluded.user_id, root_span_id = excluded.root_span_id,
    name = excluded.name, kind = excluded.kind, status = excluded.status, start_ms = excluded.start_ms, end_ms = excluded.end_ms,
    span_count = excluded.span_count, error_count = excluded.error_count, llm_count = excluded.llm_count,
    prompt_tokens = excluded.prompt_tokens, completion_tokens = excluded.completion_tokens, total_tokens = excluded.total_tokens,
    cost_micros = excluded.cost_micros, model = excluded.model, input_preview = excluded.input_preview,
    output_preview = excluded.output_preview, updated_at = excluded.updated_at`;

/** Resolves app names to ids, creating missing ones up to the per-workspace limit; the rest go to the default app. */
async function resolveApps(tdb: TenantDB, names: Set<string>): Promise<Map<string, string>> {
  const load = async () => new Map((await tdb.all<{ id: string; name: string }>("SELECT id, name FROM trace_apps WHERE tenant_id = ?1")).map((r) => [r.name, r.id]));
  let known = await load();
  const missing = [...names].filter((n) => !known.has(n));
  if (missing.length) {
    let room = Math.max(0, LIMITS.appsPerTenant - known.size);
    const create: string[] = [];
    for (const n of missing) {
      if (n === DEFAULT_APP || room > 0) {
        create.push(n);
        if (n !== DEFAULT_APP) room--;
      }
    }
    if (create.length < missing.length && !known.has(DEFAULT_APP) && !create.includes(DEFAULT_APP)) create.push(DEFAULT_APP);
    await tdb.batch(create.map((n) => tdb.prepare("INSERT OR IGNORE INTO trace_apps (id, tenant_id, name) VALUES (?2, ?1, ?3)", newId("app"), n)));
    known = await load();
  }
  const out = new Map<string, string>();
  for (const n of names) out.set(n, known.get(n) ?? (known.get(DEFAULT_APP) as string));
  return out;
}

/** `person` comes from a personal key and replaces any user.id the sender claims. */
export async function ingestSpans(env: Env, tenantId: string, spans: OtlpSpan[], headerApp: string | null, person: string | null = null): Promise<IngestResult> {
  const tdb = new TenantDB(env.DB, tenantId);
  const now = Date.now();
  let rejected = 0;
  const reasons = new Set<string>();
  const good: OtlpSpan[] = [];
  for (const s of spans) {
    if (!HEX32.test(s.traceId) || !HEX16.test(s.spanId) || /^0+$/.test(s.traceId) || /^0+$/.test(s.spanId)) {
      rejected++;
      reasons.add("spans without a valid trace id and span id were skipped");
    } else if (good.length >= LIMITS.spansPerRequest) {
      rejected++;
      reasons.add(`only the first ${LIMITS.spansPerRequest} spans of a request are stored`);
    } else good.push(s);
  }
  if (!good.length) return { accepted: 0, rejected, reason: [...reasons].join("; "), traces: 0 };
  const capture = await getCapture(tdb);
  for (let i = 0; i < good.length; i++) good[i] = applyPolicy(good[i] as OtlpSpan, capture);

  const appIds = await resolveApps(tdb, new Set(good.map((s) => appNameFor(s, headerApp))));
  const stmts: D1PreparedStatement[] = [];
  const traceIds = new Set<string>();
  for (const s of good) {
    const facts = spanFacts(s.attributes);
    const attrs = fitAttributes(s.attributes);
    const startMs = s.startMs > 0 ? s.startMs : now;
    const endMs = Math.max(startMs, s.endMs);
    const input = cut(facts.input, LIMITS.textChars);
    const output = cut(facts.output, LIMITS.textChars);
    const events = s.events.slice(0, LIMITS.eventsPerSpan).map((e) => ({ name: clean(e.name, 200), time_ms: e.time_ms, attributes: JSON.parse(fitAttributes(e.attributes).json) as Attrs }));
    let eventsJson = JSON.stringify(events);
    let truncated = attrs.truncated || input !== facts.input || output !== facts.output || s.events.length > events.length;
    if (eventsJson.length > LIMITS.attrJsonChars) {
      eventsJson = JSON.stringify(events.map((e) => ({ name: e.name, time_ms: e.time_ms, attributes: {} })));
      truncated = true;
    }
    traceIds.add(s.traceId);
    stmts.push(
      tdb.prepare(
        INSERT_SPAN,
        appIds.get(appNameFor(s, headerApp)) as string,
        s.traceId,
        s.spanId,
        s.parentSpanId && HEX16.test(s.parentSpanId) && !/^0+$/.test(s.parentSpanId) ? s.parentSpanId : null,
        clean(s.name, LIMITS.nameChars) || "(unnamed)",
        facts.kind,
        s.statusCode,
        cut(s.statusMessage, 2000),
        startMs,
        endMs,
        cut(facts.model, 200),
        cut(facts.provider, 100),
        facts.promptTokens,
        facts.completionTokens,
        facts.totalTokens,
        facts.costMicros,
        cut(facts.sessionId, 200),
        person ?? cut(facts.userId, 200),
        input,
        output,
        attrs.json,
        eventsJson,
        truncated ? 1 : 0,
      ),
    );
  }
  // An app whose spans say which coding tool sent them is a coding tool; its people are counted as people.
  const coding = new Set(good.filter((s) => typeof s.attributes["harness.name"] === "string").map((s) => appIds.get(appNameFor(s, headerApp)) as string));
  if (coding.size) stmts.push(...[...coding].map((id) => tdb.prepare("UPDATE trace_apps SET kind = 'coding_tool' WHERE tenant_id = ?1 AND id = ?2 AND kind <> 'coding_tool'", id)));
  for (const part of chunk(stmts, 40)) await tdb.batch(part);
  for (const part of chunk([...traceIds], 40)) await tdb.batch(part.map((id) => tdb.prepare(SUMMARISE, id)));
  const seen = nowIso();
  await tdb.batch([...new Set(appIds.values())].map((id) => tdb.prepare("UPDATE trace_apps SET last_seen_at = ?3 WHERE tenant_id = ?1 AND id = ?2", id, seen)));
  return { accepted: good.length, rejected, reason: [...reasons].join("; "), traces: traceIds.size };
}
