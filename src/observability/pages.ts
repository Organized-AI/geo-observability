import type { TenantDB } from "../lib/db";
import { Binds, domainMatch } from "../metrics/filters";
import type { BrandInfo } from "../metrics/report";

/**
 * The Pages table: one row per URL path on the client's own domains, joining
 *   answers that cite the page (tracked prompts) → AI bots that fetched it → people who arrived from an
 *   assistant → conversions and revenue from those sessions,
 * plus the prompts whose answers cited it. Linking sessions to prompts is by landing page and range,
 * which is an approximation: assistants don't pass the prompt along.
 */
export async function pagesReport(tdb: TenantDB, projectId: string, from: string, to: string, own: BrandInfo | undefined) {
  const domains = own?.domains ?? [];
  const b = new Binds();
  const pid = b.add(projectId);
  const f = b.add(from);
  const t = b.add(to);
  const match = domainMatch(b, "c.domain", domains);
  const cited = await tdb.all<{ path: string; citations: number; cited_answers: number }>(
    `SELECT c.path, COUNT(*) AS citations, COUNT(DISTINCT c.run_id) AS cited_answers
     FROM citations c JOIN runs ON runs.id = c.run_id AND runs.tenant_id = ?1
     WHERE +c.tenant_id = ?1 AND runs.project_id = ${pid} AND runs.status = 'done' AND runs.run_date BETWEEN ${f} AND ${t} AND ${match}
     GROUP BY c.path`,
    ...b.values,
  );
  const total = await tdb.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM runs WHERE tenant_id = ?1 AND project_id = ?2 AND status = 'done' AND run_date BETWEEN ?3 AND ?4",
    projectId,
    from,
    to,
  );
  const crawl = await tdb.all<{ path: string; bot_type: string; hits: number }>(
    "SELECT path, bot_type, SUM(hits) AS hits FROM crawl_daily WHERE tenant_id = ?1 AND project_id = ?2 AND day BETWEEN ?3 AND ?4 GROUP BY path, bot_type",
    projectId,
    from,
    to,
  );
  const refs = await tdb.all<{ path: string; sessions: number }>(
    "SELECT path, SUM(sessions) AS sessions FROM referral_daily WHERE tenant_id = ?1 AND project_id = ?2 AND day BETWEEN ?3 AND ?4 GROUP BY path",
    projectId,
    from,
    to,
  );
  const conv = await tdb.all<{ path: string; conversions: number; value: number }>(
    "SELECT path, SUM(conversions) AS conversions, SUM(value_micros) AS value FROM conversion_daily WHERE tenant_id = ?1 AND project_id = ?2 AND day BETWEEN ?3 AND ?4 GROUP BY path",
    projectId,
    from,
    to,
  );
  const b2 = new Binds();
  const pid2 = b2.add(projectId);
  const f2 = b2.add(from);
  const t2 = b2.add(to);
  const match2 = domainMatch(b2, "c.domain", domains);
  const promptLinks = await tdb.all<{ path: string; prompt_id: string; text: string; citations: number }>(
    `SELECT c.path, p.id AS prompt_id, p.text, COUNT(*) AS citations
     FROM citations c JOIN runs ON runs.id = c.run_id AND runs.tenant_id = ?1 JOIN prompts p ON p.id = runs.prompt_id AND p.tenant_id = ?1
     WHERE +c.tenant_id = ?1 AND runs.project_id = ${pid2} AND runs.status = 'done' AND runs.run_date BETWEEN ${f2} AND ${t2} AND ${match2}
     GROUP BY c.path, p.id ORDER BY citations DESC`,
    ...b2.values,
  );

  const paths = new Set<string>([...cited, ...crawl, ...refs, ...conv].map((r) => r.path));
  const answers = total?.n ?? 0;
  const items = [...paths].map((path) => {
    const c = cited.find((x) => x.path === path);
    const cr = crawl.filter((x) => x.path === path);
    const hit = (type: string) => cr.filter((x) => x.bot_type === type).reduce((a, x) => a + x.hits, 0);
    const r = refs.find((x) => x.path === path);
    const cv = conv.find((x) => x.path === path);
    return {
      path,
      bot_hits: cr.reduce((a, x) => a + x.hits, 0),
      training_hits: hit("training"),
      search_hits: hit("search"),
      retrievals: hit("user"),
      citations: c?.citations ?? 0,
      cited_answers: c?.cited_answers ?? 0,
      citation_rate: answers ? (c?.cited_answers ?? 0) / answers : 0,
      sessions: r?.sessions ?? 0,
      conversions: cv?.conversions ?? 0,
      revenue_micros: cv?.value ?? 0,
      prompts: promptLinks.filter((p) => p.path === path).slice(0, 8).map(({ path: _p, ...rest }) => rest),
    };
  });
  items.sort((a, b) => b.revenue_micros - a.revenue_micros || b.cited_answers - a.cited_answers || b.sessions - a.sessions || b.bot_hits - a.bot_hits);
  const sum = (k: keyof (typeof items)[number]) => items.reduce((a, i) => a + (i[k] as number), 0);
  return {
    items: items.slice(0, 500),
    totals: {
      bot_hits: sum("bot_hits"),
      training_hits: sum("training_hits"),
      search_hits: sum("search_hits"),
      retrievals: sum("retrievals"),
      citations: sum("citations"),
      cited_answers: sum("cited_answers"),
      citation_rate: answers ? sum("cited_answers") / answers : 0,
      sessions: sum("sessions"),
      conversions: sum("conversions"),
      revenue_micros: sum("revenue_micros"),
    },
  };
}

