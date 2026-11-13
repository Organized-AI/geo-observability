import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env, InsightsJob, RunJob } from "../env";
import { EngineError } from "../engines/types";
import { progressStub } from "../durable/progress";
import { askAndStore, markRun, persist, preflight, score, type StoredAnswer } from "./pipeline";
import { generateInsights } from "../insights/engine";

/** One Workflow instance per prompt × engine × country × day: call → store → score → persist. */
export class RunPromptWorkflow extends WorkflowEntrypoint<Env, RunJob> {
  async run(event: WorkflowEvent<RunJob>, step: WorkflowStep) {
    const job = event.payload;
    const env = this.env;

    const pre = await step.do("preflight", async () => preflight(env, job));
    if (!pre.ok) {
      await step.do("skip", async () => {
        await markRun(env, job, "skipped", pre.reason);
        await progressStub(env, job.projectId).tick(job.passId, "skipped");
      });
      return { status: "skipped", reason: pre.reason };
    }

    await step.do("mark running", async () => markRun(env, job, "running"));

    let answer: StoredAnswer;
    try {
      answer = await step.do("ask engine", { retries: { limit: 3, delay: "20 seconds", backoff: "exponential" }, timeout: "4 minutes" }, async () => {
        try {
          return await askAndStore(env, job);
        } catch (e) {
          if (e instanceof EngineError && !e.retryable) throw new NonRetryableError(e.message);
          throw e;
        }
      });
    } catch (e) {
      await step.do("mark failed", async () => {
        await markRun(env, job, "failed", String((e as Error).message ?? e).slice(0, 500));
        await progressStub(env, job.projectId).tick(job.passId, "failed");
      });
      return { status: "failed" };
    }

    const scored = await step.do("score", { retries: { limit: 2, delay: "10 seconds", backoff: "linear" } }, async () => score(env, job, answer));
    await step.do("persist", { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } }, async () => persist(env, job, answer, scored));
    await step.do("progress", async () => progressStub(env, job.projectId).tick(job.passId, "done"));
    return { status: "done", mentions: scored.mentions.length, citations: answer.citations.length };
  }
}

/** Daily per project: compare with the previous period, write insights and ranked actions. */
export class InsightsWorkflow extends WorkflowEntrypoint<Env, InsightsJob> {
  async run(event: WorkflowEvent<InsightsJob>, step: WorkflowStep) {
    const { tenantId, projectId, day } = event.payload;
    return step.do("generate", { retries: { limit: 2, delay: "30 seconds", backoff: "linear" } }, async () =>
      generateInsights(this.env, tenantId, projectId, day),
    );
  }
}
