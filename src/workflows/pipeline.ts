import type { Env, RunJob } from "../env";
import { getEngine, estimateCostMicros, pricing } from "../engines/registry";
import { EngineError, type EngineAnswer } from "../engines/types";
import { runJudge, type JudgeResult } from "../judge/llm";
import { classifyDomain, findMentions, type FoundMention } from "../judge/mentions";
import { TenantDB, type PromptRow } from "../lib/db";
import { canonicalUrl, domainOf, hourKey, newId, nowIso, parseJson, pathOf } from "../lib/util";
import { loadBrands, type BrandInfo } from "../metrics/report";
import { billingAllowsRuns, recordUsage } from "../billing/hooks";
import { exportRunSpan } from "../lib/otel";

/** The part of an engine answer a Workflow step returns (the raw provider body stays in R2). */
export interface StoredAnswer extends Omit<EngineAnswer, "raw"> {
  r2Key: string;
  /** The prompt as asked, so scoring can ignore the answer restating it. */
  prompt?: string;
}

export async function monthSpendMicros(tdb: TenantDB, month = nowIso().slice(0, 7)): Promise<number> {
  const r = await tdb.first<{ s: number | null }>(
    "SELECT SUM(cost_micros) AS s FROM runs WHERE tenant_id = ?1 AND substr(run_date, 1, 7) = ?2",
    month,
  );
  return r?.s ?? 0;
}

/** Guard rails checked before any paid call: tenant paused, billing gate, monthly model-spend cap. */
export async function preflight(env: Env, job: RunJob): Promise<{ ok: true } | { ok: false; reason: string }> {
  const tenant = await env.DB.prepare("SELECT status, monthly_spend_cap_micros FROM tenants WHERE id = ?1")
    .bind(job.tenantId)
    .first<{ status: string; monthly_spend_cap_micros: number }>();
  if (!tenant) return { ok: false, reason: "tenant not found" };
  if (tenant.status !== "active") return { ok: false, reason: "workspace paused" };
  if (!(await billingAllowsRuns(env, job.tenantId))) return { ok: false, reason: "billing status blocks new runs" };
  const engine = getEngine(job.engine);
  if (!engine || engine.channel(env) === "unavailable") return { ok: false, reason: `${job.engine} is not trackable` };
  if (engine.channel(env) === "api") {
    const spent = await monthSpendMicros(new TenantDB(env.DB, job.tenantId));
    if (spent >= tenant.monthly_spend_cap_micros) return { ok: false, reason: "monthly model spend cap reached" };
  }
  return { ok: true };
}

export async function markRun(env: Env, job: RunJob, status: string, error?: string): Promise<void> {
  const tdb = new TenantDB(env.DB, job.tenantId);
  await tdb.run(
    `INSERT INTO runs (id, tenant_id, project_id, prompt_id, engine, country, run_date, status, error)
     VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, error = excluded.error,
       finished_at = CASE WHEN excluded.status IN ('done','failed','skipped') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE finished_at END
     WHERE runs.tenant_id = ?1`,
    job.runId,
    job.projectId,
    job.promptId,
    job.engine,
    job.country,
    job.runDate,
    status,
    error ?? null,
  );
}

/** Step 1: ask the engine and keep the full provider response in R2. */
export async function askAndStore(env: Env, job: RunJob): Promise<StoredAnswer> {
  const tdb = new TenantDB(env.DB, job.tenantId);
  const prompt = await tdb.first<PromptRow>("SELECT * FROM prompts WHERE tenant_id = ?1 AND id = ?2", job.promptId);
  if (!prompt) throw new EngineError("Prompt no longer exists", false);
  const engine = getEngine(job.engine);
  if (!engine) throw new EngineError(`Unknown engine ${job.engine}`, false);
  const brands = await loadBrands(tdb, job.projectId);
  const answer = await engine.ask(prompt.text, {
    env,
    tenantId: job.tenantId,
    projectId: job.projectId,
    promptId: job.promptId,
    runId: job.runId,
    country: job.country,
    language: prompt.language,
    brands: brands.map((b) => ({ name: b.name, domains: b.domains, isOwn: b.isOwn })),
  });
  const r2Key = `tenants/${job.tenantId}/runs/${job.runDate}/${job.runId}.json`;
  await env.ANSWERS.put(
    r2Key,
    JSON.stringify({ run_id: job.runId, prompt: prompt.text, engine: job.engine, country: job.country, model: answer.model, channel: answer.channel, text: answer.text, citations: answer.citations, fanout: answer.fanout, raw: answer.raw }),
    { httpMetadata: { contentType: "application/json" }, customMetadata: { tenant: job.tenantId, run: job.runId } },
  );
  const { raw: _raw, ...rest } = answer;
  return { ...rest, r2Key, prompt: prompt.text };
}

