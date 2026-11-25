/**
 * Retention: traces are kept for one quarter, then deleted with their spans. People who need them for longer
 * export them first (see src/tracing/export.ts). A calendar quarter is at most 92 days, so that is the window.
 */
import type { Env } from "../env";
import { TenantDB } from "../lib/db";
import { chunk } from "../lib/util";
import { deleteBodies } from "./body";

export const DEFAULT_RETENTION_DAYS = 92;
const DAY_MS = 86_400_000;

export function retentionDays(env: Pick<Env, "TRACE_RETENTION_DAYS">): number {
  const n = Number(env.TRACE_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 && n <= 3660 ? Math.floor(n) : DEFAULT_RETENTION_DAYS;
}

export const cutoffMs = (env: Pick<Env, "TRACE_RETENTION_DAYS">, now = Date.now()) => now - retentionDays(env) * DAY_MS;

/** Deletes up to `maxTraces` expired traces of one workspace, oldest first. Returns how many traces went. */
export async function pruneTenant(tdb: TenantDB, cutoff: number, maxTraces = 2000, env?: Pick<Env, "ANSWERS">): Promise<number> {
  let removed = 0;
  while (removed < maxTraces) {
    const rows = await tdb.all<{ trace_id: string }>("SELECT trace_id FROM llm_traces WHERE tenant_id = ?1 AND start_ms < ?2 ORDER BY start_ms LIMIT 400", cutoff);
    if (!rows.length) break;
    for (const ids of chunk(rows.map((r) => r.trace_id), 40)) {
      const marks = ids.map((_, i) => `?${i + 2}`).join(", ");
      if (env) await deleteBodies(env, tdb, ids);
      await tdb.batch([
        tdb.prepare(`DELETE FROM llm_spans WHERE tenant_id = ?1 AND trace_id IN (${marks})`, ...ids),
        tdb.prepare(`DELETE FROM llm_traces WHERE tenant_id = ?1 AND trace_id IN (${marks})`, ...ids),
      ]);
    }
    removed += rows.length;
    if (rows.length < 400) break;
  }
  return removed;
}

/** Hourly: every workspace that has traces loses the ones older than the retention window. */
export async function pruneTraces(env: Env, now = new Date()): Promise<number> {
  const cutoff = cutoffMs(env, now.getTime());
  // Workspace ids only; each workspace's rows are then read and deleted through TenantDB.
  const tenants = await env.DB.prepare("SELECT DISTINCT tenant_id FROM trace_apps").all<{ tenant_id: string }>();
  let removed = 0;
  for (const t of tenants.results ?? []) {
    try {
      removed += await pruneTenant(new TenantDB(env.DB, t.tenant_id), cutoff, 2000, env);
    } catch (err) {
      console.error("trace_prune_failed", t.tenant_id, String(err));
    }
  }
  return removed;
}

/** What the portal shows: the window, and how much is about to go. */
export async function retentionStatus(tdb: TenantDB, env: Pick<Env, "TRACE_RETENTION_DAYS">, now = Date.now()) {
  const days = retentionDays(env);
  const cutoff = now - days * DAY_MS;
  const soon = cutoff + 14 * DAY_MS;
  const row = await tdb.first<{ oldest_ms: number | null; expiring: number; total: number }>(
    "SELECT MIN(start_ms) AS oldest_ms, COALESCE(SUM(start_ms < ?2), 0) AS expiring, COUNT(*) AS total FROM llm_traces WHERE tenant_id = ?1",
    soon,
  );
  return { days, oldest_ms: row?.oldest_ms ?? null, traces: row?.total ?? 0, expiring_in_14_days: row?.expiring ?? 0, expiring_before_ms: soon };
}
