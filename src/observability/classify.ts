/**
 * AI crawler and AI referral classification, shared by the edge tap Worker, tap.js ingest and server ingest.
 * Bot types: training (collects data to train models), search (builds an AI search index),
 * user (fetches a page live because a person asked the assistant something).
 * Keep this list current: operators add and rename agents. Matching is on the User-Agent string.
 */
export type BotType = "training" | "search" | "user";

export interface BotRule {
  bot: string;
  operator: string;
  type: BotType;
  pattern: RegExp;
}

export const BOT_RULES: BotRule[] = [
  { bot: "ChatGPT-User", operator: "openai", type: "user", pattern: /ChatGPT-User/i },
  { bot: "OAI-SearchBot", operator: "openai", type: "search", pattern: /OAI-SearchBot/i },
  { bot: "GPTBot", operator: "openai", type: "training", pattern: /GPTBot/i },
  { bot: "Claude-User", operator: "anthropic", type: "user", pattern: /Claude-User/i },
  { bot: "Claude-SearchBot", operator: "anthropic", type: "search", pattern: /Claude-SearchBot/i },
  { bot: "ClaudeBot", operator: "anthropic", type: "training", pattern: /ClaudeBot|anthropic-ai/i },
  { bot: "Perplexity-User", operator: "perplexity", type: "user", pattern: /Perplexity-User/i },
  { bot: "PerplexityBot", operator: "perplexity", type: "search", pattern: /PerplexityBot/i },
  { bot: "Google-CloudVertexBot", operator: "google", type: "user", pattern: /Google-CloudVertexBot/i },
  { bot: "GoogleAgent-Mariner", operator: "google", type: "user", pattern: /GoogleAgent/i },
  { bot: "Gemini-Deep-Research", operator: "google", type: "user", pattern: /Gemini-Deep-Research/i },
  { bot: "MistralAI-User", operator: "mistral", type: "user", pattern: /MistralAI-User/i },
  { bot: "DuckAssistBot", operator: "duckduckgo", type: "user", pattern: /DuckAssistBot/i },
  { bot: "Meta-ExternalFetcher", operator: "meta", type: "user", pattern: /meta-externalfetcher/i },
  { bot: "Meta-ExternalAgent", operator: "meta", type: "training", pattern: /meta-externalagent/i },
  { bot: "Amazonbot", operator: "amazon", type: "search", pattern: /Amazonbot/i },
  { bot: "Applebot", operator: "apple", type: "search", pattern: /Applebot/i },
  { bot: "Bytespider", operator: "bytedance", type: "training", pattern: /Bytespider/i },
  { bot: "CCBot", operator: "commoncrawl", type: "training", pattern: /CCBot/i },
  { bot: "cohere-ai", operator: "cohere", type: "training", pattern: /cohere-(ai|training-data-crawler)/i },
  { bot: "YouBot", operator: "you", type: "search", pattern: /YouBot/i },
  { bot: "PhindBot", operator: "phind", type: "search", pattern: /PhindBot/i },
  { bot: "Diffbot", operator: "diffbot", type: "training", pattern: /Diffbot/i },
  { bot: "xAI-Bot", operator: "xai", type: "search", pattern: /xAI-Bot|GrokBot/i },
  { bot: "DeepSeekBot", operator: "deepseek", type: "search", pattern: /DeepSeekBot/i },
  { bot: "Bingbot", operator: "microsoft", type: "search", pattern: /bingbot/i },
];

export function classifyBot(ua: string | null | undefined): BotRule | null {
  if (!ua) return null;
  for (const r of BOT_RULES) if (r.pattern.test(ua)) return r;
  return null;
}

export type Assistant = "chatgpt" | "claude" | "perplexity" | "gemini" | "copilot" | "meta_ai" | "grok" | "deepseek" | "mistral" | "you" | "phind" | "other_ai";

const REFERRERS: [RegExp, Assistant][] = [
  [/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i, "chatgpt"],
  [/(^|\.)claude\.ai$/i, "claude"],
  [/(^|\.)perplexity\.ai$/i, "perplexity"],
  [/(^|\.)gemini\.google\.com$|(^|\.)bard\.google\.com$/i, "gemini"],
  [/(^|\.)copilot\.microsoft\.com$|(^|\.)copilot\.cloud\.microsoft$/i, "copilot"],
  [/(^|\.)meta\.ai$/i, "meta_ai"],
  [/(^|\.)grok\.com$/i, "grok"],
  [/(^|\.)chat\.deepseek\.com$/i, "deepseek"],
  [/(^|\.)chat\.mistral\.ai$/i, "mistral"],
  [/(^|\.)you\.com$/i, "you"],
  [/(^|\.)phind\.com$/i, "phind"],
];

const UTM: [RegExp, Assistant][] = [
  [/chatgpt|openai/i, "chatgpt"],
  [/claude|anthropic/i, "claude"],
  [/perplexity/i, "perplexity"],
  [/gemini|bard/i, "gemini"],
  [/copilot/i, "copilot"],
  [/meta\.ai|metaai/i, "meta_ai"],
  [/grok/i, "grok"],
  [/deepseek/i, "deepseek"],
  [/mistral/i, "mistral"],
];

/** Which AI assistant sent this visit, from the referrer host or utm_source. */
export function classifyReferral(referer: string | null | undefined, utmSource?: string | null): Assistant | null {
  if (referer) {
    try {
      const host = new URL(referer).hostname;
      for (const [re, a] of REFERRERS) if (re.test(host)) return a;
    } catch {
      /* not a URL */
    }
  }
  if (utmSource) for (const [re, a] of UTM) if (re.test(utmSource)) return a;
  return null;
}
