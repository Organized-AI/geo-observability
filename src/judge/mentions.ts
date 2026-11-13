import { clamp } from "../lib/util";

export interface BrandMatcher {
  id: string;
  name: string;
  aliases: string[];
  regex?: string | null;
  domains: string[];
  isOwn: boolean;
}

export interface FoundMention {
  brandId: string;
  brandName: string;
  rank: number;
  index: number;
  snippet: string;
  sentiment: number;
}

const MAX_TEXT = 40_000;

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Markdown emphasis and links get in the way of matching "**Acme**" or "[Acme](...)". */
export function plainText(text: string): string {
  return text
    .slice(0, MAX_TEXT)
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\r/g, "");
}

export function brandPatterns(b: BrandMatcher): RegExp[] {
  const names = [b.name, ...b.aliases].map((n) => n.trim()).filter((n) => n.length >= 2);
  const out = names.map((n) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(n)}(?![\\p{L}\\p{N}])`, "iu"));
  if (b.regex && b.regex.length <= 200) {
    try {
      out.push(new RegExp(b.regex, "iu"));
    } catch {
      /* an invalid pattern saved by a user is ignored rather than failing the run */
    }
  }
  return out;
}

function sentenceAround(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf("\n", index), text.lastIndexOf(". ", index) + 1, 0);
  let end = text.length;
  for (const sep of ["\n", ". "]) {
    const e = text.indexOf(sep, index);
    if (e !== -1 && e < end) end = e + 1;
  }
  return text.slice(start, end).trim().slice(0, 280);
}

const POS = /\b(best|leading|top|recommended|excellent|great|reliable|praised|popular|strong|easy|intuitive|trusted|affordable|standout|stands out|favorite|favourite|powerful|robust|loved|highly rated|solid)\b/gi;
const NEG = /\b(expensive|pricey|steep|complaints?|mixed|lacks?|limited|slow|buggy|poor|worse|difficult|confusing|outdated|issues?|drawbacks?|downsides?|criticized|criticised|unreliable|clunky)\b/gi;

/** Rules fallback: 50 is neutral, each positive or negative cue moves it 12 points. */
export function ruleSentiment(snippet: string): number {
  const pos = snippet.match(POS)?.length ?? 0;
  const neg = snippet.match(NEG)?.length ?? 0;
  return clamp(50 + 12 * (pos - neg), 5, 95);
}

/**
 * Finds tracked brands in an answer. Rank follows the order of first appearance, which is how a reader
 * meets them. Deterministic on purpose: mention and position are the numbers clients compare most, so they
 * shouldn't move when a model has a different day.
 */
export function findMentions(answer: string, brands: BrandMatcher[]): FoundMention[] {
  const text = plainText(answer);
  const hits: Omit<FoundMention, "rank">[] = [];
  for (const b of brands) {
    let best = -1;
    for (const re of brandPatterns(b)) {
      const m = re.exec(text);
      if (m && (best === -1 || m.index < best)) best = m.index;
    }
    if (best === -1) continue;
    const snippet = sentenceAround(text, best);
    hits.push({ brandId: b.id, brandName: b.name, index: best, snippet, sentiment: ruleSentiment(snippet) });
  }
  hits.sort((a, b) => a.index - b.index);
  return hits.map((h, i) => ({ ...h, rank: i + 1 }));
}

const UGC = ["reddit.com", "quora.com", "youtube.com", "x.com", "twitter.com", "facebook.com", "linkedin.com", "tiktok.com", "instagram.com", "medium.com", "stackoverflow.com", "stackexchange.com", "github.com", "discord.com", "g2.com", "capterra.com", "trustpilot.com", "yelp.com", "tripadvisor.com", "producthunt.com"];
const REFERENCE = ["wikipedia.org", "wikidata.org", "britannica.com", "investopedia.com", "merriam-webster.com", "dictionary.com", "webmd.com", "mayoclinic.org"];
const EDITORIAL = ["forbes.com", "techradar.com", "pcmag.com", "nytimes.com", "wsj.com", "theverge.com", "wired.com", "cnet.com", "zdnet.com", "businessinsider.com", "bloomberg.com", "reuters.com", "techcrunch.com", "nerdwallet.com", "tomsguide.com", "engadget.com", "theguardian.com", "bbc.co.uk", "bbc.com", "cnbc.com", "fastcompany.com", "inc.com", "entrepreneur.com"];

function endsWithAny(domain: string, list: string[]): boolean {
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export function classifyDomain(domain: string, brands: BrandMatcher[]): string {
  const d = domain.toLowerCase();
  for (const b of brands) {
    if (b.domains.some((bd) => d === bd.toLowerCase() || d.endsWith(`.${bd.toLowerCase()}`))) return b.isOwn ? "own" : "competitor";
  }
  if (endsWithAny(d, UGC)) return "ugc";
  if (endsWithAny(d, REFERENCE)) return "reference";
  if (/\.(gov|edu|mil)(\.[a-z]{2})?$/.test(d) || /\.(gov|ac)\.[a-z]{2}$/.test(d)) return "institutional";
  if (endsWithAny(d, EDITORIAL)) return "editorial";
  return "other";
}
