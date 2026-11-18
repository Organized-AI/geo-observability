import { env as rawEnv } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env, RunJob } from '../src/env';
import { consumeRuns, enqueuePass, instanceIdFor } from '../src/workflows/scheduler';
const env = rawEnv as unknown as Env;
beforeAll(async () => {
  await env.DB.prepare("INSERT INTO tenants (id,name,slug) VALUES ('ten_scheduler','Scheduler','scheduler')").run();
  await env.DB.prepare("INSERT INTO projects (id,tenant_id,name,domain) VALUES ('prj_scheduler','ten_scheduler','Scheduler','example.test')").run();
  await env.DB.prepare("INSERT INTO prompts (id,tenant_id,project_id,text,country,status) VALUES ('prompt_scheduler','ten_scheduler','prj_scheduler','Which tool?','US','active')").run();
  await env.DB.prepare("INSERT INTO project_models (tenant_id,project_id,engine,enabled) VALUES ('ten_scheduler','prj_scheduler','chatgpt',1)").run();
});
describe('production scheduler safeguards', () => {
  it('uses a stable workflow identity across delivery passes and separates tenants', async () => {
    const job = { tenantId: 'a', runId: 'run', passId: 'first' } as RunJob;
    expect(await instanceIdFor(job)).toBe(await instanceIdFor({ ...job, passId: 'retry' }));
    expect(await instanceIdFor(job)).not.toBe(await instanceIdFor({ ...job, tenantId: 'b' }));
  });
  it('replays a failed send, then does not reset or re-enqueue completed work', async () => {
    const sendBatch = vi.fn().mockRejectedValueOnce(new Error('queue unavailable')).mockResolvedValue(undefined);
    const configured = { ...env, RUNS: { sendBatch } } as unknown as Env;
    await expect(enqueuePass(configured,'ten_scheduler','prj_scheduler','2026-11-18')).rejects.toThrow('queue unavailable');
    expect(await enqueuePass(configured,'ten_scheduler','prj_scheduler','2026-11-18')).toBe(1);
    const job = sendBatch.mock.calls[1][0][0].body as RunJob;
    await env.DB.prepare("UPDATE runs SET status='done' WHERE id=?1").bind(job.runId).run();
    expect(await enqueuePass(configured,'ten_scheduler','prj_scheduler','2026-11-18')).toBe(0);
    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect((await env.DB.prepare('SELECT status FROM runs WHERE id=?1').bind(job.runId).first<{status:string}>())?.status).toBe('done');
    const ack=vi.fn(), create=vi.fn();
    await consumeRuns({messages:[{body:job,ack,retry:vi.fn()}]} as unknown as MessageBatch<RunJob>, {...env,RUN_PROMPT:{create}} as unknown as Env);
    expect(ack).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });
});
