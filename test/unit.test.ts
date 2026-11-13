import { describe, expect, it } from "vitest";
import { findMentions, classifyDomain, ruleSentiment, type BrandMatcher } from "../src/judge/mentions";
import { normaliseJudge } from "../src/judge/llm";
import { parseAnthropic, parseGemini, parseOpenAI, parsePerplexity } from "../src/engines/providers";
import { classifyBot, classifyReferral } from "../src/observability/classify";
import { canonicalUrl, csvEscape, parseCsv } from "../src/lib/util";
import { allocate, templatePrompts } from "../src/onboarding/assist";
import { signShare, verifyShare } from "../src/lib/tokens";
import { estimateCostMicros, DEFAULT_PRICING } from "../src/engines/registry";
import { stubAnswer } from "../src/engines/stub";

const brands: BrandMatcher[] = [
  { id: "own", name: "Acme", aliases: ["Acme CRM"], regex: null, domains: ["acme.com"], isOwn: true },
  { id: "b1", name: "Globex", aliases: [], regex: null, domains: ["globex.com"], isOwn: false },
  { id: "b2", name: "Initech", aliases: ["Initrode"], regex: null, domains: ["initech.io"], isOwn: false },
];

describe("mention matching", () => {
  it("ranks brands by first appearance and reads markdown", () => {
    const m = findMentions("1. **Globex** is the most popular.\n2. [Acme](https://acme.com) is reliable.\n3. Initrode is pricey.", brands);
    expect(m.map((x) => [x.brandId, x.rank])).toEqual([
      ["b1", 1],
      ["own", 2],
      ["b2", 3],
    ]);
  });

  it("respects word boundaries", () => {
    expect(findMentions("Acmeville and GlobexCorp are towns.", brands)).toEqual([]);
  });

  it("uses a custom pattern", () => {
    const m = findMentions("Try ACME-Pro today", [{ ...brands[0], aliases: [], regex: "acme-?pro" }]);
    expect(m[0]?.brandId).toBe("own");
  });

  it("scores sentiment with the rules fallback", () => {
    expect(ruleSentiment("Acme is reliable and highly rated")).toBeGreaterThan(60);
    expect(ruleSentiment("Acme is expensive and has complaints")).toBeLessThan(40);
    expect(ruleSentiment("Acme exists")).toBe(50);
  });

  it("classifies source domains", () => {
    expect(classifyDomain("www.acme.com".replace("www.", ""), brands)).toBe("own");
    expect(classifyDomain("blog.globex.com", brands)).toBe("competitor");
    expect(classifyDomain("reddit.com", brands)).toBe("ugc");
    expect(classifyDomain("en.wikipedia.org", brands)).toBe("reference");
    expect(classifyDomain("nasa.gov", brands)).toBe("institutional");
    expect(classifyDomain("techradar.com", brands)).toBe("editorial");
  });
});

describe("judge output", () => {
  it("normalises JSON embedded in text and clamps scores", () => {
    const j = normaliseJudge('Sure: {"sentiments":[{"brand":"Acme","score":140}],"other_brands":["Hooli"],"attributes":[],"objections":[],"claims":[{"brand":"Acme","claim":"Free plan","verdict":"weird"}]}');
    expect(j?.sentiments[0].score).toBe(100);
    expect(j?.other_brands).toEqual(["Hooli"]);
    expect(j?.claims[0].verdict).toBe("unchecked");
    expect(normaliseJudge("no json here")).toBeNull();
  });
});

