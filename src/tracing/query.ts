/** Reading stored traces for the portal. Every query is scoped to one workspace through TenantDB. */
import type { TenantDB } from "../lib/db";
import { Binds } from "../metrics/filters";
import { HttpError, parseJson } from "../lib/util";
import type { Attrs } from "./otlp";
import { documents, messages, tools } from "./openinference";
import { deleteBodies, readBody } from "./body";
import type { Env } from "../env";

export interface TraceFilters {
  appId?: string;
  fromMs?: number;
  toMs?: number;
  status?: "error" | "ok";
  q?: string;
  sessionId?: string;
  userId?: string;
  model?: string;
  minMs?: number;
  limit: number;
  cursor?: string;
  /** When set, coding-tool traces are limited to this person's own (app traces stay visible). Owners leave it unset. */
  viewer?: string;
}

/** Coding-tool content is private to its person; other apps' traces are shared with the workspace. */
function ownOnly(viewer: string, b: Binds, alias = "t"): string {
  return `(${alias}.user_id = ${b.add(viewer)} OR ${alias}.app_id NOT IN (SELECT id FROM trace_apps WHERE tenant_id = ?1 AND kind = 'coding_tool'))`;
}

export const MAX_SPANS_PER_TRACE_VIEW = 2000;

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function listApps(tdb: TenantDB) {
  return tdb.all(
    `SELECT a.id, a.name, a.kind, a.created_at, a.last_seen_at,
            (SELECT COUNT(*) FROM llm_traces t WHERE t.tenant_id = ?1 AND t.app_id = a.id) AS trace_count
     FROM trace_apps a WHERE a.tenant_id = ?1 ORDER BY a.last_seen_at DESC, a.name`,
  );
}

function whereFor(f: TraceFilters, b: Binds): string[] {
  const where = ["t.tenant_id = ?1"];
  if (f.appId) where.push(`t.app_id = ${b.add(f.appId)}`);
  if (f.fromMs !== undefined) where.push(`t.start_ms >= ${b.add(f.fromMs)}`);
  if (f.toMs !== undefined) where.push(`t.start_ms <= ${b.add(f.toMs)}`);
  if (f.status === "error") where.push("t.status = 'ERROR'");
  if (f.status === "ok") where.push("t.status <> 'ERROR'");
  if (f.sessionId) where.push(`t.session_id = ${b.add(f.sessionId)}`);
  if (f.userId) where.push(`t.user_id = ${b.add(f.userId)}`);
  if (f.model) where.push(`t.model = ${b.add(f.model)}`);
  if (f.minMs !== undefined) where.push(`(t.end_ms - t.start_ms) >= ${b.add(f.minMs)}`);
  if (f.viewer) where.push(ownOnly(f.viewer, b));
  if (f.q) {
    const p = b.add(like(f.q));
    where.push(`(t.name LIKE ${p} ESCAPE '\\' OR t.input_preview LIKE ${p} ESCAPE '\\' OR t.output_preview LIKE ${p} ESCAPE '\\' OR t.trace_id = ${b.add(f.q.toLowerCase())})`);
  }
  return where;
}

const TRACE_COLUMNS = `t.trace_id, t.app_id, a.name AS app, t.session_id, t.user_id, t.root_span_id, t.name, t.kind, t.status, t.start_ms, t.end_ms,
  (t.end_ms - t.start_ms) AS latency_ms, t.span_count, t.error_count, t.llm_count, t.prompt_tokens, t.completion_tokens, t.total_tokens,
  t.cost_micros, t.model, t.input_preview, t.output_preview`;

/** Newest first, with keyset paging on (start_ms, trace_id) so new arrivals never shift a page. */
export async function listTraces(tdb: TenantDB, f: TraceFilters) {
  const b = new Binds();
  const where = whereFor(f, b);
  if (f.cursor) {
    const m = /^(\d{1,16})\.([0-9a-f]{32})$/.exec(f.cursor);
    if (!m) throw new HttpError(400, "bad_cursor", "That cursor is not valid. Start again from the first page.");
    const ms = b.add(Number(m[1]));
    where.push(`(t.start_ms < ${ms} OR (t.start_ms = ${ms} AND t.trace_id < ${b.add(m[2] as string)}))`);
  }
  const rows = await tdb.all<{ trace_id: string; start_ms: number }>(
    `SELECT ${TRACE_COLUMNS} FROM llm_traces t JOIN trace_apps a ON a.id = t.app_id
     WHERE ${where.join(" AND ")} ORDER BY t.start_ms DESC, t.trace_id DESC LIMIT ${f.limit + 1}`,
    ...b.values,
  );
  const items = rows.slice(0, f.limit);
  const last = items[items.length - 1];
  return { items, next_cursor: rows.length > f.limit && last ? `${last.start_ms}.${last.trace_id}` : null };
}

