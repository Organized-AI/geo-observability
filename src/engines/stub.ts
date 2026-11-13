import type { EngineAnswer, EngineContext, EngineId } from "./types";

/**
 * The stub engine writes plausible sample answers so the portal, scoring and tests work with no provider
 * keys. Every stub run is stored with channel = "stub" and labelled in the portal. Output is deterministic
 * for a given run id, so tests and demo data are reproducible.
 */
export function rng(seedText: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    h ^= seedText.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRAISE = [
  "is widely recommended for its reliability",
  "stands out for ease of use and strong support",
  "is a solid all-round choice with good reviews",
  "is praised for transparent pricing",
  "is a popular pick with a large community",
];
const NEUTRAL = ["is another option worth comparing", "covers the basics", "is often listed alongside the others"];
const CRITICAL = [
  "is capable but some users report a steep learning curve",
  "can get expensive as you scale",
  "has mixed reviews about customer support",
];
const SOURCES = [
  "https://www.reddit.com/r/smallbusiness/comments/",
  "https://en.wikipedia.org/wiki/",
  "https://www.youtube.com/watch?v=",
  "https://www.forbes.com/advisor/",
  "https://www.g2.com/categories/",
  "https://www.capterra.com/",
  "https://www.techradar.com/best/",
  "https://www.pcmag.com/picks/",
];

// Each engine leans a little differently so the demo shows per-engine variation.
const ENGINE_BIAS: Record<EngineId, number> = { chatgpt: 0.62, claude: 0.48, gemini: 0.55, perplexity: 0.7, alexa: 0 };

export function stubAnswer(engine: EngineId, prompt: string, ctx: EngineContext): EngineAnswer {
  const r = rng(`${ctx.runId}|${prompt}`);
  const brands = [...ctx.brands];
  // Shuffle.
  for (let i = brands.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [brands[i], brands[j]] = [brands[j], brands[i]];
  }
  const own = brands.find((b) => b.isOwn);
  const includeOwn = own ? r() < ENGINE_BIAS[engine] : false;
  let picked = brands.filter((b) => !b.isOwn).slice(0, 2 + Math.floor(r() * 3));
  if (own && includeOwn) {
    const at = Math.floor(r() * Math.min(picked.length + 1, 3));
    picked = [...picked.slice(0, at), own, ...picked.slice(at)];
  }

  const lines: string[] = [];
  lines.push(`Here are some options people commonly consider for "${prompt.replace(/\?$/, "")}":`);
  lines.push("");
  const citations: EngineAnswer["citations"] = [];
  picked.forEach((b, i) => {
    const roll = r();
    const phrase = roll < 0.55 ? PRAISE[Math.floor(r() * PRAISE.length)] : roll < 0.85 ? NEUTRAL[Math.floor(r() * NEUTRAL.length)] : CRITICAL[Math.floor(r() * CRITICAL.length)];
    lines.push(`${i + 1}. **${b.name}** ${phrase}.`);
    if (b.domains[0] && r() < 0.6) {
      const page = ["", "pricing", "features", "blog/guide", "compare"][Math.floor(r() * 5)];
      citations.push({ url: `https://${b.domains[0]}/${page}`, title: `${b.name}${page ? ` – ${page}` : ""}`, kind: "cited" });
    }
  });
  lines.push("");
  lines.push("The best fit depends on your budget, team size and the integrations you need.");

  const nSources = 2 + Math.floor(r() * 3);
  for (let i = 0; i < nSources; i++) {
    const base = SOURCES[Math.floor(r() * SOURCES.length)];
    const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    citations.push({ url: `${base}${slug}`, title: undefined, kind: r() < 0.7 ? "cited" : "used" });
  }

  const text = lines.join("\n");
  return {
    text,
    citations: dedupe(citations),
    fanout: [{ query: prompt.toLowerCase().slice(0, 80), kind: "search" }, { query: `best ${prompt.toLowerCase().split(" ").slice(-3).join(" ")}`, kind: "search" }],
    model: `stub-${engine}`,
    inputTokens: 0,
    outputTokens: 0,
    searchCalls: 0,
    aigLogId: null,
    latencyMs: 0,
    channel: "stub",
    raw: { stub: true },
  };
}

function dedupe(c: EngineAnswer["citations"]): EngineAnswer["citations"] {
  const m = new Map<string, EngineAnswer["citations"][number]>();
  for (const x of c) if (!m.has(x.url)) m.set(x.url, x);
  return [...m.values()];
}
