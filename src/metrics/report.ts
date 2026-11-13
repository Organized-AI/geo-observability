import type { BrandRow, TenantDB } from "../lib/db";
import type { BrandMatcher } from "../judge/mentions";
import { parseJson } from "../lib/util";
import { Binds, domainMatch, previousPeriod, runsCte, type Filters } from "./filters";

export interface BrandInfo extends BrandMatcher {
  color: string | null;
  status: string;
}

const PALETTE = ["#0E8A7E", "#C2562F", "#5B5BD6", "#B5871C", "#2F7FC2", "#A04A8E", "#5E8C2E", "#7A6A58", "#C23B5A", "#3C8F9E"];

export async function loadBrands(tdb: TenantDB, projectId: string, statuses = ["active"]): Promise<BrandInfo[]> {
  const b = new Binds();
  const rows = await tdb.all<BrandRow>(
    `SELECT * FROM brands WHERE tenant_id = ?1 AND project_id = ${b.add(projectId)} AND status IN (${b.list(statuses)})
     ORDER BY is_own DESC, created_at ASC`,
    ...b.values,
  );
  return rows.map((r, i) => ({
    id: r.id,
    name: r.name,
    aliases: parseJson<string[]>(r.aliases, []),
    regex: r.regex,
    domains: parseJson<string[]>(r.domains, []).map((d) => d.toLowerCase().replace(/^www\./, "")),
    isOwn: !!r.is_own,
    color: r.color ?? PALETTE[i % PALETTE.length],
    status: r.status,
  }));
}

export interface BrandMetric {
  brand_id: string;
  answers: number;
  mentioned: number;
  visibility: number;
  share_of_voice: number;
  position: number | null;
  sentiment: number | null;
  win_rate: number | null;
  cited_rate: number;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);

export async function brandMetrics(tdb: TenantDB, projectId: string, f: Filters, brands: BrandInfo[]): Promise<BrandMetric[]> {
  const b = new Binds();
  const cte = runsCte(b, projectId, f);
  const ids = brands.map((x) => x.id);
  if (!ids.length) return [];
  const idList = b.list(ids);
  const [totals] = await tdb.all<{ answers: number; mentions_all: number }>(
    `WITH ${cte}
     SELECT (SELECT COUNT(*) FROM r) AS answers,
            (SELECT COUNT(*) FROM r CROSS JOIN mentions m ON m.run_id = r.id WHERE m.tenant_id = ?1 AND m.brand_id IN (${idList})) AS mentions_all`,
    ...b.values,
  );
  const per = await tdb.all<{ brand_id: string; mentioned: number; rank_sum: number; sent: number | null }>(
    `WITH ${cte}
     SELECT m.brand_id, COUNT(*) AS mentioned, SUM(m.rank) AS rank_sum, AVG(m.sentiment) AS sent
     FROM r CROSS JOIN mentions m ON m.run_id = r.id
     WHERE m.tenant_id = ?1 AND m.brand_id IN (${idList})
     GROUP BY m.brand_id`,
    ...b.values,
  );
  // Win rate: in answers naming at least two tracked brands, how often this brand is named first among them.
  const wins = await tdb.all<{ brand_id: string; wins: number; contests: number }>(
    `WITH ${cte},
     tracked AS MATERIALIZED (SELECT m.run_id, m.brand_id, m.rank FROM r CROSS JOIN mentions m ON m.run_id = r.id
                 WHERE m.tenant_id = ?1 AND m.brand_id IN (${idList})),
     agg AS (SELECT run_id, MIN(rank) AS min_rank, COUNT(*) AS n FROM tracked GROUP BY run_id)
     SELECT t.brand_id, SUM(CASE WHEN t.rank = agg.min_rank THEN 1 ELSE 0 END) AS wins, COUNT(*) AS contests
     FROM tracked t JOIN agg ON agg.run_id = t.run_id WHERE agg.n >= 2 GROUP BY t.brand_id`,
    ...b.values,
  );
  // Answers citing each brand's domains: one query, matched to brands here.
  const bc = new Binds();
  const citedRows = await tdb.all<{ run_id: string; domain: string }>(
    `WITH ${runsCte(bc, projectId, f)} SELECT DISTINCT c.run_id, c.domain FROM r CROSS JOIN citations c ON c.run_id = r.id WHERE +c.tenant_id = ?1 AND c.kind = 'cited'`,
    ...bc.values,
  );
  const owns = (br: BrandInfo, d: string) => br.domains.some((x) => d === x || d.endsWith(`.${x}`));
  const out: BrandMetric[] = [];
  for (const br of brands) {
    const p = per.find((x) => x.brand_id === br.id);
    const w = wins.find((x) => x.brand_id === br.id);
    const citedRuns = br.domains.length ? new Set(citedRows.filter((r) => owns(br, r.domain)).map((r) => r.run_id)).size : 0;
    const answers = totals?.answers ?? 0;
    const mentioned = p?.mentioned ?? 0;
    out.push({
      brand_id: br.id,
      answers,
      mentioned,
      visibility: ratio(mentioned, answers),
      share_of_voice: ratio(mentioned, totals?.mentions_all ?? 0),
      position: mentioned ? (p!.rank_sum ?? 0) / mentioned : null,
      sentiment: p?.sent === null || p?.sent === undefined ? null : Math.round(p.sent * 10) / 10,
      win_rate: w && w.contests ? w.wins / w.contests : null,
      cited_rate: ratio(citedRuns, answers),
    });
  }
  return out;
}

