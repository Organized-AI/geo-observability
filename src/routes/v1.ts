import { Hono } from "hono";
import type { Env } from "../env";
import { TenantDB } from "../lib/db";
import { HttpError, isDay, parseJson } from "../lib/util";
import { resolveKey } from "../observability/ingest";
import { trackPass } from "../lib/pass";
import { Binds, runsCte, type Filters } from "../metrics/filters";
import { chats, domainReport, loadBrands, urlReport } from "../metrics/report";

type V1Env = { Bindings: Env; Variables: { tdb: TenantDB } };

/** Approximate per-key rate limit on KV (eventually consistent, good enough to stop runaway scripts). */
export async function rateLimit(env: Env, keyId: string, perMinute = 120): Promise<void> {
  const bucket = `rl:${keyId}:${Math.floor(Date.now() / 60_000)}`;
  const n = Number((await env.CONFIG.get(bucket)) ?? 0);
  if (n >= perMinute) throw new HttpError(429, "rate_limited", `Limit is ${perMinute} requests per minute per key`);
  await env.CONFIG.put(bucket, String(n + 1), { expirationTtl: 120 });
}

export const v1 = new Hono<V1Env>();

v1.use("*", async (c, next) => {
  const key = await resolveKey(c.env, c.req.header("x-api-key") ?? null, ["read"]);
  await trackPass(c.env, key.keyId, "api");
  await rateLimit(c.env, key.keyId);
  c.set("tdb", new TenantDB(c.env.DB, key.tenantId));
  await next();
});

v1.get("/projects", async (c) => c.json({ data: await c.get("tdb").all("SELECT id, name, domain, schedule, created_at FROM projects WHERE tenant_id = ?1 ORDER BY created_at") }));

v1.get("/prompts", async (c) => {
  const tdb = c.get("tdb");
  const p = await tdb.project(c.req.query("project_id") ?? "");
  const rows = await tdb.all<{ tags: string }>(
    "SELECT id, text, country, language, intent, branded, volume, tags, status, topic_id FROM prompts WHERE tenant_id = ?1 AND project_id = ?2 ORDER BY created_at",
    p.id,
  );
  return c.json({ data: rows.map((r) => ({ ...r, tags: parseJson(r.tags, []) })) });
});

v1.get("/chats", async (c) => {
  const tdb = c.get("tdb");
  const p = await tdb.project(c.req.query("project_id") ?? "");
  const own = (await loadBrands(tdb, p.id)).find((b) => b.isOwn);
  const f = filtersFrom({ start_date: c.req.query("from"), end_date: c.req.query("to") });
  const res = await chats(tdb, p.id, f, { ownBrandId: own?.id ?? null, limit: Number(c.req.query("limit") ?? 100), cursor: c.req.query("cursor") });
  return c.json({ data: res.items, next_cursor: res.next_cursor });
});

interface ReportBody {
  project_id?: string;
  start_date?: string;
  end_date?: string;
  dimensions?: string[];
  filters?: { field: string; operator: "in" | "not_in"; values: string[] }[];
  order_by?: { field: string; direction: "asc" | "desc" }[];
  limit?: number;
  offset?: number;
  compare_previous?: boolean;
}

function filtersFrom(b: ReportBody): Filters {
  const end = b.end_date && isDay(b.end_date) ? b.end_date : new Date().toISOString().slice(0, 10);
  const start = b.start_date && isDay(b.start_date) ? b.start_date : new Date(Date.parse(end) - 13 * 86_400_000).toISOString().slice(0, 10);
  if (start > end) throw new HttpError(400, "bad_range", "start_date must be on or before end_date");
  const f: Filters = { from: start, to: end, engines: [], countries: [], topics: [], tags: [], prompts: [] };
  const map: Record<string, keyof Filters> = { engine: "engines", country: "countries", topic: "topics", tag: "tags", prompt: "prompts" };
  for (const flt of b.filters ?? []) {
    const k = map[flt.field];
    if (!k) throw new HttpError(400, "bad_filter", `Unknown filter field ${flt.field}`);
    if (flt.operator !== "in") throw new HttpError(400, "bad_filter", "Only the 'in' operator is supported on this field");
    (f[k] as string[]) = (flt.values ?? []).map(String).slice(0, 50);
  }
  return f;
}

const DIMENSIONS: Record<string, string> = { date: "r.run_date", engine: "r.engine", country: "r.country", topic: "r.topic_id", prompt: "r.prompt_id" };
const METRICS = ["visibility", "share_of_voice", "position", "sentiment", "mentions", "answers"];

/**
 * Brand report: one row per brand × requested dimensions with visibility, share of voice, position, sentiment.
 * Same definitions as the portal.
 */
