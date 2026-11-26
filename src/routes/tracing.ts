/** Portal API for LLM tracing, mounted at /api/tracing behind the portal's session middleware. */
import { Hono } from "hono";
import { requireOwner, requireWrite, type Session } from "../lib/auth";
import { normalizeEmail } from "../lib/session";
import { newApiKey } from "../lib/tokens";
import { appOrigin } from "../billing/config";
import { clamp, HttpError, isDay, newId } from "../lib/util";
import { deleteApp, getSpan, getTrace, listApps, listPeople, listSessions, listTraces, traceTotals, type TraceFilters } from "../tracing/query";
import { LIMITS } from "../tracing/store";
import { MAX_BODY_BYTES } from "../tracing/otlp";
import { peopleCsv, tracesCsv, tracesJsonl } from "../tracing/export";
import { retentionDays, retentionStatus } from "../tracing/retention";
import { getReport, listReports, personSummary, teamSummary } from "../tracing/people";
import { CAPTURES, getCapture, setCapture, type Capture } from "../tracing/policy";
import { reportEmailsOn, setReportEmails } from "../tracing/report-mail";
import type { AppEnv } from "./portal";

export const tracingApi = new Hono<AppEnv>();

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

/**
 * Coding-tool prompts and reports belong to their person. Owners (and the read-only demo) see everyone's;
 * anyone else sees only their own. Usage numbers (People, Team) stay visible to the workspace.
 */
function viewerFor(s: Session): string | undefined {
  return s.role === "owner" || s.demo ? undefined : s.email;
}

function assertCanSeePerson(s: Session, user: string): void {
  const v = viewerFor(s);
  if (v && v !== user) throw new HttpError(403, "forbidden", "Only an owner or that person can see their prompts and reports.");
}

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
  const f = { ...filtersFrom(new URL(c.req.url).searchParams), viewer: viewerFor(c.get("session")) };
  const [page, totals] = await Promise.all([listTraces(tdb, f), f.cursor ? null : traceTotals(tdb, f)]);
  return c.json({ ...page, totals });
});

tracingApi.get("/traces/:traceId", async (c) => {
  const id = c.req.param("traceId").toLowerCase();
  if (!TRACE_ID.test(id)) throw new HttpError(404, "not_found", "Trace not found");
  return c.json(await getTrace(c.get("session").tdb, id, viewerFor(c.get("session"))));
});

tracingApi.get("/traces/:traceId/spans/:spanId", async (c) => {
  const traceId = c.req.param("traceId").toLowerCase();
  const spanId = c.req.param("spanId").toLowerCase();
  if (!TRACE_ID.test(traceId) || !SPAN_ID.test(spanId)) throw new HttpError(404, "not_found", "Span not found");
  return c.json(await getSpan(c.get("session").tdb, traceId, spanId, viewerFor(c.get("session")), c.env));
});

tracingApi.get("/sessions", async (c) => {
  const f = filtersFrom(new URL(c.req.url).searchParams);
  return c.json(await listSessions(c.get("session").tdb, { appId: f.appId, fromMs: f.fromMs, toMs: f.toMs, limit: Math.min(f.limit, 100), viewer: viewerFor(c.get("session")) }));
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
  assertCanSeePerson(c.get("session"), user);
  const from = f.fromMs ?? now - 30 * 86_400_000;
  const to = f.toMs ?? now;
  const s = await personSummary(tdb, user, from, to);
  if (!s.totals.turns) throw new HttpError(404, "not_found", "No traces from this person in this range");
  // The period of the same length just before, for "up or down since then".
  const previous = (await personSummary(tdb, user, from - (to - from) - 1, from - 1)).totals;
  return c.json({ ...s, previous: previous.turns ? previous : null });
});

tracingApi.get("/people/:user/reports", async (c) => {
  const user = c.req.param("user").slice(0, 200);
  assertCanSeePerson(c.get("session"), user);
  return c.json(await listReports(c.get("session").tdb, user, 60));
});