describe("provider parsers", () => {
  it("OpenAI Responses: cited annotations, used sources, searches", () => {
    const p = parseOpenAI({
      output: [
        { type: "web_search_call", action: { type: "search", query: "best crm", sources: [{ url: "https://a.com/x?utm_source=chatgpt.com" }, { url: "https://b.com" }] } },
        { type: "message", content: [{ type: "output_text", text: "Acme is good.", annotations: [{ type: "url_citation", url: "https://a.com/x", title: "A" }] }] },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(p.text).toBe("Acme is good.");
    expect(p.fanout).toEqual([{ query: "best crm", kind: "search" }]);
    expect(p.citations.find((c) => c.url === "https://a.com/x")?.kind).toBe("cited");
    expect(p.citations.find((c) => c.url.startsWith("https://b.com"))?.kind).toBe("used");
    expect(p.searchCalls).toBe(1);
  });

  it("Anthropic: web search results are used, text citations are cited", () => {
    const p = parseAnthropic({
      content: [
        { type: "server_tool_use", name: "web_search", input: { query: "crm for startups" } },
        { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://x.com/1", title: "X" }, { type: "web_search_result", url: "https://y.com/2" }] },
        { type: "text", text: "Globex leads.", citations: [{ type: "web_search_result_location", url: "https://x.com/1", title: "X" }] },
      ],
      usage: { input_tokens: 5, output_tokens: 6, server_tool_use: { web_search_requests: 1 } },
    });
    expect(p.citations).toEqual([
      { url: "https://x.com/1", title: "X", kind: "cited" },
      { url: "https://y.com/2", title: undefined, kind: "used" },
    ]);
    expect(p.fanout[0].query).toBe("crm for startups");
  });

  it("Gemini: grounding supports mark cited chunks", () => {
    const p = parseGemini({
      candidates: [
        {
          content: { parts: [{ text: "Initech" }, { text: " is fine." }] },
          groundingMetadata: {
            webSearchQueries: ["initech review"],
            groundingChunks: [{ web: { uri: "https://r.example/1", title: "initech.io" } }, { web: { uri: "https://r.example/2", title: "wiki.org" } }],
            groundingSupports: [{ groundingChunkIndices: [0] }],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
    });
    expect(p.text).toBe("Initech is fine.");
    expect(p.citations.map((c) => c.kind)).toEqual(["cited", "used"]);
  });

  it("Perplexity: citations vs search results", () => {
    const p = parsePerplexity({
      choices: [{ message: { content: "Acme [1]" } }],
      citations: ["https://acme.com/"],
      search_results: [{ url: "https://acme.com/", title: "Acme" }, { url: "https://other.com/" }],
    });
    expect(p.citations.map((c) => c.kind)).toEqual(["cited", "used"]);
  });
});

describe("observability classifiers", () => {
  it("bots by user agent", () => {
    expect(classifyBot("Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)")?.type).toBe("training");
    expect(classifyBot("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0")?.type).toBe("user");
    expect(classifyBot("OAI-SearchBot/1.0")?.type).toBe("search");
    expect(classifyBot("Claude-User/1.0")?.bot).toBe("Claude-User");
    expect(classifyBot("Mozilla/5.0 (Macintosh) Safari/605")).toBeNull();
  });
  it("referrals by host and utm_source", () => {
    expect(classifyReferral("https://chatgpt.com/")).toBe("chatgpt");
    expect(classifyReferral("https://www.perplexity.ai/search?q=x")).toBe("perplexity");
    expect(classifyReferral(null, "chatgpt.com")).toBe("chatgpt");
    expect(classifyReferral("https://www.google.com/")).toBeNull();
  });
});

describe("utilities", () => {
  it("parses CSV with quotes and CRLF", () => {
    expect(parseCsv('prompt,country\r\n"Best CRM, cheap",US\r\n"He said ""hi""",GB\n')).toEqual([
      ["prompt", "country"],
      ["Best CRM, cheap", "US"],
      ['He said "hi"', "GB"],
    ]);
  });
  it("neutralises spreadsheet formulas in CSV export", () => {
    expect(csvEscape("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
  });
  it("canonicalises URLs", () => {
    expect(canonicalUrl("https://a.com/p/?utm_source=chatgpt.com#x")).toBe("https://a.com/p");
  });
  it("allocates intent mix exactly", () => {
    const a = allocate(10, { informational: 0.25, commercial: 0.5, transactional: 0.25 });
    expect(a.informational + a.commercial + a.transactional).toBe(10);
    expect(a.commercial).toBe(5);
  });
  it("template prompts honour branded count", () => {
    const p = templatePrompts("Acme", ["crm"], 10, { informational: 3, commercial: 4, transactional: 3 }, 2);
    expect(p.filter((x) => x.branded)).toHaveLength(2);
    expect(p.every((x) => x.text.length <= 200)).toBe(true);
  });
  it("share tokens verify and reject tampering", async () => {
    const t = await signShare("s3cret", "shr_1", new Date(Date.now() + 60_000));
    expect(await verifyShare("s3cret", t)).toBe("shr_1");
    expect(await verifyShare("other", t)).toBeNull();
    expect(await verifyShare("s3cret", t.replace("shr_1", "shr_2"))).toBeNull();
    const old = await signShare("s3cret", "shr_1", new Date(Date.now() - 1000));
    expect(await verifyShare("s3cret", old)).toBeNull();
  });
  it("estimates cost from tokens and searches", () => {
    expect(estimateCostMicros(DEFAULT_PRICING, "claude", { inputTokens: 1_000_000, outputTokens: 0, searchCalls: 1 })).toBe(3_010_000);
  });
  it("stub engine is deterministic and labelled", () => {
    const ctx = { env: {} as never, tenantId: "t", projectId: "p", promptId: "q", runId: "r1", country: "US", language: "en", brands: brands.map((b) => ({ name: b.name, domains: b.domains, isOwn: b.isOwn })) };
    const a = stubAnswer("chatgpt", "best crm?", ctx);
    expect(stubAnswer("chatgpt", "best crm?", ctx).text).toBe(a.text);
    expect(a.channel).toBe("stub");
  });
});