async function brandReport(tdb: TenantDB, b: ReportBody) {
  const p = await tdb.project(b.project_id ?? "");
  const f = filtersFrom(b);
  const dims = (b.dimensions ?? []).filter((d) => DIMENSIONS[d]);
  if ((b.dimensions ?? []).length !== dims.length) throw new HttpError(400, "bad_dimension", `Dimensions: ${Object.keys(DIMENSIONS).join(", ")}`);
  const brands = await loadBrands(tdb, p.id);
  if (!brands.length) return [];
  const bi = new Binds();
  const cte = runsCte(bi, p.id, f);
  const ids = bi.list(brands.map((x) => x.id));
  const dimCols = dims.map((d) => `${DIMENSIONS[d]} AS ${d}`);
  const dimGroup = dims.map((d) => DIMENSIONS[d]);
  const rows = await tdb.all<Record<string, unknown> & { brand_id: string; mentions: number; rank_sum: number; sent: number | null }>(
    `WITH ${cte}
     SELECT m.brand_id, ${dimCols.length ? dimCols.join(", ") + "," : ""} COUNT(*) AS mentions, SUM(m.rank) AS rank_sum, AVG(m.sentiment) AS sent
     FROM r CROSS JOIN mentions m ON m.run_id = r.id WHERE m.tenant_id = ?1 AND m.brand_id IN (${ids})
     GROUP BY m.brand_id${dimGroup.length ? ", " + dimGroup.join(", ") : ""}`,
    ...bi.values,
  );
  const b2 = new Binds();
  const cte2 = runsCte(b2, p.id, f);
  const totals = await tdb.all<Record<string, unknown> & { answers: number }>(
    `WITH ${cte2} SELECT ${dimCols.length ? dimCols.join(", ") + "," : ""} COUNT(*) AS answers FROM r ${dimGroup.length ? "GROUP BY " + dimGroup.join(", ") : ""}`,
    ...b2.values,
  );
  const keyOf = (r: Record<string, unknown>) => dims.map((d) => String(r[d] ?? "")).join("|");
  const allMentions = new Map<string, number>();
  for (const r of rows) allMentions.set(keyOf(r), (allMentions.get(keyOf(r)) ?? 0) + r.mentions);
  const out: Record<string, unknown>[] = [];
  for (const t of totals) {
    for (const br of brands) {
      const r = rows.find((x) => x.brand_id === br.id && keyOf(x) === keyOf(t));
      const row: Record<string, unknown> = { brand_id: br.id, brand_name: br.name, is_own: br.isOwn };
      for (const d of dims) row[d] = t[d];
      row.answers = t.answers;
      row.mentions = r?.mentions ?? 0;
      row.visibility = t.answers ? (r?.mentions ?? 0) / t.answers : 0;
      row.share_of_voice = allMentions.get(keyOf(t)) ? (r?.mentions ?? 0) / allMentions.get(keyOf(t))! : 0;
      row.position = r?.mentions ? r.rank_sum / r.mentions : null;
      row.sentiment = r?.sent ?? null;
      out.push(row);
    }
  }
  return out;
}

function sortPage(rows: Record<string, unknown>[], b: ReportBody, allowed: string[]) {
  for (const o of [...(b.order_by ?? [])].reverse()) {
    if (!allowed.includes(o.field)) throw new HttpError(400, "bad_order", `Can't order by ${o.field}`);
    const dir = o.direction === "asc" ? 1 : -1;
    rows.sort((x, y) => {
      const a = x[o.field] as number | string | null;
      const c = y[o.field] as number | string | null;
      if (a === c) return 0;
      if (a === null || a === undefined) return 1;
      if (c === null || c === undefined) return -1;
      return a > c ? dir : -dir;
    });
  }
  const offset = Math.max(0, Number(b.offset ?? 0));
  const limit = Math.min(Math.max(Number(b.limit ?? 1000), 1), 10_000);
  return { data: rows.slice(offset, offset + limit), total: rows.length };
}

function previous(b: ReportBody): ReportBody {
  const f = filtersFrom(b);
  const n = Math.round((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000) + 1;
  const end = new Date(Date.parse(f.from) - 86_400_000).toISOString().slice(0, 10);
  const start = new Date(Date.parse(end) - (n - 1) * 86_400_000).toISOString().slice(0, 10);
  return { ...b, start_date: start, end_date: end };
}

v1.post("/reports/brands", async (c) => {
  const tdb = c.get("tdb");
  const b = (await c.req.json().catch(() => ({}))) as ReportBody;
  const rows = await brandReport(tdb, b);
  const allowed = ["brand_name", ...METRICS, ...(b.dimensions ?? [])];
  const res = sortPage(rows, b, allowed);
  if (b.compare_previous) {
    const prev = await brandReport(tdb, previous(b));
    const key = (r: Record<string, unknown>) => [r.brand_id, ...(b.dimensions ?? []).filter((d) => d !== "date").map((d) => r[d])].join("|");
    for (const r of res.data) {
      const pr = prev.find((x) => key(x) === key(r) && (!(b.dimensions ?? []).includes("date")));
      r.previous = pr ? { visibility: pr.visibility, share_of_voice: pr.share_of_voice, position: pr.position, sentiment: pr.sentiment } : null;
    }
  }
  return c.json(res);
});

v1.post("/reports/domains", async (c) => {
  const tdb = c.get("tdb");
  const b = (await c.req.json().catch(() => ({}))) as ReportBody;
  const p = await tdb.project(b.project_id ?? "");
  const rows = (await domainReport(tdb, p.id, filtersFrom(b), await loadBrands(tdb, p.id), { limit: 500 })) as unknown as Record<string, unknown>[];
  return c.json(sortPage(rows, b, ["domain", "type", "citations", "answers", "share"]));
});

v1.post("/reports/urls", async (c) => {
  const tdb = c.get("tdb");
  const b = (await c.req.json().catch(() => ({}))) as ReportBody;
  const p = await tdb.project(b.project_id ?? "");
  const rows = (await urlReport(tdb, p.id, filtersFrom(b))) as unknown as Record<string, unknown>[];
  return c.json(sortPage(rows, b, ["url", "domain", "citations", "answers", "cited", "used", "first_seen", "last_seen"]));
});

export { brandReport, filtersFrom, type ReportBody };
