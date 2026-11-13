// My website: pages joined across AI crawler hits, citations, AI referral sessions and conversions.
import { h, clear, fmt, plural, table, skeleton, errorBox, empty, icon, card } from "../dom.js";
import { api } from "../api.js";
import { staggerRows, countUp } from "../anim.js";
import { lineChart, legend, bars, donut, pivot, seriesColor } from "../charts.js";
import { pageHead, needProject } from "./common.js";

// Referral ids from the classifier, shown with the names people know.
const ASSISTANT_LABELS = { chatgpt: "ChatGPT", claude: "Claude", perplexity: "Perplexity", gemini: "Gemini", copilot: "Copilot", meta_ai: "Meta AI", grok: "Grok", deepseek: "DeepSeek", mistral: "Mistral", you: "You.com", phind: "Phind", other_ai: "Other AI" };
const assistantLabel = (id) => ASSISTANT_LABELS[id] || id;

const BOT_TYPES = [["training", "Training", "var(--series-2)"], ["search", "Search", "var(--series-3)"], ["retrieval", "Retrieval", "var(--series-1)"]];
const botTypeKey = (t) => { const k = String(t || "").toLowerCase(); return k.startsWith("train") ? "training" : k.startsWith("search") ? "search" : k.startsWith("retriev") || k.startsWith("user") ? "retrieval" : k || "other"; };

function totalsRow(t) {
  const items = [
    ["Bot hits", t.bot_hits, fmt.int], ["Citations", t.citations, fmt.int], ["Citation rate", t.citation_rate, fmt.pct],
    ["AI sessions", t.sessions, fmt.int], ["Conversions", t.conversions, fmt.int], ["Revenue", t.revenue_micros, fmt.money],
  ];
  return h("div", { class: "kpis kpis-compact" }, items.map(([label, v, f]) => {
    const val = h("span", { class: "kpi-value num" }, f(v));
    requestAnimationFrame(() => countUp(val, v, f));
    return h("div", { class: "kpi" }, h("p", { class: "kpi-label" }, label), val);
  }));
}

function pagesTable(rows) {
  const t = table([
    { label: "", class: "col-expand", render: (r) => ((r.prompts || []).length ? h("button", { type: "button", class: "btn btn-ghost icon-btn btn-sm expand-btn", "aria-expanded": "false", "aria-label": `Show prompts that cited ${r.path}`, onclick: (e) => {
      const btn = e.currentTarget;
      const tr = btn.closest("tr");
      const sub = tr.nextElementSibling;
      const open = btn.getAttribute("aria-expanded") !== "true";
      btn.setAttribute("aria-expanded", String(open));
      sub.hidden = !open;
    } }, icon("chev")) : null) },
    { label: "Path", render: (r) => h("span", { class: "mono path-cell" }, r.path) },
    { label: "Bot hits", num: true, render: (r) => fmt.int(r.bot_hits) },
    { label: "Training", num: true, render: (r) => fmt.int(r.training_hits) },
    { label: "Search", num: true, render: (r) => fmt.int(r.search_hits) },
    { label: "Retrievals", num: true, render: (r) => fmt.int(r.retrievals) },
    { label: "Citations", num: true, render: (r) => fmt.int(r.citations) },
    { label: "Cited answers", num: true, render: (r) => fmt.int(r.cited_answers) },
    { label: "Citation rate", num: true, render: (r) => fmt.pct(r.citation_rate) },
    { label: "Sessions", num: true, render: (r) => fmt.int(r.sessions) },
    { label: "Conversions", num: true, render: (r) => fmt.int(r.conversions) },
    { label: "Revenue", num: true, render: (r) => fmt.money(r.revenue_micros) },
  ], rows, {
    label: "Pages",
    after: (r) => ((r.prompts || []).length ? h("tr", { class: "sub-row", hidden: true }, h("td", { colspan: 12 },
      h("p", { class: "muted small" }, "Prompts whose answers cited this page"),
      h("ul", { class: "plain-list" }, r.prompts.map((p) => h("li", null, h("span", { class: "num badge" }, `${fmt.int(p.citations)}×`), " ", p.text))))) : null),
  });
  return t;
}

