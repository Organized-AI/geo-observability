import type { Env } from "../env";
import { TenantDB } from "../lib/db";
import { HttpError, normalizePath, sha256Hex } from "../lib/util";
import { classifyBot, classifyReferral } from "./classify";

export interface IngestKey {
  tenantId: string;
  keyId: string;
}

/** Resolve an ingest (or read) key to a tenant. Keys are stored as SHA-256 hashes only. */
export async function resolveKey(env: Env, secret: string | null, scopes: string[]): Promise<IngestKey> {
  if (!secret || secret.length < 20) throw new HttpError(401, "bad_key", "Missing or malformed key");
  const hash = await sha256Hex(secret);
  const row = await env.DB.prepare("SELECT id, tenant_id, scope FROM api_keys WHERE key_hash = ?1 AND revoked_at IS NULL")
    .bind(hash)
    .first<{ id: string; tenant_id: string; scope: string }>();
  if (!row || !scopes.includes(row.scope)) throw new HttpError(401, "bad_key", "Key not recognised for this endpoint");
  // Last-used is advisory; don't fail the request if this write fails.
  env.DB.prepare("UPDATE api_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(row.id).run().catch(() => undefined);
  return { tenantId: row.tenant_id, keyId: row.id };
}

export interface EdgeEvent {
  ts?: string;
  host?: string;
  path?: string;
  ua?: string;
  referer?: string;
  status?: number;
  country?: string;
  utm_source?: string;
}

const dayOf = (ts?: string) => {
  const d = ts ? new Date(ts) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
};

async function assertProject(tdb: TenantDB, projectId: unknown): Promise<string> {
  if (typeof projectId !== "string") throw new HttpError(400, "bad_request", "project_id is required");
  await tdb.project(projectId);
  return projectId;
}

/** Edge tap events: AI bot hits go to crawl_daily, AI-referred arrivals to referral_daily. */
export async function ingestEdge(env: Env, key: IngestKey, body: { project_id?: string; events?: EdgeEvent[] }) {
  const tdb = new TenantDB(env.DB, key.tenantId);
  const projectId = await assertProject(tdb, body.project_id);
  const events = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
  const crawl = new Map<string, { day: string; path: string; bot: string; operator: string; type: string; hits: number; s4: number }>();
  const refs = new Map<string, { day: string; path: string; assistant: string; n: number }>();
  for (const e of events) {
    const path = normalizePath(String(e.path ?? "/").split("?")[0]);
    const day = dayOf(e.ts);
    const bot = classifyBot(e.ua);
    if (bot) {
      const k = `${day}|${path}|${bot.bot}`;
      const c = crawl.get(k) ?? { day, path, bot: bot.bot, operator: bot.operator, type: bot.type, hits: 0, s4: 0 };
      c.hits++;
      if ((e.status ?? 200) >= 400 && (e.status ?? 200) < 500) c.s4++;
      crawl.set(k, c);
      env.TRAFFIC_EVENTS?.writeDataPoint({ indexes: [key.tenantId], blobs: [projectId, "crawl", bot.bot, bot.type, path, e.country ?? ""], doubles: [1, e.status ?? 0] });
      continue;
    }
    const assistant = classifyReferral(e.referer, e.utm_source);
    if (assistant) {
      const k = `${day}|${path}|${assistant}`;
      const r = refs.get(k) ?? { day, path, assistant, n: 0 };
      r.n++;
      refs.set(k, r);
      env.TRAFFIC_EVENTS?.writeDataPoint({ indexes: [key.tenantId], blobs: [projectId, "referral", assistant, "", path, e.country ?? ""], doubles: [1, 0] });
    }
  }
  const stmts: D1PreparedStatement[] = [];
  for (const c of crawl.values()) {
    stmts.push(
      tdb.prepare(
        `INSERT INTO crawl_daily (tenant_id, project_id, day, path, bot, operator, bot_type, hits, status_4xx)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(tenant_id, project_id, day, path, bot) DO UPDATE SET hits = hits + excluded.hits, status_4xx = status_4xx + excluded.status_4xx`,
        projectId,
        c.day,
        c.path,
        c.bot,
        c.operator,
        c.type,
        c.hits,
        c.s4,
      ),
    );
  }
  for (const r of refs.values()) stmts.push(referralUpsert(tdb, projectId, r.day, r.path, r.assistant, "edge", r.n));
  await tdb.batch(stmts);
  return { crawl: [...crawl.values()].reduce((a, c) => a + c.hits, 0), referrals: [...refs.values()].reduce((a, r) => a + r.n, 0) };
}

function referralUpsert(tdb: TenantDB, projectId: string, day: string, path: string, assistant: string, source: string, n: number) {
  return tdb.prepare(
    `INSERT INTO referral_daily (tenant_id, project_id, day, path, assistant, source, sessions) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(tenant_id, project_id, day, path, assistant, source) DO UPDATE SET sessions = sessions + excluded.sessions`,
    projectId,
    day,
    path,
    assistant,
    source,
    n,
  );
}

/** tap.js beacon: one AI-referred page view. The client script only sends when it detects an assistant. */
export async function ingestHit(env: Env, key: IngestKey, body: { p?: string; url?: string; ref?: string; utm?: string }) {
  const tdb = new TenantDB(env.DB, key.tenantId);
  const projectId = await assertProject(tdb, body.p);
  const assistant = classifyReferral(body.ref, body.utm);
  if (!assistant) return { counted: false };
  let path = "/";
  try {
    path = normalizePath(new URL(String(body.url)).pathname);
  } catch {
    /* keep / */
  }
  await tdb.batch([referralUpsert(tdb, projectId, dayOf(), path, assistant, "tap", 1)]);
  env.TRAFFIC_EVENTS?.writeDataPoint({ indexes: [key.tenantId], blobs: [projectId, "referral", assistant, "tap", path, ""], doubles: [1, 0] });
  return { counted: true, assistant };
}

export interface ConversionEvent {
  event_id?: string;
  event_name?: string;
  ts?: string;
  landing_path?: string;
  assistant?: string;
  referrer?: string;
  utm_source?: string;
  value?: number;
  currency?: string;
  source?: string;
}

const SOURCES = new Set(["sgtm", "ga4", "google_ads", "meta", "tiktok", "shopify"]);

/**
 * Server-side conversions. Only AI-attributed conversions are kept; event_id deduplicates the same
 * conversion arriving from several systems (for example sGTM and Shopify).
 */
export async function ingestConversions(env: Env, key: IngestKey, body: { project_id?: string; events?: ConversionEvent[] }) {
  const tdb = new TenantDB(env.DB, key.tenantId);
  const projectId = await assertProject(tdb, body.project_id);
  let kept = 0;
  let duplicates = 0;
  let unattributed = 0;
  for (const e of (Array.isArray(body.events) ? body.events : []).slice(0, 500)) {
    if (!e.event_id || !e.event_name) continue;
    const assistant = (e.assistant && /^[a-z_]{2,20}$/.test(e.assistant) ? e.assistant : null) ?? classifyReferral(e.referrer, e.utm_source);
    if (!assistant) {
      unattributed++;
      continue;
    }
    const seen = await tdb.run("INSERT OR IGNORE INTO conversion_events_seen (tenant_id, event_id) VALUES (?1, ?2)", String(e.event_id).slice(0, 200));
    if (!seen.meta.changes) {
      duplicates++;
      continue;
    }
    const source = SOURCES.has(String(e.source)) ? String(e.source) : "sgtm";
    await tdb.run(
      `INSERT INTO conversion_daily (tenant_id, project_id, day, path, assistant, source, event_name, conversions, value_micros, currency)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9)
       ON CONFLICT(tenant_id, project_id, day, path, assistant, source, event_name)
       DO UPDATE SET conversions = conversions + 1, value_micros = value_micros + excluded.value_micros`,
      projectId,
      dayOf(e.ts),
      normalizePath(String(e.landing_path ?? "/").split("?")[0]),
      assistant,
      source,
      String(e.event_name).slice(0, 60),
      Math.round(Math.max(0, Number(e.value) || 0) * 1_000_000),
      String(e.currency ?? "USD").slice(0, 3).toUpperCase(),
    );
    kept++;
  }
  return { kept, duplicates, unattributed };
}
