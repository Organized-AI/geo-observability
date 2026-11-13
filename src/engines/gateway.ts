import type { Env } from "../env";
import { EngineError, type EngineContext } from "./types";

/** AI Gateway provider slugs. https://developers.cloudflare.com/ai-gateway/ */
export type GatewayProvider = "openai" | "anthropic" | "google-ai-studio" | "perplexity-ai";

const DIRECT_BASE: Record<GatewayProvider, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  "google-ai-studio": "https://generativelanguage.googleapis.com",
  "perplexity-ai": "https://api.perplexity.ai",
};

export function gatewayEnabled(env: Env): boolean {
  return !!env.CLOUDFLARE_ACCOUNT_ID && !!env.AI_GATEWAY_ID;
}

/**
 * Base URL for a provider. With an account id the call goes through AI Gateway (logs, cost, spend limits,
 * metadata); without one it goes straight to the provider so local development still works.
 */
export function providerBase(env: Env, provider: GatewayProvider): string {
  if (gatewayEnabled(env)) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/${provider}`;
  }
  return DIRECT_BASE[provider];
}

/** cf-aig-metadata takes at most five entries; these let gateway logs and costs split per client. */
export function gatewayMetadata(ctx: EngineContext, engine: string): string {
  return JSON.stringify({
    tenant: ctx.tenantId,
    project: ctx.projectId,
    prompt: ctx.promptId,
    engine,
    run: ctx.runId,
  });
}

export function gatewayHeaders(env: Env, ctx: EngineContext, engine: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (gatewayEnabled(env)) {
    h["cf-aig-metadata"] = gatewayMetadata(ctx, engine);
    if (env.CF_AIG_TOKEN) h["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
    // Answers must be fresh each day: never serve a cached answer for a tracked prompt.
    h["cf-aig-skip-cache"] = "true";
  }
  return h;
}

export interface GatewayResponse<T> {
  body: T;
  logId: string | null;
  latencyMs: number;
}

/** POST JSON with a timeout and up to two retries on 429 / 5xx. */
export async function postJson<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: { timeoutMs?: number; retries?: number; fetcher?: typeof fetch } = {},
): Promise<GatewayResponse<T>> {
  const retries = opts.retries ?? 2;
  const doFetch = opts.fetcher ?? fetch;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 90_000);
    try {
      const res = await doFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
      const latencyMs = Date.now() - started;
      const logId = res.headers.get("cf-aig-log-id");
      if (res.ok) return { body: (await res.json()) as T, logId, latencyMs };
      const text = (await res.text()).slice(0, 500);
      const retryable = res.status === 429 || res.status >= 500;
      lastErr = new EngineError(`HTTP ${res.status}: ${text}`, retryable, res.status);
      if (!retryable) throw lastErr;
    } catch (e) {
      lastErr = e instanceof EngineError ? e : new EngineError(String((e as Error)?.message ?? e), true);
      if (e instanceof EngineError && !e.retryable) throw e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 750 * 2 ** attempt));
  }
  throw lastErr;
}
