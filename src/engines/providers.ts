import type { Env } from "../env";
import { canonicalUrl } from "../lib/util";
import { gatewayEnabled, gatewayHeaders, postJson, providerBase } from "./gateway";
import { stubAnswer } from "./stub";
import { EngineError, type Engine, type EngineAnswer, type EngineCitation, type EngineContext } from "./types";

type Parsed = Pick<EngineAnswer, "text" | "citations" | "fanout" | "inputTokens" | "outputTokens" | "searchCalls">;

function dedupeCitations(list: EngineCitation[]): EngineCitation[] {
  const seen = new Map<string, EngineCitation>();
  for (const c of list) {
    if (!c.url || !/^https?:\/\//i.test(c.url)) continue;
    const key = canonicalUrl(c.url);
    const prev = seen.get(key);
    // "cited" wins over "used" for the same URL.
    if (!prev) seen.set(key, { ...c, url: key });
    else if (prev.kind === "used" && c.kind === "cited") seen.set(key, { ...prev, kind: "cited", title: c.title ?? prev.title });
  }
  return [...seen.values()];
}

// ------------------------------------------------------------------ ChatGPT (OpenAI Responses + web search)

interface OpenAIResponse {
  model?: string;
  output?: Array<{
    type: string;
    action?: { type?: string; query?: string; queries?: string[]; sources?: Array<{ url?: string; title?: string }> };
    content?: Array<{ type: string; text?: string; annotations?: Array<{ type: string; url?: string; title?: string }> }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function parseOpenAI(body: OpenAIResponse): Parsed {
  const texts: string[] = [];
  const citations: EngineCitation[] = [];
  const fanout: Parsed["fanout"] = [];
  let searchCalls = 0;
  for (const item of body.output ?? []) {
    if (item.type === "web_search_call") {
      searchCalls++;
      const qs = [item.action?.query, ...(item.action?.queries ?? [])].filter((q): q is string => !!q);
      for (const q of qs) fanout.push({ query: q, kind: "search" });
      for (const s of item.action?.sources ?? []) if (s.url) citations.push({ url: s.url, title: s.title, kind: "used" });
    }
    if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type === "output_text" && c.text) {
          texts.push(c.text);
          for (const a of c.annotations ?? []) {
            if (a.type === "url_citation" && a.url) citations.push({ url: a.url, title: a.title, kind: "cited" });
          }
        }
      }
    }
  }
  return {
    text: texts.join("\n\n"),
    citations: dedupeCitations(citations),
    fanout,
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
    searchCalls,
  };
}

// ------------------------------------------------------------------ Claude (Anthropic Messages + web_search tool)

interface AnthropicResponse {
  model?: string;
  content?: Array<{
    type: string;
    text?: string;
    name?: string;
    input?: { query?: string };
    content?: Array<{ type: string; url?: string; title?: string }> | { type: string; error_code?: string };
    citations?: Array<{ type: string; url?: string; title?: string }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number; server_tool_use?: { web_search_requests?: number } };
}

export function parseAnthropic(body: AnthropicResponse): Parsed {
  const texts: string[] = [];
  const citations: EngineCitation[] = [];
  const fanout: Parsed["fanout"] = [];
  for (const block of body.content ?? []) {
    if (block.type === "server_tool_use" && block.name === "web_search" && block.input?.query) {
      fanout.push({ query: block.input.query, kind: "search" });
    }
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) if (r.type === "web_search_result" && r.url) citations.push({ url: r.url, title: r.title, kind: "used" });
    }
    if (block.type === "text" && block.text) {
      texts.push(block.text);
      for (const c of block.citations ?? []) if (c.url) citations.push({ url: c.url, title: c.title, kind: "cited" });
    }
  }
  return {
    text: texts.join(""),
    citations: dedupeCitations(citations),
    fanout,
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
    searchCalls: body.usage?.server_tool_use?.web_search_requests ?? fanout.length,
  };
}

// ------------------------------------------------------------------ Gemini (Gemini API + Google Search grounding)