export async function crawlerReport(tdb: TenantDB, projectId: string, from: string, to: string) {
  const byBot = await tdb.all<{ bot: string; operator: string; bot_type: string; hits: number }>(
    `SELECT bot, operator, bot_type, SUM(hits) AS hits FROM crawl_daily WHERE tenant_id = ?1 AND project_id = ?2 AND day BETWEEN ?3 AND ?4
     GROUP BY bot ORDER BY hits DESC`,
    projectId,
    from,
    to,
  );
  const trend = await tdb.all<{ day: string; bot_type: string; hits: number }>(
    `SELECT day, bot_type, SUM(hits) AS hits FROM crawl_daily WHERE tenant_id = ?1 AND project_id = ?2 AND day BETWEEN ?3 AND ?4
     GROUP BY day, bot_type ORDER BY day`,
    projectId,
    from,
    to,
  );
  return { by_bot: byBot, trend };
}

export async function referralReport(tdb: TenantDB, projectId: string, from: string, to: string) {
  const sessions = await tdb.all<{ assistant: string; sessions: number }>(
    "SELECT assistant, SUM(sessions) AS sessions FROM referral_daily WHERE tenant_id = ?1 AND project_id = ?2 AND day BETWEEN ?3 AND ?4 GROUP BY assistant",
    projectId,
    from,
    to,
  );
  const conv = await tdb.all<{ assistant: string; conversions: number; value: number }>(
    "SELECT assistant, SUM(conversions) AS conversions, SUM(value_micros) AS value FROM conversion_daily WHERE tenant_id = ?1 AND project_id = ?2 AND day BETWEEN ?3 AND ?4 GROUP BY assistant",
    projectId,
    from,
    to,
  );
  const assistants = new Set([...sessions, ...conv].map((r) => r.assistant));
  const trend = await tdb.all<{ day: string; assistant: string; sessions: number }>(
    "SELECT day, assistant, SUM(sessions) AS sessions FROM referral_daily WHERE tenant_id = ?1 AND project_id = ?2 AND day BETWEEN ?3 AND ?4 GROUP BY day, assistant ORDER BY day",
    projectId,
    from,
    to,
  );
  return {
    by_assistant: [...assistants]
      .map((a) => ({
        assistant: a,
        sessions: sessions.find((s) => s.assistant === a)?.sessions ?? 0,
        conversions: conv.find((c) => c.assistant === a)?.conversions ?? 0,
        revenue_micros: conv.find((c) => c.assistant === a)?.value ?? 0,
      }))
      .sort((a, b) => b.sessions - a.sessions),
    trend,
  };
}
