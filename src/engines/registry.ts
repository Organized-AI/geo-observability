import type { Env } from "../env";
import { alexa, chatgpt, claude, gemini, perplexity } from "./providers";
import type { Engine, EngineId } from "./types";

export const ENGINES: Record<EngineId, Engine> = { chatgpt, claude, gemini, perplexity, alexa };
export const ENGINE_IDS = Object.keys(ENGINES) as EngineId[];

export function getEngine(id: string): Engine | undefined {
  return (ENGINES as Record<string, Engine>)[id];
}

export function engineList(env: Env) {
  return ENGINE_IDS.map((id) => {
    const e = ENGINES[id];
    const channel = e.channel(env);
    return { id, label: e.label, vendor: e.vendor, available: channel !== "unavailable", channel, note: e.note(env) };
  });
}

/**
 * Estimated price per million tokens and per web search, in micros (1 USD = 1,000,000 micros).
 * These are placeholders to make cost visible; override them with the KV key "pricing" (same shape)
 * and reconcile against AI Gateway's logged cost. Check each provider's current price list.
 */
export const DEFAULT_PRICING: Record<string, { input: number; output: number; search: number }> = {
  chatgpt: { input: 250_000, output: 2_000_000, search: 10_000 },
  claude: { input: 3_000_000, output: 15_000_000, search: 10_000 },
  gemini: { input: 300_000, output: 2_500_000, search: 35_000 },
  perplexity: { input: 1_000_000, output: 1_000_000, search: 5_000 },
  judge: { input: 0, output: 0, search: 0 },
};

export async function pricing(env: Env): Promise<typeof DEFAULT_PRICING> {
  try {
    const custom = await env.CONFIG.get<typeof DEFAULT_PRICING>("pricing", "json");
    return { ...DEFAULT_PRICING, ...(custom ?? {}) };
  } catch {
    return DEFAULT_PRICING;
  }
}

export function estimateCostMicros(
  table: typeof DEFAULT_PRICING,
  engine: string,
  usage: { inputTokens: number; outputTokens: number; searchCalls: number },
): number {
  const p = table[engine];
  if (!p) return 0;
  return Math.round((usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000 + usage.searchCalls * p.search);
}