interface GeminiResponse {
  modelVersion?: string;
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      groundingSupports?: Array<{ groundingChunkIndices?: number[] }>;
    };
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export function parseGemini(body: GeminiResponse): Parsed {
  const cand = body.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  const gm = cand?.groundingMetadata;
  const supported = new Set<number>();
  for (const s of gm?.groundingSupports ?? []) for (const i of s.groundingChunkIndices ?? []) supported.add(i);
  const citations: EngineCitation[] = [];
  (gm?.groundingChunks ?? []).forEach((ch, i) => {
    if (!ch.web?.uri) return;
    // Gemini returns redirect URIs; the title carries the source domain. resolveGeminiRedirects() swaps in the real URL.
    citations.push({ url: ch.web.uri, title: ch.web.title, kind: supported.has(i) ? "cited" : "used" });
  });
  return {
    text,
    citations,
    fanout: (gm?.webSearchQueries ?? []).map((q) => ({ query: q, kind: "search" as const })),
    inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
    searchCalls: gm?.webSearchQueries?.length ? 1 : 0,
  };
}

/** Follow Google's grounding redirect once (no body download) to learn the real source URL. */
export async function resolveGeminiRedirects(citations: EngineCitation[], fetcher: typeof fetch = fetch): Promise<EngineCitation[]> {
  const out: EngineCitation[] = [];
  for (const c of citations.slice(0, 12)) {
    if (!/grounding-api-redirect/.test(c.url)) {
      out.push(c);
      continue;
    }
    try {
      const res = await fetcher(c.url, { method: "HEAD", redirect: "manual" });
      const loc = res.headers.get("location");
      out.push(loc && /^https?:\/\//.test(loc) ? { ...c, url: loc } : titleAsUrl(c));
    } catch {
      out.push(titleAsUrl(c));
    }
  }
  return dedupeCitations(out);
}

function titleAsUrl(c: EngineCitation): EngineCitation {
  const t = (c.title ?? "").trim();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(t) ? { ...c, url: `https://${t}/` } : c;
}

// ------------------------------------------------------------------ Perplexity (Sonar)

interface PerplexityResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
  search_results?: Array<{ url?: string; title?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function parsePerplexity(body: PerplexityResponse): Parsed {
  const text = body.choices?.[0]?.message?.content ?? "";
  const cited = new Set(body.citations ?? []);
  const citations: EngineCitation[] = [...cited].map((url) => ({
    url,
    title: body.search_results?.find((s) => s.url === url)?.title,
    kind: "cited" as const,
  }));
  for (const s of body.search_results ?? []) if (s.url && !cited.has(s.url)) citations.push({ url: s.url, title: s.title, kind: "used" });
  return {
    text,
    citations: dedupeCitations(citations),
    fanout: [],
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
    searchCalls: 1,
  };
}

// ------------------------------------------------------------------ engine objects

/**
 * An engine is live when its provider key is set, or when AI Gateway unified billing pays that provider.
 * Unified billing covers OpenAI, Anthropic and Google AI Studio, not Perplexity, so Perplexity always needs
 * its own key. https://developers.cloudflare.com/ai-gateway/features/unified-billing/
 */
function hasKey(env: Env, key: string | undefined, unifiedBilling = true): boolean {
  return !!key || (unifiedBilling && env.AIG_UNIFIED_BILLING === "true" && gatewayEnabled(env));
}

function wrap(parsed: Parsed, model: string, res: { logId: string | null; latencyMs: number }, raw: unknown): EngineAnswer {
  if (!parsed.text.trim()) throw new EngineError("Engine returned an empty answer", true);
  return { ...parsed, model, aigLogId: res.logId, latencyMs: res.latencyMs, channel: "api", raw };
}

export const chatgpt: Engine = {
  id: "chatgpt",
  label: "ChatGPT",
  vendor: "OpenAI",
  channel: (env) => (hasKey(env, env.OPENAI_API_KEY) ? "api" : "stub"),
  note: (env) =>
    hasKey(env, env.OPENAI_API_KEY)
      ? "OpenAI Responses API with web search, through AI Gateway."
      : "No OpenAI key set; answers come from the labelled stub engine.",
  async ask(prompt, ctx) {
    const { env } = ctx;
    if (this.channel(env) === "stub") return stubAnswer("chatgpt", prompt, ctx);
    const headers = gatewayHeaders(env, ctx, "chatgpt");
    if (env.OPENAI_API_KEY) headers.authorization = `Bearer ${env.OPENAI_API_KEY}`;
    const model = env.OPENAI_MODEL;
    const res = await postJson<OpenAIResponse>(`${providerBase(env, "openai")}/responses`, headers, {
      model,
      input: prompt,
      tools: [{ type: "web_search", user_location: { type: "approximate", country: ctx.country } }],
      include: ["web_search_call.action.sources"],
      store: false,
    });
    return wrap(parseOpenAI(res.body), res.body.model ?? model, res, res.body);
  },
};

export const claude: Engine = {
  id: "claude",
  label: "Claude",
  vendor: "Anthropic",
  channel: (env) => (hasKey(env, env.ANTHROPIC_API_KEY) ? "api" : "stub"),
  note: (env) =>
    hasKey(env, env.ANTHROPIC_API_KEY)
      ? "Anthropic Messages API with the web search tool, through AI Gateway."
      : "No Anthropic key set; answers come from the labelled stub engine.",
  async ask(prompt, ctx) {
    const { env } = ctx;
    if (this.channel(env) === "stub") return stubAnswer("claude", prompt, ctx);
    const headers = gatewayHeaders(env, ctx, "claude");
    headers["anthropic-version"] = "2023-06-01";
    if (env.ANTHROPIC_API_KEY) headers["x-api-key"] = env.ANTHROPIC_API_KEY;
    const model = env.ANTHROPIC_MODEL;
    const res = await postJson<AnthropicResponse>(`${providerBase(env, "anthropic")}/v1/messages`, headers, {
      model,
      max_tokens: 1600,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5, user_location: { type: "approximate", country: ctx.country } }],
    });
    return wrap(parseAnthropic(res.body), res.body.model ?? model, res, res.body);
  },
};

