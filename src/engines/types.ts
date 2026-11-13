import type { Env } from "../env";

export type EngineId = "chatgpt" | "claude" | "gemini" | "perplexity" | "alexa";
export type Channel = "api" | "stub" | "unavailable";

export interface EngineCitation {
  url: string;
  title?: string;
  /** cited: shown to the reader as a source. used: retrieved by the engine's search but not shown. */
  kind: "cited" | "used";
}

export interface EngineAnswer {
  text: string;
  citations: EngineCitation[];
  fanout: { query: string; kind: "search" | "shopping" }[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  searchCalls: number;
  aigLogId: string | null;
  latencyMs: number;
  channel: "api" | "stub";
  raw: unknown;
}

export interface BrandHint {
  name: string;
  domains: string[];
  isOwn: boolean;
}

export interface EngineContext {
  env: Env;
  tenantId: string;
  projectId: string;
  promptId: string;
  runId: string;
  country: string;
  language: string;
  /** Used only by the stub engine to write plausible sample answers. */
  brands: BrandHint[];
}

export interface Engine {
  id: EngineId;
  label: string;
  vendor: string;
  channel(env: Env): Channel;
  note(env: Env): string;
  ask(prompt: string, ctx: EngineContext): Promise<EngineAnswer>;
}

export class EngineError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
    public status?: number,
  ) {
    super(message);
  }
}