export async function trend(tdb: TenantDB, projectId: string, f: Filters, brands: BrandInfo[]) {
  const b = new Binds();
  const cte = runsCte(b, projectId, f);
  if (!brands.length) return [];
  const bd = new Binds();
  const days = await tdb.all<{ run_date: string; answers: number }>(
    `WITH ${runsCte(bd, projectId, f)} SELECT run_date, COUNT(*) AS answers FROM r GROUP BY run_date ORDER BY run_date`,
    ...bd.values,
  );
  const idList = b.list(brands.map((x) => x.id));
  const rows = await tdb.all<{ run_date: string; brand_id: string; mentioned: number; rank_sum: number; sent: number | null }>(
    `WITH ${cte}
     SELECT r.run_date, m.brand_id, COUNT(*) AS mentioned, SUM(m.rank) AS rank_sum, AVG(m.sentiment) AS sent
     FROM r CROSS JOIN mentions m ON m.run_id = r.id WHERE m.tenant_id = ?1 AND m.brand_id IN (${idList})
     GROUP BY r.run_date, m.brand_id`,
    ...b.values,
  );
  const allByDay = new Map<string, number>();
  for (const r of rows) allByDay.set(r.run_date, (allByDay.get(r.run_date) ?? 0) + r.mentioned);
  const out: { day: string; brand_id: string; visibility: number; share_of_voice: number; position: number | null; sentiment: number | null }[] = [];
  for (const d of days) {
    for (const br of brands) {
      const r = rows.find((x) => x.run_date === d.run_date && x.brand_id === br.id);
      out.push({
        day: d.run_date,
        brand_id: br.id,
        visibility: ratio(r?.mentioned ?? 0, d.answers),
        share_of_voice: ratio(r?.mentioned ?? 0, allByDay.get(d.run_date) ?? 0),
        position: r?.mentioned ? r.rank_sum / r.mentioned : null,
        sentiment: r?.sent ?? null,
      });
    }
  }
  return out;
}

export async function byEngine(tdb: TenantDB, projectId: string, f: Filters, ownBrandId: string | null) {
  const b = new Binds();
  const cte = runsCte(b, projectId, f);
  const own = b.add(ownBrandId ?? "");
  return tdb.all<{ engine: string; answers: number; mentioned: number; visibility: number }>(
    `WITH ${cte},
     ownr AS MATERIALIZED (SELECT DISTINCT m.run_id FROM r CROSS JOIN mentions m ON m.run_id = r.id WHERE m.tenant_id = ?1 AND m.brand_id = ${own})
     SELECT r.engine, COUNT(*) AS answers, COUNT(ownr.run_id) AS mentioned, CAST(COUNT(ownr.run_id) AS REAL) / COUNT(*) AS visibility
     FROM r LEFT JOIN ownr ON ownr.run_id = r.id GROUP BY r.engine ORDER BY r.engine`,
    ...b.values,
  );
}