export interface Scored {
  mentions: FoundMention[];
  judge: JudgeResult | null;
  judgeMode: "llm" | "rules";
}

/** Step 2: deterministic mentions and rank, then the LLM judge for sentiment, new brands, perception and claims. */
export async function score(env: Env, job: RunJob, answer: StoredAnswer, brandsIn?: BrandInfo[]): Promise<Scored> {
  const tdb = new TenantDB(env.DB, job.tenantId);
  const brands = brandsIn ?? (await loadBrands(tdb, job.projectId));
  const mentions = findMentions(answer.text, brands, answer.prompt);
  if (answer.channel === "stub") return { mentions, judge: null, judgeMode: "rules" };
  const own = brands.find((b) => b.isOwn) ?? null;
  const profile = await tdb.first<{ facts: string | null }>("SELECT facts FROM brand_profiles WHERE tenant_id = ?1 AND project_id = ?2", job.projectId);
  const judge = await runJudge(env, answer.text, brands.map((b) => b.name), own?.name ?? null, parseJson<string[]>(profile?.facts, []), {
    tenant: job.tenantId,
    project: job.projectId,
    run: job.runId,
  });
  if (judge) {
    for (const m of mentions) {
      const s = judge.sentiments.find((x) => x.brand.toLowerCase() === m.brandName.toLowerCase());
      if (s) m.sentiment = s.score;
    }
  }
  return { mentions, judge, judgeMode: judge ? "llm" : "rules" };
}

