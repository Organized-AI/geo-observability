// Chats: every answer we collected, with a detail drawer that highlights brands and numbers citations.
import { h, clear, fmt, plural, isNumber, badge, segmented, skeleton, errorBox, empty, drawer, safeUrl, escapeRegExp, icon } from "../dom.js";
import { api } from "../api.js";
import { reveal } from "../anim.js";
import { pageHead, engineBadge, channelBadge, sentimentBadge, verdictBadge, brandsFor, needProject } from "./common.js";

// Excerpts are raw model text; drop Markdown markers so "**Acme**" reads as "Acme" in the list.
const plainExcerpt = (t) => String(t).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();

function chatRow(ctx, c) {
  const mentions = (c.mentions || []).slice().sort((a, b) => (a.rank || 99) - (b.rank || 99));
  return h("li", null, h("button", { type: "button", class: "chat-row", onclick: () => openChat(ctx, c.run_id) },
    h("span", { class: "chat-meta" }, engineBadge(ctx, c.engine), c.channel === "stub" ? channelBadge("stub") : null,
      c.country ? h("span", { class: "muted small" }, c.country) : null, h("span", { class: "muted small" }, fmt.date(c.run_date)),
      h("span", { class: "muted small chat-cites" }, plural(c.citations_count, "citation"))),
    h("span", { class: "chat-prompt" }, c.prompt),
    c.excerpt ? h("span", { class: "chat-excerpt clamp-2" }, plainExcerpt(c.excerpt)) : null,
    h("span", { class: "chat-mentions" }, mentions.length
      ? mentions.slice(0, 5).map((m) => h("span", { class: "mention-chip" }, isNumber(m.rank) ? h("span", { class: "num" }, `#${m.rank}`) : null, m.brand_name))
      : h("span", { class: "muted small" }, "No tracked brands named"))));
}

export default async function chats(ctx) {
  if (needProject(ctx)) return;
  const mentioned = ctx.q.get("mentioned") || "";
  ctx.el.append(pageHead("Chats", "Every answer collected for your prompts in this range. Open one to read it in full."));
  ctx.el.append(h("div", { class: "toolbar" }, segmented([["", "All answers"], ["own", "Mentioned you"], ["not_own", "Didn't mention you"]], mentioned, (id) => ctx.setQuery({ mentioned: id || null, run: null }), "Mention filter")));
  const list = h("ul", { class: "chat-list" });
  const more = h("div", { class: "load-more" });
  const box = h("div", null, skeleton(6));
  ctx.el.append(box);
  let cursor = null;

  const page = async (first) => {
    const q = ctx.fq({ mentioned, limit: 50, cursor });
    try {
      const r = await api(`projects/${ctx.pid}/chats`, { query: q });
      if (!ctx.alive()) return;
      const items = (r && r.items) || [];
      if (first) {
        clear(box);
        if (!items.length) {
          box.append(empty(mentioned === "own" ? "You weren't mentioned in this range" : "No answers in this range",
            "Try a wider date range or fewer filters. New answers arrive after each scheduled pass."));
          return;
        }
        box.append(list, more);
      }
      const rows = items.map((c) => chatRow(ctx, c));
      list.append(...rows);
      reveal(rows.slice(0, 30), { y: 6, stagger: 0.02 });
      cursor = r.next_cursor || null;
      clear(more);
      if (cursor) more.append(h("button", { type: "button", class: "btn", onclick: (e) => { e.target.disabled = true; page(false); } }, "Load more"));
    } catch (err) {
      if (first) clear(box).append(errorBox(err, () => { clear(box).append(skeleton(6)); page(true); }));
      else clear(more).append(errorBox(err, () => page(false)));
    }
  };
  await page(true);
  const run = ctx.q.get("run");
  if (run && ctx.alive()) {
    openChat(ctx, run);
    // Drop ?run= so later filter changes don't reopen the drawer.
    const q = new URLSearchParams(ctx.q);
    q.delete("run");
    history.replaceState(null, "", `#/chats${q.toString() ? `?${q}` : ""}`);
  }
}