export async function domainReport(tdb: TenantDB, projectId: string, f: Filters, brands: BrandInfo[], opts: { gap?: boolean; limit?: number } = {}) {
  const b = new Binds();
  const cte = runsCte(b, projectId, f);
  const own = brands.find((x) => x.isOwn);
  const pid = b.add(projectId);
  const ownId = b.add(own?.id ?? "");
  const compIds = brands.filter((x) => !x.isOwn).map((x) => x.id);
  const compList = compIds.length ? b.list(compIds) : "''";
  // Materialised CTEs keep this to a few hash joins instead of a correlated subquery per domain.
  const withSql = `WITH ${cte},
     cit AS MATERIALIZED (SELECT c.run_id, c.domain FROM r CROSS JOIN citations c ON c.run_id = r.id WHERE +c.tenant_id = ?1),
     ownr AS MATERIALIZED (SELECT DISTINCT m.run_id FROM r CROSS JOIN mentions m ON m.run_id = r.id WHERE m.tenant_id = ?1 AND m.brand_id = ${ownId}),
     compr AS MATERIALIZED (SELECT DISTINCT m.run_id, m.brand_id FROM r CROSS JOIN mentions m ON m.run_id = r.id WHERE m.tenant_id = ?1 AND m.brand_id IN (${compList}))`;
  const rows = await tdb.all<{ domain: string; type: string | null; citations: number; answers: number; own_answers: number }>(
    `${withSql}
     SELECT cit.domain, dc.type, COUNT(*) AS citations, COUNT(DISTINCT cit.run_id) AS answers,
            COUNT(DISTINCT ownr.run_id) AS own_answers
     FROM cit LEFT JOIN ownr ON ownr.run_id = cit.run_id
     LEFT JOIN domain_classes dc ON dc.tenant_id = ?1 AND dc.project_id = ${pid} AND dc.domain = cit.domain
     GROUP BY cit.domain`,
    ...b.values,
  );
  const comp = await tdb.all<{ domain: string; brand_id: string; answers: number }>(
    `${withSql}
     SELECT cit.domain, compr.brand_id, COUNT(DISTINCT cit.run_id) AS answers FROM cit JOIN compr ON compr.run_id = cit.run_id
     GROUP BY cit.domain, compr.brand_id`,
    ...b.values.slice(0, b.values.length),
  ).catch(() => [] as { domain: string; brand_id: string; answers: number }[]);
  const b3 = new Binds();
  const total = (await tdb.first<{ total: number }>(`WITH ${runsCte(b3, projectId, f)} SELECT COUNT(*) AS total FROM r`, ...b3.values))?.total ?? 0;
  const nameOf = new Map(brands.map((x) => [x.id, x.name]));
  const items = rows.map((r) => {
    const cs = comp.filter((c) => c.domain === r.domain);
    return {
      domain: r.domain,
      type: r.type ?? "other",
      citations: r.citations,
      answers: r.answers,
      share: total ? r.answers / total : 0,
      mentions_own: r.own_answers > 0,
      competitors: cs.sort((a, c) => c.answers - a.answers).map((c) => nameOf.get(c.brand_id) ?? "").filter(Boolean),
      _comp: cs.length > 0,
    };
  });
  items.sort((a, c) => c.answers - a.answers || c.citations - a.citations);
  const filtered = opts.gap ? items.filter((i) => !i.mentions_own && i._comp) : items;
  return filtered.slice(0, Math.min(opts.limit ?? 100, 500)).map(({ _comp, ...rest }) => rest);
}

export async function urlReport(tdb: TenantDB, projectId: string, f: Filters, domain?: string) {
  const b = new Binds();
  const cte = runsCte(b, projectId, f);
  const dom = domain ? `AND c.domain = ${b.add(domain.toLowerCase())}` : "";
  return tdb.all<{ url: string; domain: string; title: string | null; citations: number; answers: number; cited: number; used: number; first_seen: string; last_seen: string }>(
    `WITH ${cte}
     SELECT c.url, c.domain, MAX(c.title) AS title, COUNT(*) AS citations, COUNT(DISTINCT c.run_id) AS answers,
            SUM(CASE WHEN c.kind = 'cited' THEN 1 ELSE 0 END) AS cited, SUM(CASE WHEN c.kind = 'used' THEN 1 ELSE 0 END) AS used,
            MIN(r.run_date) AS first_seen, MAX(r.run_date) AS last_seen
     FROM r CROSS JOIN citations c ON c.run_id = r.id WHERE +c.tenant_id = ?1 ${dom}
     GROUP BY c.url ORDER BY answers DESC LIMIT 300`,
    ...b.values,
  );
}

