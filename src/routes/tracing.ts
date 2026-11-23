/** Portal API for LLM tracing, mounted at /api/tracing behind the portal's session middleware. */
import { Hono } from "hono";
import { requireOwner, requireWrite } from "../lib/auth";
import { appOrigin } from "../billing/config";
import { clamp, HttpError, isDay, newId } from "../lib/util";
import { deleteApp, getSpan, getTrace, listApps, listPeople, listSessions, listTraces, traceTotals, type TraceFilters } from "../tracing/query";
import { LIMITS } from "../tracing/store";
import { MAX_BODY_BYTES } from "../tracing/otlp";
import { peopleCsv, tracesCsv, tracesJsonl } from "../tracing/export";
import { retentionDays, retentionStatus } from "../tracing/retention";
import { getReport, listReports, personSummary, teamSummary } from "../tracing/people";
import type { AppEnv } from "./portal";

export const tracingApi = new Hono<AppEnv>();

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

function filtersFrom(q: URLSearchParams): TraceFilters {
  const f: TraceFilters = { limit: clamp(Math.floor(Number(q.get("limit") ?? 50)) || 50, 1, 200) };
  const from = q.get("from");
  const to = q.get("to");
  if (from) {
    if (!isDay(from)) throw new HttpError(400, "bad_range", "from must be a date like 2026-11-20");
    f.fromMs = Date.parse(`${from}T00:00:00Z`);
  }
  if (to) {
    if (!isDay(to)) throw new HttpError(400, "bad_range", "to must be a date like 2026-11-20");
    f.toMs = Date.parse(`${to}T23:59:59.999Z`);
  }
  if (f.fromMs !== undefined && f.toMs !== undefined && f.fromMs > f.toMs) throw new HttpError(400, "bad_range", "from must be on or before to");
  const status = q.get("status");
  if (status === "error" || status === "ok") f.status = status;
  else if (status) throw new HttpError(400, "bad_request", "status must be error or ok");
  const text = (k: string, max: number) => (q.get(k) ?? "").trim().slice(0, max) || undefined;
  f.appId = text("app", 40);
  f.q = text("q", 200);
  f.sessionId = text("session", 200);
  f.userId = text("user", 200);
  f.model = text("model", 200);
  f.cursor = text("cursor", 60);
  const min = q.get("min_ms");
  if (min) {
    const n = Number(min);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "bad_request", "min_ms must be a number of milliseconds");
    f.minMs = Math.floor(n);
  }
  return f;
}

tracingApi.get("/apps", async (c) => c.json(await listApps(c.get("session").tdb)));

tracingApi.get("/traces", async (c) => {
  const tdb = c.get("session").tdb;
  const f = filtersFrom(new URL(c.req.url).searchParams);
  const [page, totals] = await Promise.all([listTraces(tdb, f), f.cursor ? null : traceTotals(tdb, f)]);
  return c.json({ ...page, totals });
});

tracingApi.get("/traces/:traceId", async (c) => {
  const id = c.req.param("traceId").toLowerCase();
  if (!TRACE_ID.test(id)) throw new HttpError(404, "not_found", "Trace not found");
  return c.json(await getTrace(c.get("session").tdb, id));
});

tracingApi.get("/traces/:traceId/spans/:spanId", async (c) => {
  const traceId = c.req.param("traceId").toLowerCase();
  const spanId = c.req.param("spanId").toLowerCase();
  if (!TRACE_ID.test(traceId) || !SPAN_ID.test(spanId)) throw new HttpError(404, "not_found", "Span not found");
  return c.json(await getSpan(c.get("session").tdb, traceId, spanId));
});

tracingApi.get("/sessions", async (c) => {
  const f = filtersFrom(new URL(c.req.url).searchParams);
  return c.json(await listSessions(c.get("session").tdb, { appId: f.appId, fromMs: f.fromMs, toMs: f.toMs, limit: Math.min(f.limit, 100) }));
});

tracingApi.get("/people", async (c) => {
  const f = filtersFrom(new URL(c.req.url).searchParams);
  const rows = await listPeople(c.get("session").tdb, { appId: f.appId, fromMs: f.fromMs, toMs: f.toMs, limit: f.limit });
  return c.json(rows.map((r) => ({ ...r, apps: String(r.apps ?? "").split(",").filter(Boolean).sort() })));
});