/** Headline numbers for the same filters as the list (without paging). */
export async function traceTotals(tdb: TenantDB, f: TraceFilters) {
  const b = new Binds();
  const where = whereFor(f, b);
  return tdb.first(
    `SELECT COUNT(*) AS traces, COALESCE(SUM(t.status = 'ERROR'), 0) AS errors, COALESCE(SUM(t.total_tokens), 0) AS total_tokens,
            COALESCE(SUM(t.cost_micros), 0) AS cost_micros, COALESCE(ROUND(AVG(t.end_ms - t.start_ms)), 0) AS avg_latency_ms
     FROM llm_traces t WHERE ${where.join(" AND ")}`,
    ...b.values,
  );
}

const SPAN_LIST_COLUMNS = `span_id, parent_span_id, name, kind, status_code, start_ms, end_ms, model, total_tokens, cost_micros`;

/** One trace with a light row per span (enough for the tree and timeline); span bodies load on demand. */
export async function getTrace(tdb: TenantDB, traceId: string, viewer?: string) {
  const b = new Binds();
  const id = b.add(traceId);
  const own = viewer ? ` AND ${ownOnly(viewer, b)}` : "";
  const trace = await tdb.first(`SELECT ${TRACE_COLUMNS} FROM llm_traces t JOIN trace_apps a ON a.id = t.app_id WHERE t.tenant_id = ?1 AND t.trace_id = ${id}${own}`, ...b.values);
  if (!trace) throw new HttpError(404, "not_found", "Trace not found");
  const spans = await tdb.all(
    `SELECT ${SPAN_LIST_COLUMNS} FROM llm_spans WHERE tenant_id = ?1 AND trace_id = ?2 ORDER BY start_ms, span_id LIMIT ${MAX_SPANS_PER_TRACE_VIEW + 1}`,
    traceId,
  );
  return { trace, spans: spans.slice(0, MAX_SPANS_PER_TRACE_VIEW), spans_truncated: spans.length > MAX_SPANS_PER_TRACE_VIEW };
}

interface SpanRow {
  attributes: string;
  events: string;
  truncated: number;
  [k: string]: unknown;
}

export async function getSpan(tdb: TenantDB, traceId: string, spanId: string, viewer?: string, env?: Pick<Env, "ANSWERS">) {
  if (viewer) await getTrace(tdb, traceId, viewer); // 404 when the trace is someone else's
  const row = await tdb.first<SpanRow>(
    `SELECT span_id, parent_span_id, trace_id, name, kind, status_code, status_message, start_ms, end_ms, model, provider,
            prompt_tokens, completion_tokens, total_tokens, cost_micros, session_id, user_id, input_text, output_text,
            attributes, events, truncated, body_key
     FROM llm_spans WHERE tenant_id = ?1 AND trace_id = ?2 AND span_id = ?3`,
    traceId,
    spanId,
  );
  if (!row) throw new HttpError(404, "not_found", "Span not found");
  const body = env ? await readBody(env, row.body_key as string | null, tdb.tenantId) : null;
  const attributes = body ? body.attributes : parseJson<Attrs>(row.attributes, {});
  const { body_key: _key, ...rest } = row;
  return {
    ...rest,
    ...(body ? { input_text: body.input, output_text: body.output } : {}),
    truncated: row.truncated === 1,
    attributes,
    events: body ? body.events : parseJson<unknown[]>(row.events, []),
    input_messages: messages(attributes, "input"),
    output_messages: messages(attributes, "output"),
    tools: tools(attributes),
    documents: documents(attributes),
  };
}