tracingApi.get("/people/:user/reports/:day", async (c) => {
  assertCanSeePerson(c.get("session"), c.req.param("user").slice(0, 200));
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

/** Spans used this month against the workspace's allowance. */
tracingApi.get("/usage", async (c) => {
  const month = new Date().toISOString().slice(0, 7);
  const row = await c.get("session").tdb.first<{ spans: number | null; bytes: number | null; trace_span_limit: number }>(
    "SELECT u.spans, u.bytes, t.trace_span_limit FROM tenants t LEFT JOIN trace_usage u ON u.tenant_id = t.id AND u.month = ?2 WHERE t.id = ?1",
    month,
  );
  return c.json({ month, spans: row?.spans ?? 0, bytes: row?.bytes ?? 0, limit: row?.trace_span_limit ?? 0 });
});

// ------------------------------------------------------------------ exports (keep a local copy)

const stamp = () => new Date().toISOString().slice(0, 10);
const download = (name: string, type: string) => ({ "content-type": type, "content-disposition": `attachment; filename="${name}"` });

tracingApi.get("/export/traces.csv", async (c) => {
  const f = filtersFrom(new URL(c.req.url).searchParams);
  const { csv, truncated } = await tracesCsv(c.get("session").tdb, { ...f, cursor: undefined, viewer: viewerFor(c.get("session")) });
  return new Response(csv, { headers: { ...download(`traces-${stamp()}.csv`, "text/csv; charset=utf-8"), "x-export-truncated": truncated ? "true" : "false" } });
});

tracingApi.get("/export/traces.jsonl", (c) => {
  const f = filtersFrom(new URL(c.req.url).searchParams);
  return new Response(tracesJsonl(c.get("session").tdb, { ...f, cursor: undefined, viewer: viewerFor(c.get("session")) }, c.env), { headers: download(`traces-${stamp()}.jsonl`, "application/x-ndjson; charset=utf-8") });
});

tracingApi.get("/export/people.csv", async (c) => {
  const f = filtersFrom(new URL(c.req.url).searchParams);
  return new Response(await peopleCsv(c.get("session").tdb, { appId: f.appId, fromMs: f.fromMs, toMs: f.toMs }), { headers: download(`people-${stamp()}.csv`, "text/csv; charset=utf-8") });
});

// ------------------------------------------------------------------ capture level

tracingApi.get("/settings", async (c) => {
  const tdb = c.get("session").tdb;
  const [capture, email] = await Promise.all([getCapture(tdb), reportEmailsOn(tdb)]);
  return c.json({ capture, email_reports: email });
});

/** Owners choose what coding tools may send. It is enforced at ingest, whatever each machine is set to. */
tracingApi.put("/settings", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  requireOwner(s);
  const b = (await c.req.json().catch(() => ({}))) as { capture?: unknown; email_reports?: unknown };
  if (b.capture === undefined && b.email_reports === undefined) throw new HttpError(400, "bad_request", "Send capture or email_reports");
  if (b.capture !== undefined && !CAPTURES.includes(b.capture as Capture)) throw new HttpError(400, "bad_request", "capture must be full, prompts or metadata");
  if (b.email_reports !== undefined && typeof b.email_reports !== "boolean") throw new HttpError(400, "bad_request", "email_reports must be true or false");
  if (b.capture !== undefined) await setCapture(s.tdb, b.capture as Capture, s.email);
  if (b.email_reports !== undefined) await setReportEmails(s.tdb, b.email_reports as boolean, s.email);
  await s.tdb.run("INSERT INTO audit_log (id, tenant_id, user_email, action, detail) VALUES (?2, ?1, ?3, 'trace_settings.update', ?4)", newId("aud"), s.email, JSON.stringify({ capture: b.capture, email_reports: b.email_reports }));
  const [capture, email] = await Promise.all([getCapture(s.tdb), reportEmailsOn(s.tdb)]);
  return c.json({ capture, email_reports: email });
});

// ------------------------------------------------------------------ personal keys

const PERSONAL_KEYS_PER_PERSON = 5;

/** Your personal tracing keys; an owner sees everyone's. Secrets are never returned after creation. */
tracingApi.get("/keys", async (c) => {
  const s = c.get("session");
  const v = viewerFor(s);
  const sql = `SELECT id, name, prefix, person, created_at, last_used_at FROM api_keys
               WHERE tenant_id = ?1 AND person IS NOT NULL AND revoked_at IS NULL${v ? " AND person = ?2" : ""} ORDER BY person, created_at DESC`;
  return c.json(v ? await s.tdb.all(sql, v) : await s.tdb.all(sql));
});

/**
 * A personal key for Claude Code and Codex. Anyone signed in may make one for themselves (viewers too: it only sends
 * their own traces); an owner may make one for another person. Every trace sent with it is that person's.
 */
tracingApi.post("/keys", async (c) => {
  const s = c.get("session");
  if (s.demo) throw new HttpError(403, "read_only", "The demo is read-only.");
  let b: { name?: unknown; person?: unknown } = {};
  try {
    b = (await c.req.json()) as typeof b;
  } catch {
    /* empty body: a key for yourself */
  }
  const person = b.person === undefined || b.person === "" ? s.email : normalizeEmail(b.person);
  if (!person) throw new HttpError(400, "bad_request", "person must be an email address");
  if (person !== s.email) requireOwner(s);
  const active = await s.tdb.first<{ n: number }>("SELECT COUNT(*) AS n FROM api_keys WHERE tenant_id = ?1 AND person = ?2 AND revoked_at IS NULL", person);
  if ((active?.n ?? 0) >= PERSONAL_KEYS_PER_PERSON) throw new HttpError(409, "too_many_keys", `${person} already has ${PERSONAL_KEYS_PER_PERSON} keys. Revoke one first.`);
  const name = (typeof b.name === "string" ? b.name.trim().slice(0, 80) : "") || `Coding tools (${person})`;
  const k = await newApiKey();
  const id = newId("key");
  await s.tdb.run("INSERT INTO api_keys (id, tenant_id, name, key_hash, prefix, scope, person) VALUES (?2, ?1, ?3, ?4, ?5, 'ingest', ?6)", id, name, k.hash, k.prefix, person);
  await s.tdb.run("INSERT INTO audit_log (id, tenant_id, user_email, action, detail) VALUES (?2, ?1, ?3, 'trace_key.create', ?4)", newId("aud"), s.email, JSON.stringify({ id, person }));
  return c.json({ id, secret: k.secret, prefix: k.prefix, person, name }, 201);
});

/**
 * An owner makes one personal key per person for a managed rollout and downloads them as CSV (person,key).
 * The secrets exist only in that download. People already at their key limit are listed with an empty key.
 */
tracingApi.post("/keys/bulk", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  requireOwner(s);
  const b = (await c.req.json().catch(() => ({}))) as { people?: unknown };
  const raw = Array.isArray(b.people) ? b.people : typeof b.people === "string" ? b.people.split(/[\s,;]+/) : [];
  const people = [...new Set(raw.map((p) => normalizeEmail(p)).filter((p): p is string => !!p))];
  if (!people.length) throw new HttpError(400, "bad_request", "people must list email addresses");
  if (people.length > 500) throw new HttpError(400, "bad_request", "At most 500 people at a time");
  const counts = new Map(
    (await s.tdb.all<{ person: string; n: number }>("SELECT person, COUNT(*) AS n FROM api_keys WHERE tenant_id = ?1 AND person IS NOT NULL AND revoked_at IS NULL GROUP BY person")).map((r) => [r.person, r.n]),
  );
  const lines = ["person,key,note"];
  const stmts = [];
  for (const person of people) {
    if ((counts.get(person) ?? 0) >= PERSONAL_KEYS_PER_PERSON) {
      lines.push(`${person},,already has ${PERSONAL_KEYS_PER_PERSON} keys`);
      continue;
    }
    const k = await newApiKey();
    stmts.push(s.tdb.prepare("INSERT INTO api_keys (id, tenant_id, name, key_hash, prefix, scope, person) VALUES (?2, ?1, ?3, ?4, ?5, 'ingest', ?6)", newId("key"), "Coding tools (rollout)", k.hash, k.prefix, person));
    lines.push(`${person},${k.secret},`);
  }
  for (let i = 0; i < stmts.length; i += 50) await s.tdb.batch(stmts.slice(i, i + 50));
  await s.tdb.run("INSERT INTO audit_log (id, tenant_id, user_email, action, detail) VALUES (?2, ?1, ?3, 'trace_key.bulk_create', ?4)", newId("aud"), s.email, JSON.stringify({ people: people.length, created: stmts.length }));
  return new Response(`${lines.join("\n")}\n`, { headers: { ...download(`trace-keys-${stamp()}.csv`, "text/csv; charset=utf-8"), "cache-control": "no-store" } });
});

