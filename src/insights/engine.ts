import type { Env } from "../env";
import { TenantDB } from "../lib/db";
import { addDays, sha256Hex } from "../lib/util";
import { Binds, domainMatch, type Filters } from "../metrics/filters";
import { brandMetrics, domainReport, loadBrands, promptPerformance, type BrandInfo } from "../metrics/report";

export interface Insight {
  kind: string;
  severity: 1 | 2 | 3;
  text: string;
  evidence: Record<string, unknown>;
  weight: number;
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const pts = (x: number) => `${Math.abs(Math.round(x * 1000) / 10)} points`;
const ENGINE_LABEL: Record<string, string> = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", perplexity: "Perplexity" };

function windowFilters(day: string, days = 7): { cur: Filters; prev: Filters } {
  const base = { engines: [], countries: [], topics: [], tags: [], prompts: [] };
  return {
    cur: { ...base, from: addDays(day, -(days - 1)), to: day },
    prev: { ...base, from: addDays(day, -(2 * days - 1)), to: addDays(day, -days) },
  };
}

/**
 * Compares the last 7 days with the 7 before and writes plain-language insights with evidence, then refreshes
 * the ranked action list. Sentences are templated from the numbers, so every figure in an insight is one the
 * evidence rows can reproduce.
 */
export async function generateInsights(env: Env, tenantId: string, projectId: string, day: string): Promise<{ insights: number; actions: number }> {
  const tdb = new TenantDB(env.DB, tenantId);
  const brands = await loadBrands(tdb, projectId);
  const own = brands.find((b) => b.isOwn);
  if (!own) return { insights: 0, actions: 0 };
  const { cur, prev } = windowFilters(day);
  const found: Insight[] = [];

  // 1. Overall and per-engine visibility moves.
  const [mc, mp] = await Promise.all([brandMetrics(tdb, projectId, cur, brands), brandMetrics(tdb, projectId, prev, brands)]);
  const oc = mc.find((m) => m.brand_id === own.id);
  const op = mp.find((m) => m.brand_id === own.id);
  if (oc && op && op.answers > 0 && oc.answers > 0) {
    const d = oc.visibility - op.visibility;
    if (Math.abs(d) >= 0.03) {
      found.push({
        kind: "visibility_move",
        severity: Math.abs(d) >= 0.1 ? 3 : 2,
        text: `${own.name} appeared in ${pct(oc.visibility)} of answers this week, ${d > 0 ? "up" : "down"} ${pts(d)} from ${pct(op.visibility)} the week before.`,
        evidence: { metric: "visibility", current: oc.visibility, previous: op.visibility, range: cur, previous_range: prev },
        weight: Math.abs(d) * 10,
      });
    }
    // Rival overtakes.
    for (const m of mc) {
      if (m.brand_id === own.id) continue;
      const before = mp.find((x) => x.brand_id === m.brand_id);
      if (before && before.visibility <= op.visibility && m.visibility > oc.visibility) {
        const name = brands.find((b) => b.id === m.brand_id)?.name ?? "A competitor";
        found.push({
          kind: "visibility_move",
          severity: 3,
          text: `${name} overtook ${own.name} this week: ${pct(m.visibility)} of answers against your ${pct(oc.visibility)}.`,
          evidence: { metric: "visibility", brand_id: m.brand_id, competitor: m.visibility, own: oc.visibility },
          weight: 5 + (m.visibility - oc.visibility) * 10,
        });
      }
    }
  }
  for (const engine of ["chatgpt", "claude", "gemini", "perplexity"]) {
    const [c, p] = await Promise.all([
      brandMetrics(tdb, projectId, { ...cur, engines: [engine] }, [own]),
      brandMetrics(tdb, projectId, { ...prev, engines: [engine] }, [own]),
    ]);
    if (!c[0]?.answers || !p[0]?.answers) continue;
    const d = c[0].visibility - p[0].visibility;
    if (Math.abs(d) >= 0.08) {
      found.push({
        kind: "visibility_move",
        severity: Math.abs(d) >= 0.15 ? 3 : 2,
        text: `On ${ENGINE_LABEL[engine]}, ${own.name} is named in ${pct(c[0].visibility)} of answers, ${d > 0 ? "up" : "down"} ${pts(d)} on the previous week.`,
        evidence: { metric: "visibility", engine, current: c[0].visibility, previous: p[0].visibility },
        weight: Math.abs(d) * 8,
      });
    }
  }

  // 2. Prompts won and lost.
  const [pc, pp] = await Promise.all([promptPerformance(tdb, projectId, cur, own.id), promptPerformance(tdb, projectId, prev, own.id)]);
  const lost = pc.filter((x) => x.visibility === 0 && (pp.find((y) => y.prompt_id === x.prompt_id)?.visibility ?? 0) >= 0.5);
  const won = pc.filter((x) => x.visibility >= 0.5 && (pp.find((y) => y.prompt_id === x.prompt_id)?.visibility ?? 1) === 0);
  if (lost.length) {
    found.push({
      kind: "prompt_lost",
      severity: 3,
      text:
        lost.length === 1
          ? `You dropped out of every answer to "${lost[0].text}", where you were named at least half the time last week.`
          : `You dropped out of every answer to ${lost.length} prompts where you were named at least half the time last week, including "${lost[0].text}".`,
      evidence: { prompt_ids: lost.map((x) => x.prompt_id) },
      weight: 4 + lost.length,
    });
  }
  if (won.length) {
    found.push({
      kind: "prompt_won",
      severity: 1,
      text:
        won.length === 1
          ? `You're now named in most answers to "${won[0].text}", which didn't mention you last week.`
          : `You're now named in most answers to ${won.length} prompts that didn't mention you last week, including "${won[0].text}".`,
      evidence: { prompt_ids: won.map((x) => x.prompt_id) },
      weight: 2 + won.length,
    });
  }

  // 3. New domains citing rivals but not you.
  const [dc, dp] = await Promise.all([domainReport(tdb, projectId, cur, brands, { gap: true, limit: 200 }), domainReport(tdb, projectId, prev, brands, { limit: 500 })]);
  const fresh = dc.filter((d) => !dp.some((p) => p.domain === d.domain) && d.type !== "competitor");
  if (fresh.length) {
    const top = fresh.slice(0, 3);
    found.push({
      kind: "rival_source",
      severity: 2,
      text: `${fresh.length === 1 ? "A new source" : `${fresh.length} new sources`} now feed answers that recommend competitors but not you, led by ${top.map((d) => d.domain).join(", ")}.`,
      evidence: { domains: top.map((d) => ({ domain: d.domain, answers: d.answers, competitors: d.competitors })) },
      weight: 2 + fresh.length / 2,
    });
  }

  // 4. Cited pages that AI bots stopped fetching.
  const crawlDrop = await crawlDrops(tdb, projectId, own, cur, prev);
  if (crawlDrop.length) {
    found.push({
      kind: "crawl_drop",
      severity: 2,
      text: `${crawlDrop.length === 1 ? `${crawlDrop[0]} is` : `${crawlDrop.length} pages that answers cite are`} no longer being fetched by AI search or user agents this week.`,
      evidence: { paths: crawlDrop },
      weight: 3,
    });
  }

  // 5. Referral and conversion moves.
  const refMove = await sumMove(tdb, "referral_daily", "sessions", projectId, cur, prev);
  if (refMove && Math.abs(refMove.change) >= 0.25 && refMove.prev >= 10) {
    found.push({
      kind: "referral_move",
      severity: 2,
      text: `Visits from AI assistants ${refMove.change > 0 ? "rose" : "fell"} ${Math.round(Math.abs(refMove.change) * 100)}% to ${refMove.cur} this week.`,
      evidence: { current: refMove.cur, previous: refMove.prev },
      weight: Math.abs(refMove.change) * 4,
    });
  }
  const convMove = await sumMove(tdb, "conversion_daily", "conversions", projectId, cur, prev);
  if (convMove && convMove.cur !== convMove.prev && convMove.cur + convMove.prev >= 3) {
    found.push({
      kind: "conversion_move",
      severity: 2,
      text: `AI-referred visitors converted ${convMove.cur} time${convMove.cur === 1 ? "" : "s"} this week, against ${convMove.prev} the week before.`,
      evidence: { current: convMove.cur, previous: convMove.prev },
      weight: 3,
    });
  }

  const chosen = found.sort((a, b) => b.weight - a.weight).slice(0, 5);
  const stmts = [tdb.prepare("DELETE FROM insights WHERE tenant_id = ?1 AND project_id = ?2 AND day = ?3", projectId, day)];
  for (const i of chosen) {
    stmts.push(
      tdb.prepare(
        "INSERT INTO insights (id, tenant_id, project_id, day, kind, severity, text, evidence) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8)",
        `ins_${(await sha256Hex(`${projectId}|${day}|${i.text}`)).slice(0, 16)}`,
        projectId,
        day,
        i.kind,
        i.severity,
        i.text,
        JSON.stringify(i.evidence),
      ),
    );
  }
  await tdb.batch(stmts);
  const actions = await refreshActions(tdb, projectId, brands, own, cur, prev, { lost: lost.map((l) => l.prompt_id), gaps: dc, crawlDrop });
  return { insights: chosen.length, actions };
}

async function crawlDrops(tdb: TenantDB, projectId: string, own: BrandInfo, cur: Filters, prev: Filters): Promise<string[]> {
  if (!own.domains.length) return [];
  const b = new Binds();
  const pid = b.add(projectId);
  const pf = b.add(prev.from);
  const ct = b.add(cur.to);
  const match = domainMatch(b, "c.domain", own.domains);
  const cited = await tdb.all<{ path: string }>(
    `SELECT DISTINCT c.path FROM citations c JOIN runs ON runs.id = c.run_id AND runs.tenant_id = ?1
     WHERE +c.tenant_id = ?1 AND runs.project_id = ${pid} AND runs.run_date BETWEEN ${pf} AND ${ct} AND ${match}`,
    ...b.values,
  );
  const out: string[] = [];
  for (const { path } of cited.slice(0, 200)) {
    const r = await tdb.first<{ before: number; now: number }>(
      `SELECT SUM(CASE WHEN day BETWEEN ?3 AND ?4 THEN hits ELSE 0 END) AS before, SUM(CASE WHEN day BETWEEN ?5 AND ?6 THEN hits ELSE 0 END) AS now
       FROM crawl_daily WHERE tenant_id = ?1 AND project_id = ?2 AND path = ?7 AND bot_type IN ('search','user')`,
      projectId,
      prev.from,
      prev.to,
      cur.from,
      cur.to,
      path,
    );
    if ((r?.before ?? 0) >= 3 && (r?.now ?? 0) === 0) out.push(path);
  }
  return out;
}

async function sumMove(tdb: TenantDB, table: "referral_daily" | "conversion_daily", col: string, projectId: string, cur: Filters, prev: Filters) {
  const r = await tdb.first<{ cur: number | null; prev: number | null }>(
    `SELECT SUM(CASE WHEN day BETWEEN ?3 AND ?4 THEN ${col} ELSE 0 END) AS cur, SUM(CASE WHEN day BETWEEN ?5 AND ?6 THEN ${col} ELSE 0 END) AS prev
     FROM ${table} WHERE tenant_id = ?1 AND project_id = ?2`,
    projectId,
    cur.from,
    cur.to,
    prev.from,
    prev.to,
  );
  const c = r?.cur ?? 0;
  const p = r?.prev ?? 0;
  if (!c && !p) return null;
  return { cur: c, prev: p, change: p ? (c - p) / p : 1 };
}

interface ActionDraft {
  key: string;
  kind: string;
  title: string;
  detail: string;
  impact: number;
  evidence: Record<string, unknown>;
}

async function refreshActions(
  tdb: TenantDB,
  projectId: string,
  brands: BrandInfo[],
  own: BrandInfo,
  cur: Filters,
  _prev: Filters,
  ctx: { lost: string[]; gaps: Awaited<ReturnType<typeof domainReport>>; crawlDrop: string[] },
): Promise<number> {
  const drafts: ActionDraft[] = [];
  for (const g of ctx.gaps.filter((d) => ["editorial", "reference", "ugc", "other"].includes(d.type)).slice(0, 5)) {
    drafts.push({
      key: `get_listed|${g.domain}`,
      kind: "get_listed",
      title: `Get covered on ${g.domain}`,
      detail: `${g.domain} fed ${g.answers} answer${g.answers === 1 ? "" : "s"} that named ${g.competitors.slice(0, 3).join(", ") || "competitors"} but not ${own.name}.`,
      impact: g.answers >= 10 ? 3 : g.answers >= 4 ? 2 : 1,
      evidence: { domain: g.domain, answers: g.answers, competitors: g.competitors },
    });
  }
  const perf = await promptPerformance(tdb, projectId, cur, own.id);
  for (const p of perf.filter((x) => x.visibility === 0 && x.answers >= 3).slice(0, 5)) {
    drafts.push({
      key: `new_page|${p.prompt_id}`,
      kind: "new_page",
      title: `Answer "${p.text}" on your site`,
      detail: `None of ${p.answers} answers to this prompt named ${own.name}. A page that answers it directly gives assistants something to cite.`,
      impact: ctx.lost.includes(p.prompt_id) ? 3 : 2,
      evidence: { prompt_id: p.prompt_id },
    });
  }
  for (const path of ctx.crawlDrop.slice(0, 5)) {
    drafts.push({
      key: `fix_crawl|${path}`,
      kind: "fix_crawl",
      title: `Check AI crawler access to ${path}`,
      detail: "Answers cited this page recently, but AI search and user agents stopped fetching it. Check robots.txt, firewall rules and status codes.",
      impact: 2,
      evidence: { path },
    });
  }
  const conflicts = await tdb.all<{ claim: string; n: number }>(
    `SELECT claim, COUNT(*) AS n FROM claims WHERE tenant_id = ?1 AND brand_id = ?2 AND verdict = 'conflicts' AND kind = 'fact'
     AND run_id IN (SELECT id FROM runs WHERE tenant_id = ?1 AND project_id = ?3 AND run_date BETWEEN ?4 AND ?5)
     GROUP BY claim ORDER BY n DESC LIMIT 3`,
    own.id,
    projectId,
    cur.from,
    cur.to,
  );
  for (const c of conflicts) {
    drafts.push({
      key: `fix_fact|${c.claim.toLowerCase()}`,
      kind: "fix_fact",
      title: "Correct a claim assistants repeat about you",
      detail: `Answers said "${c.claim}" ${c.n} time${c.n === 1 ? "" : "s"}, which conflicts with the facts in your brand profile.`,
      impact: 2,
      evidence: { claim: c.claim, count: c.n },
    });
  }
  void brands;
  let n = 0;
  for (const d of drafts) {
    const id = `act_${(await sha256Hex(`${projectId}|${d.key}`)).slice(0, 16)}`;
    // New actions open; existing ones keep the status the client set (done and dismissed stay put).
    await tdb.run(
      `INSERT INTO actions (id, tenant_id, project_id, kind, title, detail, evidence, impact) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(id) DO UPDATE SET detail = excluded.detail, evidence = excluded.evidence, impact = excluded.impact WHERE actions.tenant_id = ?1`,
      id,
      projectId,
      d.kind,
      d.title,
      d.detail,
      JSON.stringify(d.evidence),
      d.impact,
    );
    n++;
  }
  return n;
}