/** The team as a whole: who uses what, and where it is uneven. */
tracingApi.get("/team", async (c) => {
  const f = filtersFrom(new URL(c.req.url).searchParams);
  const now = Date.now();
  return c.json(await teamSummary(c.get("session").tdb, f.fromMs ?? now - 30 * 86_400_000, f.toMs ?? now, f.appId));
});

/** One person in detail: tools, skills, plugins, subagents, models, projects, sessions, by day. */
tracingApi.get("/people/:user", async (c) => {
  const f = filtersFrom(new URL(c.req.url).searchParams);
  const now = Date.now();
  const tdb = c.get("session").tdb;
  const user = c.req.param("user").slice(0, 200);
  const from = f.fromMs ?? now - 30 * 86_400_000;
  const to = f.toMs ?? now;
  const s = await personSummary(tdb, user, from, to);
  if (!s.totals.turns) throw new HttpError(404, "not_found", "No traces from this person in this range");
  // The period of the same length just before, for "up or down since then".
  const previous = (await personSummary(tdb, user, from - (to - from) - 1, from - 1)).totals;
  return c.json({ ...s, previous: previous.turns ? previous : null });
});

tracingApi.get("/people/:user/reports", async (c) => c.json(await listReports(c.get("session").tdb, c.req.param("user").slice(0, 200), 60)));

tracingApi.get("/people/:user/reports/:day", async (c) => {
  const r = await getReport(c.get("session").tdb, c.req.param("user").slice(0, 200), c.req.param("day"));
  if (!r) throw new HttpError(404, "not_found", "No activity from this person on that day");
  return c.json(r);
});

/** Where to send traces and what the limits are. Keys are made under Usage & API; none is returned here. */
tracingApi.get("/setup", (c) => {
  const origin = appOrigin(c.env, c.req.raw);
  return c.json({
    endpoint: `${origin}/ingest/otlp`,
    traces_url: `${origin}/ingest/otlp/v1/traces`,
    key_header: "x-ingest-key",
    app_header: "x-project-name",
    installer_url: `${origin}/trace/geo-trace.mjs`,
    retention_days: retentionDays(c.env),
    limits: { body_mb: MAX_BODY_BYTES / 1024 / 1024, spans_per_request: LIMITS.spansPerRequest, apps: LIMITS.appsPerTenant, requests_per_minute: 600 },
  });
});

tracingApi.get("/retention", async (c) => c.json(await retentionStatus(c.get("session").tdb, c.env)));

// ------------------------------------------------------------------ exports (keep a local copy)

const stamp = () => new Date().toISOString().slice(0, 10);
const download = (name: string, type: string) => ({ "content-type": type, "content-disposition": `attachment; filename="${name}"` });

tracingApi.get("/export/traces.csv", async (c) => {
  const f = filtersFrom(new URL(c.req.url).searchParams);
  const { csv, truncated } = await tracesCsv(c.get("session").tdb, { ...f, cursor: undefined });
  return new Response(csv, { headers: { ...download(`traces-${stamp()}.csv`, "text/csv; charset=utf-8"), "x-export-truncated": truncated ? "true" : "false" } });
});

tracingApi.get("/export/traces.jsonl", (c) => {
  const f = filtersFrom(new URL(c.req.url).searchParams);
  return new Response(tracesJsonl(c.get("session").tdb, { ...f, cursor: undefined }), { headers: download(`traces-${stamp()}.jsonl`, "application/x-ndjson; charset=utf-8") });
});

tracingApi.get("/export/people.csv", async (c) => {
  const f = filtersFrom(new URL(c.req.url).searchParams);
  return new Response(await peopleCsv(c.get("session").tdb, { appId: f.appId, fromMs: f.fromMs, toMs: f.toMs }), { headers: download(`people-${stamp()}.csv`, "text/csv; charset=utf-8") });
});

tracingApi.delete("/apps/:id", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  requireOwner(s);
  const id = c.req.param("id");
  if (!(await deleteApp(s.tdb, id))) throw new HttpError(404, "not_found", "App not found");
  await s.tdb.run("INSERT INTO audit_log (id, tenant_id, user_email, action, detail) VALUES (?2, ?1, ?3, 'trace_app.delete', ?4)", newId("aud"), s.email, JSON.stringify({ id }));
  return c.json({ ok: true });
});
