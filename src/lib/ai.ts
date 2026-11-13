import type { Env } from "../env";

/** Workers AI call through the project's AI Gateway, returning parsed JSON or null on any failure. */
export async function aiJson<T>(env: Env, prompt: string, schema: object, meta: Record<string, string>, maxTokens = 1500): Promise<T | null> {
  if (!env.AI) return null;
  try {
    const out = (await env.AI.run(
      env.JUDGE_MODEL as keyof AiModels,
      {
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: schema },
        max_tokens: maxTokens,
        temperature: 0.4,
      } as never,
      { gateway: { id: env.AI_GATEWAY_ID, metadata: meta } } as never,
    )) as { response?: unknown };
    const r = out?.response ?? out;
    if (typeof r === "string") {
      const m = r.match(/\{[\s\S]*\}/);
      return m ? (JSON.parse(m[0]) as T) : null;
    }
    return (r as T) ?? null;
  } catch (e) {
    console.warn("workers ai call failed", (e as Error).message);
    return null;
  }
}

export async function aiText(env: Env, prompt: string, meta: Record<string, string>, maxTokens = 1500): Promise<string | null> {
  if (!env.AI) return null;
  try {
    const out = (await env.AI.run(
      env.JUDGE_MODEL as keyof AiModels,
      { messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.4 } as never,
      { gateway: { id: env.AI_GATEWAY_ID, metadata: meta } } as never,
    )) as { response?: unknown };
    return typeof out?.response === "string" ? out.response : null;
  } catch {
    return null;
  }
}
