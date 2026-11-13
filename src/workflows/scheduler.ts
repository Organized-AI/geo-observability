import type { Env, RunJob } from "../env";
import { getEngine } from "../engines/registry";
import { TenantDB, type PromptRow } from "../lib/db";
import { chunk, newId, today } from "../lib/util";
import { progressStub } from "../durable/progress";
import { runIdFor } from "./pipeline";

export function instanceIdFor(job: RunJob): string {
  return `${job.runId}-${job.passId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
}

/** Plan one pass for a project: every active prompt × enabled engine, in the prompt's country, within plan limits. */
export async function planPass(env: Env, tenantId: string, projectId: string, day = today()): Promise<RunJob[]> {
  const tdb = new TenantDB(env.DB, tenantId);
  const tenant = await env.DB.prepare("SELECT prompt_limit, model_limit, status FROM tenants WHERE id = ?1")
    .bind(tenantId)
    .first<{ prompt_limit: number; model_limit: number; status: string }>();
  if (!tenant || tenant.status !== "active") return [];
  const prompts = await tdb.all<PromptRow>(
    "SELECT * FROM prompts WHERE tenant_id = ?1 AND project_id = ?2 AND status = 'active' ORDER BY created_at LIMIT ?3",
    projectId,
    tenant.prompt_limit,
  );
  const models = await tdb.all<{ engine: string }>(
    "SELECT engine FROM project_models WHERE tenant_id = ?1 AND project_id = ?2 AND enabled = 1 ORDER BY engine",
    projectId,
  );
  const engines = models
    .map((m) => m.engine)
    .filter((e) => {
      const eng = getEngine(e);
      return eng && eng.channel(env) !== "unavailable";
    })
    .slice(0, tenant.model_limit);
  const passId = newId("pass").slice(5, 13);
  const jobs: RunJob[] = [];
  for (const p of prompts) {
    for (const engine of engines) {
      jobs.push({ runId: runIdFor(p.id, engine, p.country, day), tenantId, projectId, promptId: p.id, engine, country: p.country, runDate: day, passId });
    }
  }
  return jobs;
}

/** Write queued rows, start the progress counter and hand the jobs to the queue. */
export async function enqueuePass(env: Env, tenantId: string, projectId: string, day = today()): Promise<number> {
  const jobs = await planPass(env, tenantId, projectId, day);
  if (!jobs.length) return 0;
  const tdb = new TenantDB(env.DB, tenantId);
  for (const part of chunk(jobs, 50)) {
    await tdb.batch(
      part.map((j) =>
        tdb.prepare(
          `INSERT INTO runs (id, tenant_id, project_id, prompt_id, engine, country, run_date, status)
           VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, 'queued')
           ON CONFLICT(id) DO UPDATE SET status = 'queued', error = NULL WHERE runs.tenant_id = ?1`,
          j.runId,
          j.projectId,
          j.promptId,
          j.engine,
          j.country,
          j.runDate,
        ),
      ),
    );
  }
  await progressStub(env, projectId).start(jobs[0].passId, jobs.length);
  for (const part of chunk(jobs, 100)) await env.RUNS.sendBatch(part.map((body) => ({ body })));
  return jobs.length;
}

/** Queue consumer: start one Workflow instance per job. The instance id makes duplicates harmless. */
export async function consumeRuns(batch: MessageBatch<RunJob>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await env.RUN_PROMPT.create({ id: instanceIdFor(msg.body), params: msg.body });
      msg.ack();
    } catch (e) {
      const text = String((e as Error)?.message ?? e);
      if (/already exists|duplicate/i.test(text)) msg.ack();
      else msg.retry({ delaySeconds: 30 });
    }
  }
}

/** Cron: start the daily (and on Mondays, weekly) passes for every active project. */
export async function scheduleDuePasses(env: Env, now = new Date()): Promise<number> {
  const isMonday = now.getUTCDay() === 1;
  const rows = await env.DB.prepare(
    `SELECT p.id, p.tenant_id, p.schedule FROM projects p JOIN tenants t ON t.id = p.tenant_id
     WHERE t.status = 'active' AND p.onboarding_step = 'done' AND p.schedule IN ('daily','weekly')`,
  ).all<{ id: string; tenant_id: string; schedule: string }>();
  let n = 0;
  for (const p of rows.results ?? []) {
    if (p.schedule === "weekly" && !isMonday) continue;
    n += await enqueuePass(env, p.tenant_id, p.id, today(now));
  }
  return n;
}

export async function scheduleInsights(env: Env, now = new Date()): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.tenant_id FROM projects p JOIN tenants t ON t.id = p.tenant_id WHERE t.status = 'active' AND p.onboarding_step = 'done'`,
  ).all<{ id: string; tenant_id: string }>();
  const day = today(now);
  for (const p of rows.results ?? []) {
    try {
      await env.INSIGHTS.create({ id: `ins-${p.id}-${day}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100), params: { tenantId: p.tenant_id, projectId: p.id, day } });
    } catch (e) {
      if (!/already exists/i.test(String((e as Error)?.message))) console.warn("insights schedule failed", p.id, (e as Error).message);
    }
  }
  return rows.results?.length ?? 0;
}