export async function promptPerformance(tdb: TenantDB, projectId: string, f: Filters, ownBrandId: string | null) {
  const b = new Binds();
  const cte = runsCte(b, projectId, f);
  const own = b.add(ownBrandId ?? "");
  const rows = await tdb.all<{ prompt_id: string; text: string; topic: string | null; answers: number; mentioned: number; rank_sum: number | null; sent: number | null }>(
    `WITH ${cte},
     om AS MATERIALIZED (SELECT m.run_id, m.rank, m.sentiment FROM r CROSS JOIN mentions m ON m.run_id = r.id WHERE m.tenant_id = ?1 AND m.brand_id = ${own})
     SELECT r.prompt_id, p.text, t.name AS topic, COUNT(*) AS answers, COUNT(om.run_id) AS mentioned,
            SUM(om.rank) AS rank_sum, AVG(om.sentiment) AS sent
     FROM r JOIN prompts p ON p.id = r.prompt_id AND p.tenant_id = ?1
     LEFT JOIN topics t ON t.id = p.topic_id AND t.tenant_id = ?1
     LEFT JOIN om ON om.run_id = r.id
     GROUP BY r.prompt_id ORDER BY CAST(COUNT(om.run_id) AS REAL) / COUNT(*) ASC, p.text`,
    ...b.values,
  );
  const perEngine = await tdb.all<{ prompt_id: string; engine: string; answers: number; mentioned: number }>(
    `WITH ${cte},
     ownr AS MATERIALIZED (SELECT DISTINCT m.run_id FROM r CROSS JOIN mentions m ON m.run_id = r.id WHERE m.tenant_id = ?1 AND m.brand_id = ${own})
     SELECT r.prompt_id, r.engine, COUNT(*) AS answers, COUNT(ownr.run_id) AS mentioned
     FROM r LEFT JOIN ownr ON ownr.run_id = r.id GROUP BY r.prompt_id, r.engine`,
    ...b.values,
  );
  return rows.map((r) => {
    const engines = perEngine.filter((e) => e.prompt_id === r.prompt_id).map((e) => ({ engine: e.engine, v: ratio(e.mentioned, e.answers) }));
    engines.sort((a, c) => c.v - a.v);
    return {
      prompt_id: r.prompt_id,
      text: r.text,
      topic: r.topic,
      answers: r.answers,
      visibility: ratio(r.mentioned, r.answers),
      position: r.mentioned ? (r.rank_sum ?? 0) / r.mentioned : null,
      sentiment: r.sent === null ? null : Math.round(r.sent),
      best_engine: engines[0]?.engine ?? null,
      worst_engine: engines.length > 1 ? engines[engines.length - 1].engine : null,
    };
  });
}

export async function chats(
  tdb: TenantDB,
  projectId: string,
  f: Filters,
  opts: { ownBrandId: string | null; mentioned?: "own" | "not_own"; limit?: number; cursor?: string },
) {
  const b = new Binds();
  const cte = runsCte(b, projectId, f);
  const where: string[] = [];
  if (opts.mentioned === "own") where.push(`EXISTS (SELECT 1 FROM mentions m WHERE m.run_id = r.id AND m.tenant_id = ?1 AND m.brand_id = ${b.add(opts.ownBrandId ?? "")})`);
  if (opts.mentioned === "not_own") where.push(`NOT EXISTS (SELECT 1 FROM mentions m WHERE m.run_id = r.id AND m.tenant_id = ?1 AND m.brand_id = ${b.add(opts.ownBrandId ?? "")})`);
  if (opts.cursor) where.push(`(r.run_date || '|' || r.id) < ${b.add(opts.cursor)}`);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await tdb.all<{ id: string; run_date: string; engine: string; country: string; prompt_id: string; prompt: string; model: string; channel: string; excerpt: string; citations_count: number }>(
    `WITH ${cte}
     SELECT r.id, r.run_date, r.engine, r.country, r.prompt_id, p.text AS prompt, ru.model, ru.channel, ru.answer_excerpt AS excerpt,
            (SELECT COUNT(*) FROM citations c WHERE c.run_id = r.id AND c.tenant_id = ?1) AS citations_count
     FROM r JOIN prompts p ON p.id = r.prompt_id AND p.tenant_id = ?1 JOIN runs ru ON ru.id = r.id AND ru.tenant_id = ?1
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY r.run_date DESC, r.id DESC LIMIT ${b.add(limit + 1)}`,
    ...b.values,
  );
  const page = rows.slice(0, limit);
  const mentions = page.length
    ? await tdb.all<{ run_id: string; brand_id: string; brand_name: string; rank: number; sentiment: number }>(
        `SELECT run_id, brand_id, brand_name, rank, sentiment FROM mentions WHERE tenant_id = ?1 AND run_id IN (${page.map((_, i) => `?${i + 2}`).join(",")}) ORDER BY rank`,
        ...page.map((p) => p.id),
      )
    : [];
  return {
    items: page.map((r) => ({
      run_id: r.id,
      prompt_id: r.prompt_id,
      prompt: r.prompt,
      engine: r.engine,
      model: r.model,
      country: r.country,
      run_date: r.run_date,
      channel: r.channel,
      mentions: mentions.filter((m) => m.run_id === r.id).map(({ run_id, ...m }) => m),
      citations_count: r.citations_count,
      excerpt: r.excerpt,
    })),
    next_cursor: rows.length > limit ? `${page[page.length - 1].run_date}|${page[page.length - 1].id}` : null,
  };
}