export const gemini: Engine = {
  id: "gemini",
  label: "Gemini",
  vendor: "Google",
  channel: (env) => (hasKey(env, env.GEMINI_API_KEY) ? "api" : "stub"),
  note: (env) =>
    hasKey(env, env.GEMINI_API_KEY)
      ? "Gemini API with Google Search grounding, through AI Gateway."
      : "No Gemini key set; answers come from the labelled stub engine.",
  async ask(prompt, ctx) {
    const { env } = ctx;
    if (this.channel(env) === "stub") return stubAnswer("gemini", prompt, ctx);
    const headers = gatewayHeaders(env, ctx, "gemini");
    if (env.GEMINI_API_KEY) headers["x-goog-api-key"] = env.GEMINI_API_KEY;
    const model = env.GEMINI_MODEL;
    const res = await postJson<GeminiResponse>(
      `${providerBase(env, "google-ai-studio")}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers,
      { contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }] },
    );
    const parsed = parseGemini(res.body);
    parsed.citations = await resolveGeminiRedirects(parsed.citations);
    return wrap(parsed, res.body.modelVersion ?? model, res, res.body);
  },
};

export const perplexity: Engine = {
  id: "perplexity",
  label: "Perplexity",
  vendor: "Perplexity",
  channel: (env) => (hasKey(env, env.PERPLEXITY_API_KEY, false) ? "api" : "stub"),
  note: (env) =>
    hasKey(env, env.PERPLEXITY_API_KEY, false) ? "Perplexity Sonar, through AI Gateway." : "No Perplexity key set; answers come from the labelled stub engine.",
  async ask(prompt, ctx) {
    const { env } = ctx;
    if (this.channel(env) === "stub") return stubAnswer("perplexity", prompt, ctx);
    const headers = gatewayHeaders(env, ctx, "perplexity");
    if (env.PERPLEXITY_API_KEY) headers.authorization = `Bearer ${env.PERPLEXITY_API_KEY}`;
    const model = env.PERPLEXITY_MODEL;
    const res = await postJson<PerplexityResponse>(`${providerBase(env, "perplexity-ai")}/chat/completions`, headers, {
      model,
      messages: [{ role: "user", content: prompt }],
      web_search_options: { user_location: { country: ctx.country } },
    });
    return wrap(parsePerplexity(res.body), res.body.model ?? model, res, res.body);
  },
};

/**
 * Alexa+ answers live behind a signed-in Amazon account, and Amazon's Alexa developer APIs are for building
 * into Alexa, not for asking it questions. There is no sanctioned way to collect its answers, so the engine is
 * listed (clients ask for it) and reported as unavailable instead of being scraped.
 */
export const alexa: Engine = {
  id: "alexa",
  label: "Alexa",
  vendor: "Amazon",
  channel: () => "unavailable",
  note: () => "Not trackable yet: Amazon offers no public way to ask Alexa+ a question and read the answer.",
  async ask() {
    throw new EngineError("Alexa is not trackable", false);
  },
};