/** Conversations: traces that share a session id, newest activity first. */
export function listSessions(tdb: TenantDB, f: Pick<TraceFilters, "appId" | "fromMs" | "toMs" | "limit" | "viewer">) {
  const b = new Binds();
  const where = ["t.tenant_id = ?1", "t.session_id IS NOT NULL"];
  if (f.appId) where.push(`t.app_id = ${b.add(f.appId)}`);
  if (f.fromMs !== undefined) where.push(`t.start_ms >= ${b.add(f.fromMs)}`);
  if (f.toMs !== undefined) where.push(`t.start_ms <= ${b.add(f.toMs)}`);
  if (f.viewer) where.push(ownOnly(f.viewer, b));
  // Previews come only from traces this viewer may read, even if a session id were shared.
  const fOwn = f.viewer ? ` AND ${ownOnly(f.viewer, b, "f")}` : "";
  const lOwn = f.viewer ? ` AND ${ownOnly(f.viewer, b, "l")}` : "";
  return tdb.all(
    `SELECT t.session_id, COUNT(*) AS traces, MIN(t.start_ms) AS start_ms, MAX(t.end_ms) AS end_ms,
            SUM(t.total_tokens) AS total_tokens, SUM(t.cost_micros) AS cost_micros, SUM(t.status = 'ERROR') AS errors,
            MAX(t.user_id) AS user_id,
            (SELECT f.input_preview FROM llm_traces f WHERE f.tenant_id = ?1 AND f.session_id = t.session_id${fOwn} ORDER BY f.start_ms, f.trace_id LIMIT 1) AS first_input,
            (SELECT l.output_preview FROM llm_traces l WHERE l.tenant_id = ?1 AND l.session_id = t.session_id${lOwn} ORDER BY l.start_ms DESC, l.trace_id DESC LIMIT 1) AS last_output
     FROM llm_traces t WHERE ${where.join(" AND ")}
     GROUP BY t.session_id ORDER BY MAX(t.start_ms) DESC, t.session_id LIMIT ${f.limit}`,
    ...b.values,
  );
}

/** Usage by person (the user.id on their traces), heaviest first. One trace is one turn for a coding tool. */
export function listPeople(tdb: TenantDB, f: Pick<TraceFilters, "appId" | "fromMs" | "toMs" | "limit">) {
  const b = new Binds();
  const where = ["t.tenant_id = ?1", "t.user_id IS NOT NULL"];
  // Without a chosen app, people are those using coding tools; an app's own end users show when that app is chosen.
  if (f.appId) where.push(`t.app_id = ${b.add(f.appId)}`);
  else where.push("a.kind = 'coding_tool'");
  if (f.fromMs !== undefined) where.push(`t.start_ms >= ${b.add(f.fromMs)}`);
  if (f.toMs !== undefined) where.push(`t.start_ms <= ${b.add(f.toMs)}`);
  return tdb.all(
    `SELECT t.user_id, COUNT(*) AS traces, COUNT(DISTINCT t.session_id) AS sessions,
            COUNT(DISTINCT strftime('%Y-%m-%d', t.start_ms / 1000, 'unixepoch')) AS active_days,
            SUM(t.prompt_tokens) AS prompt_tokens, SUM(t.completion_tokens) AS completion_tokens, SUM(t.total_tokens) AS total_tokens,
            SUM(t.cost_micros) AS cost_micros, SUM(t.status = 'ERROR') AS errors, MAX(t.end_ms) AS last_active_ms,
            GROUP_CONCAT(DISTINCT a.name) AS apps
     FROM llm_traces t JOIN trace_apps a ON a.id = t.app_id
     WHERE ${where.join(" AND ")}
     GROUP BY t.user_id ORDER BY SUM(t.total_tokens) DESC, COUNT(*) DESC, t.user_id LIMIT ${f.limit}`,
    ...b.values,
  );
}

/** Removes an app with its traces and spans. Returns false when the app is not in this workspace. */
export async function deleteApp(tdb: TenantDB, appId: string, env?: Pick<Env, "ANSWERS">): Promise<boolean> {
  const app = await tdb.first("SELECT id FROM trace_apps WHERE tenant_id = ?1 AND id = ?2", appId);
  if (!app) return false;
  if (env) {
    const ids = await tdb.all<{ trace_id: string }>("SELECT DISTINCT trace_id FROM llm_spans WHERE tenant_id = ?1 AND app_id = ?2 AND body_key IS NOT NULL", appId);
    await deleteBodies(env, tdb, ids.map((r) => r.trace_id));
  }
  await tdb.batch([
    tdb.prepare("DELETE FROM llm_spans WHERE tenant_id = ?1 AND app_id = ?2", appId),
    tdb.prepare("DELETE FROM llm_traces WHERE tenant_id = ?1 AND app_id = ?2", appId),
    tdb.prepare("DELETE FROM trace_apps WHERE tenant_id = ?1 AND id = ?2", appId),
  ]);
  return true;
}
