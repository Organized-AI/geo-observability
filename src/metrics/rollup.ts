import type { Env } from "../env";
import { TenantDB } from "../lib/db";
import { addDays, today } from "../lib/util";
import { loadBrands } from "./report";
import { domainMatch, Binds } from "./filters";

/**
 * Materialises daily_brand_metrics for one project and day: one row per brand × engine × country × topic.
 * Reports read raw facts so every filter works; this table feeds insights, the public API's fast path
 * and anything that wants long ranges cheaply.
 */
export async function rollupDay(env: Env, tenantId: string, projectId: string, day: string): Promise<void> {
  const tdb = new TenantDB(env.DB, tenantId);
  await tdb.batch([
    tdb.prepare("DELETE FROM daily_brand_metrics WHERE tenant_id = ?1 AND project_id = ?2 AND day = ?3", projectId, day),
    tdb.prepare(
      `INSERT INTO daily_brand_metrics
        (tenant_id, project_id, day, brand_id, engine, country, topic_id, answers, mentioned, mentions_all, rank_sum, sentiment_sum, sentiment_n, wins, contests, cited)
       WITH r AS (
         SELECT runs.id, runs.engine, runs.country, COALESCE(p.topic_id, '') AS topic_id
         FROM runs JOIN prompts p ON p.id = runs.prompt_id AND p.tenant_id = ?1
         WHERE runs.tenant_id = ?1 AND runs.project_id = ?2 AND runs.run_date = ?3 AND runs.status = 'done'),
       slice AS (SELECT engine, country, topic_id, COUNT(*) AS answers FROM r GROUP BY engine, country, topic_id),
       tm AS (SELECT m.run_id, m.brand_id, m.rank, m.sentiment, r.engine, r.country, r.topic_id
              FROM mentions m JOIN r ON r.id = m.run_id JOIN brands b ON b.id = m.brand_id AND b.status = 'active'
              WHERE m.tenant_id = ?1),
       agg AS (SELECT run_id, MIN(rank) AS min_rank, COUNT(*) AS n FROM tm GROUP BY run_id),
       per AS (SELECT tm.brand_id, tm.engine, tm.country, tm.topic_id, COUNT(*) AS mentioned, SUM(tm.rank) AS rank_sum,
                      SUM(COALESCE(tm.sentiment, 0)) AS sentiment_sum, COUNT(tm.sentiment) AS sentiment_n,
                      SUM(CASE WHEN agg.n >= 2 AND tm.rank = agg.min_rank THEN 1 ELSE 0 END) AS wins,
                      SUM(CASE WHEN agg.n >= 2 THEN 1 ELSE 0 END) AS contests
               FROM tm JOIN agg ON agg.run_id = tm.run_id GROUP BY tm.brand_id, tm.engine, tm.country, tm.topic_id),
       allm AS (SELECT engine, country, topic_id, COUNT(*) AS c FROM tm GROUP BY engine, country, topic_id)
       SELECT ?1, ?2, ?3, b.id, s.engine, s.country, s.topic_id, s.answers,
              COALESCE(per.mentioned, 0), COALESCE(allm.c, 0), COALESCE(per.rank_sum, 0),
              COALESCE(per.sentiment_sum, 0), COALESCE(per.sentiment_n, 0), COALESCE(per.wins, 0), COALESCE(per.contests, 0), 0
       FROM slice s
       CROSS JOIN brands b
       LEFT JOIN per ON per.brand_id = b.id AND per.engine = s.engine AND per.country = s.country AND per.topic_id = s.topic_id
       LEFT JOIN allm ON allm.engine = s.engine AND allm.country = s.country AND allm.topic_id = s.topic_id
       WHERE b.tenant_id = ?1 AND b.project_id = ?2 AND b.status = 'active'`,
      projectId,
      day,
    ),
  ]);
  // Cited: answers in the slice that cite one of the brand's domains.
  for (const br of await loadBrands(tdb, projectId)) {
    if (!br.domains.length) continue;
    const b = new Binds();
    const pid = b.add(projectId);
    const d = b.add(day);
    const bid = b.add(br.id);
    const match = domainMatch(b, "c.domain", br.domains);
    await tdb.run(
      `UPDATE daily_brand_metrics SET cited = (
         SELECT COUNT(DISTINCT c.run_id) FROM citations c JOIN runs ON runs.id = c.run_id AND runs.tenant_id = ?1
         JOIN prompts p ON p.id = runs.prompt_id AND p.tenant_id = ?1
         WHERE c.tenant_id = ?1 AND c.kind = 'cited' AND runs.project_id = ${pid} AND runs.run_date = ${d} AND runs.status = 'done'
           AND runs.engine = daily_brand_metrics.engine AND runs.country = daily_brand_metrics.country
           AND COALESCE(p.topic_id, '') = daily_brand_metrics.topic_id AND ${match})
       WHERE tenant_id = ?1 AND project_id = ${pid} AND day = ${d} AND brand_id = ${bid}`,
      ...b.values,
    );
  }
}

/** Hourly cron: refresh today's and yesterday's rollups for every project that ran. */
export async function rollupRecent(env: Env, now = new Date()): Promise<number> {
  const days = [today(now), addDays(today(now), -1)];
  const rows = await env.DB.prepare(
    `SELECT DISTINCT tenant_id, project_id, run_date FROM runs WHERE run_date IN (?1, ?2) AND status = 'done'`,
  )
    .bind(days[0], days[1])
    .all<{ tenant_id: string; project_id: string; run_date: string }>();
  for (const r of rows.results ?? []) await rollupDay(env, r.tenant_id, r.project_id, r.run_date);
  // Keep the query planner's statistics fresh so report joins pick the right indexes.
  await env.DB.exec("PRAGMA optimize").catch(() => undefined);
  return rows.results?.length ?? 0;
}
