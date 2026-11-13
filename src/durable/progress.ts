import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

interface PassState {
  passId: string;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  startedAt: string;
}

/** One instance per project: live progress of the latest pass, so onboarding can show a progress bar. */
export class RunProgress extends DurableObject<Env> {
  async start(passId: string, total: number): Promise<void> {
    const s: PassState = { passId, total, done: 0, failed: 0, skipped: 0, startedAt: new Date().toISOString() };
    await this.ctx.storage.put("pass", s);
  }

  async tick(passId: string, outcome: "done" | "failed" | "skipped"): Promise<void> {
    const s = await this.ctx.storage.get<PassState>("pass");
    if (!s || s.passId !== passId) return;
    s[outcome]++;
    await this.ctx.storage.put("pass", s);
  }

  async get(): Promise<{ total: number; done: number; failed: number; skipped: number; running: number; pass_id: string | null; started_at: string | null }> {
    const s = await this.ctx.storage.get<PassState>("pass");
    if (!s) return { total: 0, done: 0, failed: 0, skipped: 0, running: 0, pass_id: null, started_at: null };
    return {
      total: s.total,
      done: s.done,
      failed: s.failed,
      skipped: s.skipped,
      running: Math.max(0, s.total - s.done - s.failed - s.skipped),
      pass_id: s.passId,
      started_at: s.startedAt,
    };
  }
}

export function progressStub(env: Env, projectId: string) {
  return env.PROGRESS.get(env.PROGRESS.idFromName(projectId));
}
