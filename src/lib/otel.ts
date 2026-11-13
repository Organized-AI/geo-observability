import type { Env, RunJob } from "../env";
import type { EngineAnswer } from "../engines/types";
import { parseJson } from "./util";

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Optional: send one OTLP/HTTP JSON span per run to Langfuse, Honeycomb or any OTLP collector, using
 * gen_ai.* semantic attributes. Off unless OTEL_EXPORTER_URL is set.
 */
export async function exportRunSpan(env: Env, job: RunJob, answer: Omit<EngineAnswer, "raw">, costMicros: number): Promise<void> {
  if (!env.OTEL_EXPORTER_URL) return;
  const end = Date.now() * 1_000_000;
  const start = end - Math.max(answer.latencyMs, 1) * 1_000_000;
  const attr = (key: string, v: string | number) =>
    typeof v === "number" ? { key, value: Number.isInteger(v) ? { intValue: v } : { doubleValue: v } } : { key, value: { stringValue: v } };
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", "geo-observability")] },
        scopeSpans: [
          {
            scope: { name: "geo-observability.runner" },
            spans: [
              {
                traceId: hex(16),
                spanId: hex(8),
                name: `chat ${job.engine}`,
                kind: 3,
                startTimeUnixNano: String(start),
                endTimeUnixNano: String(end),
                attributes: [
                  attr("gen_ai.operation.name", "chat"),
                  attr("gen_ai.system", job.engine),
                  attr("gen_ai.request.model", answer.model),
                  attr("gen_ai.usage.input_tokens", answer.inputTokens),
                  attr("gen_ai.usage.output_tokens", answer.outputTokens),
                  attr("geo.tenant_id", job.tenantId),
                  attr("geo.project_id", job.projectId),
                  attr("geo.prompt_id", job.promptId),
                  attr("geo.country", job.country),
                  attr("geo.cost_micros", costMicros),
                  attr("geo.channel", answer.channel),
                  attr("geo.citations", answer.citations.length),
                  attr("cf.aig.log_id", answer.aigLogId ?? ""),
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
  await fetch(env.OTEL_EXPORTER_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...parseJson<Record<string, string>>(env.OTEL_EXPORTER_HEADERS, {}) },
    body: JSON.stringify(body),
  });
}