/** Step 3: write everything the reports read, plus usage for the billing hook. */
export async function persist(env: Env, job: RunJob, answer: StoredAnswer, scored: Scored): Promise<void> {
  const tdb = new TenantDB(env.DB, job.tenantId);
  const brands = await loadBrands(tdb, job.projectId, ["active", "suggested", "rejected"]);
  const active = brands.filter((b) => b.status === "active");
  const table = await pricing(env);
  const cost = answer.channel === "api" ? estimateCostMicros(table, job.engine, answer) : 0;
  const stmts: D1PreparedStatement[] = [];

  stmts.push(
    tdb.prepare(
      `UPDATE runs SET status = 'done', error = NULL, model = ?3, channel = ?4, aig_log_id = ?5, cost_micros = ?6,
         input_tokens = ?7, output_tokens = ?8, latency_ms = ?9, r2_key = ?10, answer_excerpt = ?11, judge = ?12,
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE tenant_id = ?1 AND id = ?2`,
      job.runId,
      answer.model,
      answer.channel,
      answer.aigLogId,
      cost,
      answer.inputTokens,
      answer.outputTokens,
      answer.latencyMs,
      answer.r2Key,
      answer.text.replace(/\s+/g, " ").slice(0, 280),
      scored.judgeMode,
    ),
  );
  // Re-running a run replaces its facts.
  for (const t of ["mentions", "citations", "fanout_queries", "claims"]) {
    stmts.push(tdb.prepare(`DELETE FROM ${t} WHERE tenant_id = ?1 AND run_id = ?2`, job.runId));
  }
  for (const m of scored.mentions) {
    stmts.push(
      tdb.prepare(
        "INSERT OR REPLACE INTO mentions (run_id, tenant_id, brand_id, brand_name, rank, sentiment, snippet) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)",
        job.runId,
        m.brandId,
        m.brandName,
        m.rank,
        Math.round(m.sentiment),
        m.snippet,
      ),
    );
  }
  answer.citations.slice(0, 40).forEach((c, i) => {
    const url = canonicalUrl(c.url);
    const domain = domainOf(url);
    if (!domain) return;
    stmts.push(
      tdb.prepare(
        "INSERT OR IGNORE INTO citations (run_id, tenant_id, url, domain, path, title, kind, position) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8)",
        job.runId,
        url,
        domain,
        pathOf(url),
        c.title ?? null,
        c.kind,
        i + 1,
      ),
    );
    stmts.push(
      tdb.prepare(
        "INSERT OR IGNORE INTO domain_classes (tenant_id, project_id, domain, type) VALUES (?1, ?2, ?3, ?4)",
        job.projectId,
        domain,
        classifyDomain(domain, active),
      ),
    );
  });
  for (const q of answer.fanout.slice(0, 20)) {
    stmts.push(tdb.prepare("INSERT OR IGNORE INTO fanout_queries (run_id, tenant_id, query, kind) VALUES (?2, ?1, ?3, ?4)", job.runId, q.query.slice(0, 300), q.kind));
  }
  if (scored.judge) {
    const idOf = (name: string) => brands.find((b) => b.name.toLowerCase() === name.toLowerCase())?.id ?? null;
    for (const a of scored.judge.attributes) stmts.push(tdb.prepare("INSERT INTO claims (run_id, tenant_id, brand_id, claim, verdict, kind) VALUES (?2, ?1, ?3, ?4, 'unchecked', 'attribute')", job.runId, idOf(a.brand), a.text));
    for (const o of scored.judge.objections) stmts.push(tdb.prepare("INSERT INTO claims (run_id, tenant_id, brand_id, claim, verdict, kind) VALUES (?2, ?1, ?3, ?4, 'unchecked', 'objection')", job.runId, idOf(o.brand), o.text));
    for (const c of scored.judge.claims) stmts.push(tdb.prepare("INSERT INTO claims (run_id, tenant_id, brand_id, claim, verdict, kind) VALUES (?2, ?1, ?3, ?4, ?5, 'fact')", job.runId, idOf(c.brand), c.claim, c.verdict));
    // Brands the answer recommended that nobody tracks yet become suggestions on the Competitors page.
    for (const name of scored.judge.other_brands) {
      if (brands.some((b) => b.name.toLowerCase() === name.toLowerCase() || b.aliases.some((a) => a.toLowerCase() === name.toLowerCase()))) continue;
      stmts.push(
        tdb.prepare(
          `INSERT INTO brands (id, tenant_id, project_id, name, status)
           SELECT ?2, ?1, ?3, ?4, 'suggested' WHERE NOT EXISTS (SELECT 1 FROM brands WHERE tenant_id = ?1 AND project_id = ?3 AND lower(name) = lower(?4))`,
          newId("br"),
          job.projectId,
          name,
        ),
      );
    }
  }
  stmts.push(...recordUsage(tdb, job, cost, answer.aigLogId));
  await tdb.batch(stmts);

  // Time series for dashboards outside D1 (Workers Analytics Engine), indexed by tenant.
  const own = active.find((b) => b.isOwn);
  const ownMention = own ? scored.mentions.find((m) => m.brandId === own.id) : undefined;
  env.VIS_EVENTS?.writeDataPoint({
    indexes: [job.tenantId],
    blobs: [job.projectId, job.engine, job.country, job.promptId, ownMention ? "mentioned" : "absent", answer.channel],
    doubles: [ownMention ? 1 : 0, ownMention?.rank ?? 0, ownMention?.sentiment ?? 0, cost, answer.citations.length],
  });
  await exportRunSpan(env, job, answer, cost).catch(() => undefined);
}

export function runIdFor(promptId: string, engine: string, country: string, day: string): string {
  return `${promptId}:${engine}:${country}:${day}`;
}

export { hourKey };