export default async function website(ctx) {
  if (needProject(ctx)) return;
  ctx.el.append(pageHead("My website", "What AI crawlers read, which pages answers cite, and the visits and revenue that follow."));
  const body = h("div", { class: "stack" }, skeleton(3, "block"), skeleton(8));
  ctx.el.append(body);
  const q = { from: ctx.f.from, to: ctx.f.to };
  let pages, crawlers, referrals;
  try {
    [pages, crawlers, referrals] = await Promise.all([
      api(`projects/${ctx.pid}/website/pages`, { query: q }),
      api(`projects/${ctx.pid}/website/crawlers`, { query: q }),
      api(`projects/${ctx.pid}/website/referrals`, { query: q }),
    ]);
  } catch (err) {
    if (ctx.alive()) clear(body).append(errorBox(err, () => { clear(ctx.el); website(ctx); }));
    return;
  }
  if (!ctx.alive()) return;
  clear(body);
  const rows = (pages && pages.items) || [];
  const t = (pages && pages.totals) || {};
  const byBot = (crawlers && crawlers.by_bot) || [];
  const byAssistant = (referrals && referrals.by_assistant) || [];
  const nothing = !rows.length && !byBot.length && !byAssistant.length;
  if (nothing) {
    body.append(h("div", { class: "card" }, h("div", { class: "card-body" }, empty("No website data yet",
      "This page fills in once your site sends data: the tap.js snippet or the edge worker logs AI crawler hits and AI referral visits, and your server-side tagging sends conversions.",
      h("a", { class: "btn btn-primary", href: `#/setup?tab=tracking&p=${encodeURIComponent(ctx.pid)}` }, "Set up tracking")))));
    return;
  }
  body.append(totalsRow(t));

  const pagesCard = card("Pages", { class: "card-flush", actions: h("span", { class: "muted small" }, plural(rows.length, "page")) });
  if (rows.length) {
    const tbl = pagesTable(rows);
    pagesCard.querySelector(".card-body").append(tbl);
    requestAnimationFrame(() => staggerRows(tbl.querySelector("tbody")));
  } else pagesCard.querySelector(".card-body").append(empty("No page activity in this range", "Widen the date range to see pages with crawler hits, citations or visits."));
  body.append(pagesCard);

  // Crawlers
  const typeTotals = {};
  for (const b of byBot) { const k = botTypeKey(b.bot_type); typeTotals[k] = (typeTotals[k] || 0) + (b.hits || 0); }
  const typeSegs = BOT_TYPES.map(([k, label, color]) => ({ label, value: typeTotals[k] || 0, color }));
  if (typeTotals.other) typeSegs.push({ label: "Other", value: typeTotals.other, color: "var(--series-7)" });
  const trendRows = ((crawlers && crawlers.trend) || []).map((r) => ({ ...r, bot_type: botTypeKey(r.bot_type) }));
  const crawlTrend = h("div", { class: "chart-host" });
  const crawlCard = card("AI crawlers", {},
    h("div", { class: "split" },
      h("div", null, h("h3", { class: "sub-title" }, "By bot type"), donut(typeSegs, { label: "Crawler hits by bot type", sub: "hits" })),
      h("div", null, h("h3", { class: "sub-title" }, "By bot"), byBot.length
        ? bars([...byBot].sort((a, b) => b.hits - a.hits).slice(0, 10).map((b) => ({ label: h("span", null, b.bot, h("small", { class: "muted" }, ` · ${b.operator || ""}${b.bot_type ? ` · ${fmt.label(botTypeKey(b.bot_type))}` : ""}`)), value: b.hits })))
        : empty("No crawler hits in this range"))),
    h("h3", { class: "sub-title" }, "Hits by day"), crawlTrend);
  body.append(crawlCard);
  if (trendRows.length) {
    const names = Object.fromEntries(BOT_TYPES.map(([k, l]) => [k, l]));
    const { days, series } = pivot(trendRows, "bot_type", "hits", names);
    series.forEach((s) => { const bt = BOT_TYPES.find((b) => b[1] === s.name); if (bt) s.color = bt[2]; });
    requestAnimationFrame(() => { lineChart(crawlTrend, { series, days, yFormat: (v) => fmt.int(v), label: "AI crawler hits by day and bot type", height: 220 }); crawlTrend.after(legend(series)); });
  } else crawlTrend.append(h("p", { class: "chart-empty" }, "No crawler trend in this range."));

  // Referrals
  const refTrend = h("div", { class: "chart-host" });
  const refCard = card("AI referrals", {},
    byAssistant.length ? table([
      { label: "Assistant", render: (r) => h("span", { class: "brand-cell" }, h("span", { class: "dot", style: { background: seriesColor(byAssistant.indexOf(r)) } }), assistantLabel(r.assistant)) },
      { label: "Sessions", num: true, render: (r) => fmt.int(r.sessions) },
      { label: "Conversions", num: true, render: (r) => fmt.int(r.conversions) },
      { label: "Conv. rate", num: true, render: (r) => (r.sessions ? fmt.pct(r.conversions / r.sessions) : "–") },
      { label: "Revenue", num: true, render: (r) => fmt.money(r.revenue_micros) },
    ], byAssistant, { label: "Referrals by assistant" }) : empty("No AI referral sessions in this range", "Visits arriving from assistant links are counted here."),
    h("h3", { class: "sub-title" }, "Sessions by day"), refTrend);
  body.append(refCard);
  const rTrend = (referrals && referrals.trend) || [];
  if (rTrend.length) {
    const { days, series } = pivot(rTrend, "assistant", "sessions", Object.fromEntries(byAssistant.map((a) => [a.assistant, assistantLabel(a.assistant)])));
    const order = byAssistant.map((a) => a.assistant);
    series.forEach((s, i) => { const j = order.indexOf(s.name); s.color = seriesColor(j >= 0 ? j : i); });
    requestAnimationFrame(() => { lineChart(refTrend, { series, days, yFormat: (v) => fmt.int(v), label: "AI referral sessions by day and assistant", height: 220 }); refTrend.after(legend(series)); });
  } else refTrend.append(h("p", { class: "chart-empty" }, "No referral trend in this range."));
  if (!t.conversions && !byAssistant.some((a) => a.conversions)) {
    body.append(h("p", { class: "notice" }, icon("info"), h("span", null, "No conversions recorded yet. Send them from your server-side tagging so revenue lines up with pages and prompts. "), h("a", { href: `#/setup?tab=tracking&p=${encodeURIComponent(ctx.pid)}` }, "See tracking setup")));
  }
}