// Split text into safe nodes: brand names become <mark>, [n] markers become citation links.
function highlight(text, names, ownNames) {
  const frag = document.createDocumentFragment();
  const alts = [...names].filter((n) => n && n.length > 1).sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp(`${alts.length ? `((?<![\\p{L}\\p{N}])(?:${alts.join("|")})(?![\\p{L}\\p{N}]))|` : ""}\\[(\\d{1,2})\\]`, "giu");
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (alts.length && m[1]) {
      const own = ownNames.has(m[1].toLowerCase());
      frag.append(h("mark", { class: own ? "mark-own" : "mark-brand" }, m[1]));
    } else {
      const n = m[alts.length ? 2 : 1];
      frag.append(h("sup", { class: "cite-ref" }, h("a", { href: `#cite-${n}`, onclick: (e) => { e.preventDefault(); document.getElementById(`cite-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); } }, n)));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function answerBody(text, names, ownNames) {
  const box = h("div", { class: "answer" });
  const clean = String(text || "").replace(/\r\n/g, "\n").replace(/\*\*(.+?)\*\*/g, "$1");
  for (const block of clean.split(/\n{2,}/)) {
    const t = block.trim();
    if (!t) continue;
    const head = /^#{1,6}\s+/.test(t);
    const el = h(head ? "h4" : "p", null);
    el.append(highlight(head ? t.replace(/^#{1,6}\s+/, "") : t, names, ownNames));
    box.append(el);
  }
  if (!box.childNodes.length) box.append(h("p", { class: "muted" }, "The answer text isn't available for this run."));
  return box;
}

export async function openChat(ctx, runId) {
  drawer("Answer detail", async (body) => {
    body.append(skeleton(8));
    try {
      const [d, brands] = await Promise.all([api(`projects/${ctx.pid}/chats/${encodeURIComponent(runId)}`), brandsFor(ctx.pid)]);
      clear(body);
      const run = d.run || {};
      const prompt = d.prompt && typeof d.prompt === "object" ? d.prompt.text : d.prompt || run.prompt;
      const mentions = (d.mentions || []).slice().sort((a, b) => (a.rank || 99) - (b.rank || 99));
      const names = new Set(), ownNames = new Set();
      const mentionedIds = new Set(mentions.map((m) => m.brand_id));
      for (const m of mentions) if (m.brand_name) names.add(m.brand_name);
      for (const b of brands) {
        if (!mentionedIds.has(b.id) && !b.is_own) continue;
        for (const n of [b.name, ...(b.aliases || [])]) {
          if (!n) continue;
          names.add(n);
          if (b.is_own) ownNames.add(String(n).toLowerCase());
        }
      }
      const cites = (d.citations || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
      body.append(
        h("p", { class: "eyebrow-sm" }, "Prompt"),
        h("h3", { class: "drawer-prompt" }, prompt || "Prompt text unavailable"),
        h("div", { class: "chat-meta wrap" },
          run.engine ? engineBadge(ctx, run.engine) : null, channelBadge(run.channel),
          run.model ? h("span", { class: "badge mono" }, run.model) : null,
          run.country ? badge(run.country) : null,
          h("span", { class: "muted small" }, fmt.dateLong(run.run_date || run.created_at))),
        run.channel === "stub" ? h("p", { class: "notice notice-warn" }, icon("alert"), h("span", null, "This answer came from the stub engine because no live key is configured for this engine. It's sample text for testing the pipeline, not a real model response.")) : null,
        h("h4", { class: "section-label" }, "Brands named"),
        mentions.length ? h("div", { class: "chips" }, mentions.map((m) => h("span", { class: "mention-chip" }, isNumber(m.rank) ? h("span", { class: "num" }, `#${m.rank}`) : null, m.brand_name, sentimentBadge(m.sentiment))))
          : h("p", { class: "muted" }, "No tracked brands were named in this answer."),
        h("h4", { class: "section-label" }, "Answer"),
        answerBody(d.answer_text, names, ownNames));
      body.append(h("h4", { class: "section-label" }, `Citations (${cites.length})`));
      if (cites.length) {
        body.append(h("ol", { class: "cite-list" }, cites.map((c, i) => {
          const n = c.position || i + 1;
          const href = safeUrl(c.url);
          return h("li", { id: `cite-${n}` }, h("span", { class: "cite-n num" }, String(n)),
            h("div", null,
              href ? h("a", { href, target: "_blank", rel: "noopener noreferrer nofollow" }, c.title || c.url) : h("span", null, c.title || c.url),
              h("p", { class: "muted small" }, c.domain || "", c.kind ? " · " : "", c.kind ? fmt.label(c.kind) : "")));
        })));
      } else body.append(h("p", { class: "muted" }, "This answer didn't cite any sources."));
      const fan = d.fanout || [];
      if (fan.length) body.append(h("h4", { class: "section-label" }, "Fan-out queries"), h("p", { class: "muted small" }, "Searches the assistant ran behind the scenes to build this answer."),
        h("ul", { class: "plain-list" }, fan.map((f) => h("li", null, f.kind ? badge(fmt.label(f.kind)) : null, " ", f.query))));
      const claims = d.claims || [];
      if (claims.length) body.append(h("h4", { class: "section-label" }, "Claims about brands"),
        h("ul", { class: "plain-list claims" }, claims.map((c) => h("li", null, verdictBadge(c.verdict), c.kind ? h("span", { class: "muted small" }, ` ${fmt.label(c.kind)} · `) : " ", c.claim))));
    } catch (err) {
      clear(body).append(errorBox(err, () => openChat(ctx, runId)));
    }
  });
}