tracingApi.delete("/keys/:id", async (c) => {
  const s = c.get("session");
  if (s.demo) throw new HttpError(403, "read_only", "The demo is read-only.");
  const key = await s.tdb.first<{ person: string }>("SELECT person FROM api_keys WHERE tenant_id = ?1 AND id = ?2 AND person IS NOT NULL AND revoked_at IS NULL", c.req.param("id"));
  if (!key) throw new HttpError(404, "not_found", "Key not found");
  if (key.person !== s.email) requireOwner(s);
  await s.tdb.run("UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id = ?1 AND id = ?2", c.req.param("id"));
  await s.tdb.run("INSERT INTO audit_log (id, tenant_id, user_email, action, detail) VALUES (?2, ?1, ?3, 'trace_key.revoke', ?4)", newId("aud"), s.email, JSON.stringify({ id: c.req.param("id"), person: key.person }));
  return c.json({ ok: true });
});

tracingApi.delete("/apps/:id", async (c) => {
  const s = c.get("session");
  requireWrite(s);
  requireOwner(s);
  const id = c.req.param("id");
  if (!(await deleteApp(s.tdb, id, c.env))) throw new HttpError(404, "not_found", "App not found");
  await s.tdb.run("INSERT INTO audit_log (id, tenant_id, user_email, action, detail) VALUES (?2, ?1, ?3, 'trace_app.delete', ?4)", newId("aud"), s.email, JSON.stringify({ id }));
  return c.json({ ok: true });
});