export async function overview(tdb: TenantDB, projectId: string, f: Filters) {
  const brands = await loadBrands(tdb, projectId);
  const own = brands.find((b) => b.isOwn) ?? null;
  const prev = previousPeriod(f);
  const [cur, before] = await Promise.all([brandMetrics(tdb, projectId, f, brands), brandMetrics(tdb, projectId, prev, brands)]);
  const ownCur = own ? cur.find((m) => m.brand_id === own.id) : undefined;
  const ownPrev = own ? before.find((m) => m.brand_id === own.id) : undefined;
  const kpi = (k: keyof BrandMetric) => ({ value: (ownCur?.[k] as number | null) ?? null, prev: (ownPrev?.[k] as number | null) ?? null });

  const leaderboard = cur
    .map((m) => {
      const br = brands.find((b) => b.id === m.brand_id)!;
      return {
        brand_id: m.brand_id,
        name: br.name,
        is_own: br.isOwn,
        color: br.color,
        visibility: m.visibility,
        share_of_voice: m.share_of_voice,
        position: m.position,
        sentiment: m.sentiment,
        win_rate: m.win_rate,
      };
    })
    .sort((a, b) => b.visibility - a.visibility);
  const trendBrands = [own, ...leaderboard.filter((l) => !l.is_own).slice(0, 4).map((l) => brands.find((b) => b.id === l.brand_id)!)].filter(
    (x): x is BrandInfo => !!x,
  );
  const [tr, engines, sources, recent] = await Promise.all([
    trend(tdb, projectId, f, trendBrands),
    byEngine(tdb, projectId, f, own?.id ?? null),
    domainReport(tdb, projectId, f, brands, { limit: 8 }),
    chats(tdb, projectId, f, { ownBrandId: own?.id ?? null, limit: 6 }),
  ]);
  const insights = await tdb.all<{ id: string; day: string; kind: string; severity: number; text: string; evidence: string }>(
    `SELECT id, day, kind, severity, text, evidence FROM insights WHERE tenant_id = ?1 AND project_id = ?2
     AND day = (SELECT MAX(day) FROM insights WHERE tenant_id = ?1 AND project_id = ?2) ORDER BY severity DESC LIMIT 5`,
    projectId,
  );
  const actions = await tdb.all<{ id: string; kind: string; title: string; impact: number; status: string }>(
    `SELECT id, kind, title, impact, status FROM actions WHERE tenant_id = ?1 AND project_id = ?2 AND status IN ('open','in_progress')
     ORDER BY impact DESC, created_at DESC LIMIT 5`,
    projectId,
  );
  const labels: Record<string, string> = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", perplexity: "Perplexity", alexa: "Alexa" };
  return {
    range: { from: f.from, to: f.to, prev_from: prev.from, prev_to: prev.to },
    own_brand_id: own?.id ?? null,
    kpis: {
      visibility: kpi("visibility"),
      share_of_voice: kpi("share_of_voice"),
      position: kpi("position"),
      sentiment: kpi("sentiment"),
      win_rate: kpi("win_rate"),
      cited_rate: kpi("cited_rate"),
      answers: { value: ownCur?.answers ?? cur[0]?.answers ?? 0, prev: ownPrev?.answers ?? before[0]?.answers ?? 0 },
    },
    trend: tr,
    leaderboard,
    by_engine: engines.map((e) => ({ engine: e.engine, label: labels[e.engine] ?? e.engine, visibility: e.visibility, answers: e.answers })),
    top_sources: sources,
    recent_chats: recent.items.map((c) => {
      const m = c.mentions.find((x) => x.brand_id === own?.id);
      return { run_id: c.run_id, prompt: c.prompt, engine: c.engine, country: c.country, run_date: c.run_date, mentioned: !!m, rank: m?.rank ?? null, excerpt: c.excerpt, channel: c.channel };
    }),
    insights: insights.map((i) => ({ ...i, evidence: parseJson(i.evidence, {}) })),
    actions,
  };
}
