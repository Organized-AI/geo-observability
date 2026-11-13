// Overview dashboard: KPIs, trend, leaderboard, engines, sources, chats, insights, actions.
// Widgets can be reordered (drag or arrow buttons) and saved as a view; the same renderer drives shared links.
import { h, clear, icon, fmt, plural, isNumber, table, badge, segmented, dialog, field, copyBtn, store, toast, skeleton, errorBox, empty, safeUrl } from "../dom.js";
import { api, linkUrl } from "../api.js";
import { countUp, flip, staggerRows, reveal } from "../anim.js";
import { lineChart, legend, bars, sparkline, seriesColor } from "../charts.js";
import { pageHead, engineBadge, severityBadge, impactDots, needProject } from "./common.js";

const WIDGETS = {
  insights: { title: "What changed", span: 12 },
  kpis: { title: "Key metrics", span: 12 },
  trend: { title: "Trend", span: 12 },
  leaderboard: { title: "Leaderboard", span: 7 },
  engines: { title: "Visibility by engine", span: 5 },
  sources: { title: "Top sources", span: 6 },
  chats: { title: "Recent chats", span: 6 },
  actions: { title: "Top actions", span: 12 },
};
const DEFAULT_ORDER = Object.keys(WIDGETS);

const KPIS = [
  ["visibility", "Visibility", "rate", "Share of answers that mention you"],
  ["share_of_voice", "Share of voice", "rate", "Your share of all tracked brand mentions"],
  ["position", "Position", "position", "Average rank when named. Lower is better"],
  ["sentiment", "Sentiment", "score", "Tone when you're named, 0 to 100"],
  ["win_rate", "Win rate", "rate", "Answers where you rank ahead of every competitor named"],
  ["cited_rate", "Cited rate", "rate", "Answers that cite a page on your domain"],
  ["answers", "Answers", "count", "Answers analysed in this period"],
];
const TREND_METRICS = [["visibility", "Visibility"], ["share_of_voice", "Share of voice"], ["position", "Position"], ["sentiment", "Sentiment"]];

const fmtFor = (kind) => (kind === "rate" ? fmt.pct : kind === "position" ? (v) => fmt.dec(v, 1) : kind === "score" ? (v) => fmt.dec(v, 0) : fmt.int);

function validOrder(order) {
  const o = Array.isArray(order) ? order.filter((id) => WIDGETS[id]) : [];
  for (const id of DEFAULT_ORDER) if (!o.includes(id)) o.push(id);
  return o;
}

function brandColors(data) {
  const map = new Map();
  let i = 1;
  for (const b of data.leaderboard || []) map.set(b.brand_id, b.is_own || b.brand_id === data.own_brand_id ? seriesColor(0) : seriesColor(i++));
  return map;
}

// ---------- widgets ----------
function kpiTile(key, label, kind, help, k, sparkVals) {
  const value = k && k.value, prev = k && k.prev;
  const format = fmtFor(kind);
  const val = h("span", { class: "kpi-value num" }, format(value));
  let delta = null;
  if (isNumber(value) && isNumber(prev)) {
    const d = value - prev;
    // Flat when the change rounds to zero at the precision shown, so a tile never reads "−0".
    const eps = kind === "rate" ? 0.0005 : kind === "count" || kind === "score" ? 0.5 : 0.05;
    const flat = Math.abs(d) < eps;
    const good = kind === "position" ? d < 0 : d > 0;
    const txt = kind === "rate" ? fmt.pts(d) : kind === "count" ? `${fmt.signed(d, 0)}${prev ? ` (${fmt.signed((d / prev) * 100, 0)}%)` : ""}` : fmt.signed(d, kind === "score" ? 0 : 1);
    const dir = flat ? "flat" : good ? "good" : "bad";
    delta = h("span", { class: `delta delta-${dir}`, "aria-label": flat ? "No change versus previous period" : `${d > 0 ? "Up" : "Down"} ${txt.replace(/^[+−]/, "")} versus previous period${kind === "position" ? ", lower is better" : ""}` },
      flat ? null : icon(d > 0 ? "up" : "down"), h("span", { class: "num", "aria-hidden": "true" }, flat ? "No change" : txt));
  }
  const tile = h("div", { class: "kpi", "data-kpi": key },
    h("p", { class: "kpi-label", title: help }, label),
    val, delta,
    sparkVals && sparkVals.length > 1 ? sparkline(sparkVals, { invert: kind === "position" }) : null,
    h("p", { class: "kpi-help" }, help));
  requestAnimationFrame(() => countUp(val, value, format));
  return tile;
}

function buildKpis(data) {
  const own = (data.trend || []).filter((t) => t.brand_id === data.own_brand_id).sort((a, b) => (a.day < b.day ? -1 : 1));
  const grid = h("div", { class: "kpis" });
  for (const [key, label, kind, help] of KPIS) {
    const spark = ["visibility", "share_of_voice", "position", "sentiment"].includes(key) ? own.map((t) => t[key]) : null;
    grid.append(kpiTile(key, label, kind, help, (data.kpis || {})[key], spark));
  }
  return grid;
}

function buildTrend(data, colors) {
  const box = h("div", { class: "trend" });
  const lb = data.leaderboard || [];
  const own = lb.find((b) => b.is_own || b.brand_id === data.own_brand_id);
  const comps = lb.filter((b) => b !== own).sort((a, b) => (b.visibility || 0) - (a.visibility || 0)).slice(0, 4);
  const brands = [own, ...comps].filter(Boolean);
  const days = [...new Set((data.trend || []).map((t) => t.day))].sort();
  let metric = "visibility";
  const chartHost = h("div", { class: "chart-host" });
  const draw = () => {
    const series = brands.map((b) => {
      const values = {};
      for (const t of data.trend || []) if (t.brand_id === b.brand_id && isNumber(t[metric])) values[t.day] = t[metric];
      return { name: b.name + (b === own ? " (you)" : ""), color: colors.get(b.brand_id), values, own: b === own };
    });
    clear(chartHost);
    const isRate = metric === "visibility" || metric === "share_of_voice";
    lineChart(chartHost, {
      series, days, invert: metric === "position", clamp01: isRate, height: 260,
      yFormat: isRate ? (v) => `${Math.round(v * 100)}%` : metric === "position" ? (v) => fmt.dec(v, 1) : (v) => fmt.dec(v, 0),
      label: `${TREND_METRICS.find((m) => m[0] === metric)[1]} by day for ${brands.map((b) => b.name).join(", ")}`,
    });
    legendBox.replaceChildren(legend(series));
  };
  const legendBox = h("div");
  const seg = segmented(TREND_METRICS, metric, (id) => {
    metric = id;
    seg.querySelectorAll(".seg-btn").forEach((b, i) => b.setAttribute("aria-pressed", TREND_METRICS[i][0] === id ? "true" : "false"));
    note.hidden = id !== "position";
    draw();
  }, "Trend metric");
  const note = h("p", { class: "muted small", hidden: true }, "Position: lower is better, so the axis runs from best at the top.");
  box.append(h("div", { class: "trend-tools" }, seg, legendBox), note, chartHost);
  if (!days.length) { chartHost.append(empty("No trend yet", "The trend fills in as daily runs complete.")); legendBox.remove(); return box; }
  requestAnimationFrame(draw);
  return box;
}

function buildLeaderboard(data, colors) {
  const rows = [...(data.leaderboard || [])].sort((a, b) => (b.visibility || 0) - (a.visibility || 0));
  if (!rows.length) return empty("No brands yet", "Add competitors in the Competitors page to compare against them.");
  const t = table([
    { label: "#", render: (r) => String(rows.indexOf(r) + 1), class: "col-rank" },
    { label: "Brand", render: (r) => h("span", { class: "brand-cell" }, h("span", { class: "dot", style: { background: colors.get(r.brand_id) } }), r.name, r.is_own ? badge("You", "accent") : null) },
    { label: "Visibility", num: true, render: (r) => fmt.pct(r.visibility) },
    { label: "Share of voice", num: true, render: (r) => fmt.pct(r.share_of_voice) },
    { label: "Position", num: true, render: (r) => fmt.dec(r.position, 1) },
    { label: "Sentiment", num: true, render: (r) => fmt.dec(r.sentiment, 0) },
    { label: "Win rate", num: true, render: (r) => fmt.pct(r.win_rate) },
  ], rows, { label: "Brand leaderboard", rowAttrs: (r) => (r.is_own ? { class: "is-own" } : null) });
  requestAnimationFrame(() => staggerRows(t.querySelector("tbody")));
  return t;
}

function buildEngines(data, ctx) {
  const rows = data.by_engine || [];
  if (!rows.length) return empty("No engine data", "Engine results show here once answers are in.");
  const max = Math.min(1, Math.max(0.1, ...rows.map((r) => r.visibility || 0)) * 1.1);
  return bars(rows.map((r) => ({ label: h("span", null, r.label || ctx.engineLabel(r.engine), h("small", { class: "muted" }, ` · ${plural(r.answers, "answer")}`)), value: r.visibility, display: fmt.pct(r.visibility) })), { max });
}

function buildSources(data, ctx) {
  const rows = data.top_sources || [];
  if (!rows.length) return empty("No citations yet", "Sources appear when answers cite web pages.");
  return table([
    { label: "Domain", render: (r) => h("span", { class: "mono-ish" }, r.domain) },
    { label: "Type", render: (r) => (r.type ? badge(fmt.label(r.type)) : "–") },
    { label: "Citations", num: true, render: (r) => fmt.int(r.citations) },
    { label: "Share", num: true, render: (r) => fmt.pct(r.share) },
  ], rows.slice(0, 8), { label: "Top cited domains" });
}

function buildChats(data, ctx) {
  const rows = data.recent_chats || [];
  if (!rows.length) return empty("No chats yet", "Answers show up here after the first pass runs.");
  return h("ul", { class: "mini-list" }, rows.slice(0, 6).map((c) => {
    const inner = [
      h("span", { class: "mini-top" }, engineBadge(ctx, c.engine), c.country ? h("span", { class: "muted small" }, c.country) : null, h("span", { class: "muted small" }, fmt.date(c.run_date))),
      h("span", { class: "mini-title clamp-2" }, c.prompt),
      h("span", null, c.mentioned ? badge(isNumber(c.rank) ? `Named · #${c.rank}` : "Named", "ok") : badge("Not named", "")),
    ];
    return h("li", null, ctx.go ? h("button", { type: "button", class: "mini-item", onclick: () => ctx.go("chats", { run: c.run_id }) }, inner) : h("div", { class: "mini-item" }, inner));
  }));
}

function buildActions(data, ctx) {
  const rows = (data.actions || []).slice(0, 5);
  if (!rows.length) return empty("No open actions", "Actions are suggested from your insights as data comes in.");
  return h("ul", { class: "mini-list mini-actions" }, rows.map((a) => h("li", null, h("div", { class: "mini-item" },
    h("span", { class: "mini-top" }, impactDots(a.impact), h("span", { class: "muted small" }, fmt.label(a.kind)), a.status && a.status !== "open" ? badge(fmt.label(a.status)) : null),
    h("span", { class: "mini-title" }, a.title)))));
}

function buildInsights(data) {
  const rows = (data.insights || []).slice(0, 5);
  if (!rows.length) return empty("Nothing notable yet", "Insights are written as new answers come in.");
  return h("ul", { class: "insight-list" }, rows.map((i) => h("li", { class: `sev-${Math.min(3, Number(i.severity) || 1)}` }, severityBadge(i.severity), h("p", null, i.text))));
}

// ---------- layout ----------
export function renderWidgets(grid, data, ctx, opts) {
  const colors = brandColors(data);
  let order = validOrder(opts.order);
  const builders = {
    insights: () => buildInsights(data), kpis: () => buildKpis(data), trend: () => buildTrend(data, colors),
    leaderboard: () => buildLeaderboard(data, colors), engines: () => buildEngines(data, ctx), sources: () => buildSources(data, ctx),
    chats: () => buildChats(data, ctx), actions: () => buildActions(data, ctx),
  };
  const links = { insights: "insights", sources: "sources", chats: "chats", actions: "actions", leaderboard: "competitors" };
  const cards = new Map();
  let dragging = null;

  const move = (id, delta) => {
    const i = order.indexOf(id), j = i + delta;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    apply(next);
    cards.get(id).querySelector(delta < 0 ? ".mv-up" : ".mv-down")?.focus();
  };
  const apply = (next) => {
    order = next;
    flip(Array.from(cards.values()), () => { for (const id of order) grid.append(cards.get(id)); });
    if (opts.onReorder) opts.onReorder(order);
  };

  for (const id of order) {
    const w = WIDGETS[id];
    const tools = opts.editable ? h("div", { class: "widget-tools no-print" },
      h("button", { type: "button", class: "btn btn-ghost icon-btn btn-sm mv-up", "aria-label": `Move ${w.title} up`, onclick: () => move(id, -1) }, icon("up")),
      h("button", { type: "button", class: "btn btn-ghost icon-btn btn-sm mv-down", "aria-label": `Move ${w.title} down`, onclick: () => move(id, 1) }, icon("down")),
      h("span", { class: "drag-handle", title: "Drag to reorder", "aria-hidden": "true" }, icon("drag"))) : null;
    const link = links[id] && ctx.go ? h("button", { type: "button", class: "btn btn-ghost btn-sm no-print", onclick: () => ctx.go(links[id]) }, "View all", icon("chev")) : null;
    const body = h("div", { class: "card-body" });
    const el = h("section", { class: `card widget span-${w.span}`, "data-widget": id, "aria-label": w.title },
      h("header", { class: "card-head" }, h("h2", { class: "card-title" }, id === "trend" ? "Trend: you vs top competitors" : w.title), h("div", { class: "card-head-tools" }, link, tools)), body);
    try { body.append(builders[id]()); } catch (err) { body.append(errorBox(err)); }
    cards.set(id, el);
    grid.append(el);
    if (opts.editable) {
      const handle = el.querySelector(".drag-handle");
      handle.addEventListener("pointerdown", () => { el.draggable = true; });
      handle.addEventListener("pointerup", () => { el.draggable = false; });
      el.addEventListener("dragstart", (e) => { dragging = id; el.classList.add("is-dragging"); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", id); } catch { /* ignore */ } });
      el.addEventListener("dragend", () => { el.draggable = false; el.classList.remove("is-dragging"); grid.querySelectorAll(".drop-target").forEach((c) => c.classList.remove("drop-target")); dragging = null; });
      el.addEventListener("dragover", (e) => { if (dragging && dragging !== id) { e.preventDefault(); el.classList.add("drop-target"); } });
      el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        el.classList.remove("drop-target");
        if (!dragging || dragging === id) return;
        const next = order.filter((x) => x !== dragging);
        const box = el.getBoundingClientRect();
        const after = e.clientY > box.top + box.height / 2;
        next.splice(next.indexOf(id) + (after ? 1 : 0), 0, dragging);
        apply(next);
      });
    }
  }
  reveal(Array.from(cards.values()), { y: 12, stagger: 0.05 });
}

// ---------- page ----------
function currentFilters(f) {
  const out = { range: f.range };
  if (f.range === "custom") { out.from = f.from; out.to = f.to; }
  for (const k of ["engine", "country", "topic", "tag"]) if (f[k]) out[k] = f[k];
  return out;
}

async function askName(title, intro, initial = "") {
  const input = h("input", { class: "input", required: true, maxlength: 80, value: initial, placeholder: "e.g. Weekly client report" });
  const ok = await dialog({ title, body: [intro ? h("p", { class: "muted" }, intro) : null, field("View name", input)], actions: [["cancel", "Cancel"], ["ok", "Save view", "primary"]], onOpen: () => input.focus() });
  return ok ? input.value.trim() : null;
}

async function showShare(url, expires) {
  const full = /^https?:/i.test(url) ? url : `${location.origin}${url.startsWith("/") ? "" : "/"}${url}`;
  const input = h("input", { class: "input mono", readonly: true, value: full, onfocus: (e) => e.target.select() });
  await dialog({
    title: "Share link ready",
    body: [h("p", { class: "muted" }, "Anyone with this link can see this view read-only, without signing in."), field("Link", input),
      expires ? h("p", { class: "hint" }, `Expires ${fmt.dateLong(expires)}.`) : null, h("div", { class: "row" }, copyBtn(full, "Copy link"))],
    actions: [["ok", "Done", "primary"]], onOpen: () => input.select(),
  });
}

export default async function overview(ctx) {
  if (needProject(ctx)) return;
  const { pid } = ctx;
  const layoutKey = `geo-layout-${pid}`;
  const viewId = ctx.q.get("view") || "";
  let views = [];
  let order = null;
  const storedOrder = () => { try { return JSON.parse(store.get(layoutKey) || "null"); } catch { return null; } };

  const viewSelect = h("select", { class: "select", "aria-label": "Saved view", onchange: (e) => {
    const v = views.find((x) => String(x.id) === e.target.value);
    if (!v) { ctx.setQuery({ view: null }); return; }
    const f = v.filters || {};
    ctx.setQuery({ view: v.id, range: f.range || (f.from && f.to ? "custom" : null), from: f.from || null, to: f.to || null, engine: f.engine || null, country: f.country || null, topic: f.topic || null, tag: f.tag || null });
  } }, h("option", { value: "" }, "Default view"));

  const saveView = async () => {
    const current = views.find((x) => String(x.id) === viewId);
    const name = await askName("Save this view", "Saves the current filters and widget order.", current ? `${current.name} (copy)` : "");
    if (!name) return null;
    try {
      const v = await api(`projects/${pid}/views`, { method: "POST", body: { name, filters: currentFilters(ctx.f), layout: { order } } });
      toast("View saved", "ok");
      if (v && v.id) ctx.setQuery({ view: v.id });
      return v;
    } catch { return null; }
  };
  const share = async () => {
    let id = viewId;
    if (!id) {
      const v = await saveView();
      if (!v || !v.id) return;
      id = v.id;
    }
    try {
      const r = await api(`projects/${pid}/views/${encodeURIComponent(id)}/share`, { method: "POST", body: { days: 30 } });
      if (r && r.url) await showShare(r.url, r.expires_at);
    } catch { /* toast shown */ }
  };
  const csvQ = ctx.fq();
  const exportMenu = h("details", { class: "menu no-print" }, h("summary", { class: "btn" }, icon("download"), "Export"),
    h("div", { class: "menu-panel" },
      h("button", { type: "button", class: "menu-item", onclick: (e) => { e.target.closest("details").open = false; window.print(); } }, icon("print"), "PDF (print the overview)"),
      h("a", { class: "menu-item", href: linkUrl(`/api/projects/${pid}/export/metrics.csv`, csvQ), download: "" }, icon("download"), "Metrics CSV"),
      h("a", { class: "menu-item", href: linkUrl(`/api/projects/${pid}/export/chats.csv`, csvQ), download: "" }, icon("download"), "Chats CSV")));

  ctx.el.append(pageHead("Overview", `${ctx.project ? ctx.project.name : ""} · ${fmt.dateLong(ctx.f.from)} to ${fmt.dateLong(ctx.f.to)}`,
    h("div", { class: "views-box no-print" }, viewSelect),
    h("button", { type: "button", class: "btn no-print", "data-write": "", onclick: saveView }, icon("save"), "Save view"),
    h("button", { type: "button", class: "btn no-print", "data-write": "", onclick: share }, icon("share"), "Share"),
    exportMenu));
  const grid = h("div", { class: "widgets" });
  ctx.el.append(grid);
  for (const id of DEFAULT_ORDER) grid.append(h("section", { class: `card widget span-${WIDGETS[id].span}` }, h("div", { class: "card-body" }, skeleton(id === "kpis" ? 2 : 4))));

  let data;
  try {
    const [d, v] = await Promise.all([api(`projects/${pid}/overview`, { query: ctx.fq() }), api(`projects/${pid}/views`).catch(() => [])]);
    data = d;
    views = Array.isArray(v) ? v : [];
  } catch (err) {
    if (!ctx.alive()) return;
    clear(grid).append(errorBox(err, () => { clear(ctx.el); overview(ctx); }));
    return;
  }
  if (!ctx.alive()) return;
  for (const v of views) viewSelect.append(h("option", { value: v.id, selected: String(v.id) === viewId }, v.name));
  const active = views.find((v) => String(v.id) === viewId);
  order = validOrder(active && active.layout ? active.layout.order : storedOrder());
  clear(grid);
  const noAnswers = !data || !data.kpis || !(data.kpis.answers && data.kpis.answers.value);
  if (noAnswers) grid.append(h("div", { class: "notice span-12" }, icon("info"), h("span", null, "No answers in this date range yet. Widen the range, clear filters, or check run progress in Setup.")));
  renderWidgets(grid, data, ctx, { order, editable: true, onReorder: (o) => { order = o; store.set(layoutKey, JSON.stringify(o)); } });
}

// ---------- shared link (no nav, read-only) ----------
export async function renderShared(el, token) {
  document.title = "Shared report · GEO Observability";
  const box = h("div");
  el.append(box);
  box.append(skeleton(6));
  let r;
  try { r = await api(`/api/shared/${encodeURIComponent(token)}`, { tenant: false, quiet: true }); }
  catch (err) {
    clear(box).append(err.status === 404 || err.status === 410 || err.status === 403
      ? empty("This link has expired or doesn't exist", "Ask whoever shared it to send a new link.", h("a", { class: "btn", href: "/" }, "About GEO Observability"))
      : errorBox(err, () => { clear(el); renderShared(el, token); }));
    return;
  }
  const data = r.overview || {};
  const labels = new Map((data.by_engine || []).map((e) => [e.engine, e.label]));
  const ctx = { engineLabel: (id) => labels.get(id) || id, go: null };
  const range = data.range ? `${fmt.dateLong(data.range.from)} to ${fmt.dateLong(data.range.to)}` : "";
  const project = r.project || {};
  const site = project.domain ? safeUrl(`https://${project.domain}`) : null;
  clear(box).append(
    h("header", { class: "shared-head" },
      h("a", { class: "logo", href: "/" }, h("span", null, "GEO Observability", h("small", null, "by Organized AI"))),
      h("div", { class: "shared-title" },
        h("h1", null, project.name || "Shared report"),
        h("p", { class: "page-sub" }, [r.view && r.view.name, site ? project.domain : null, range].filter(Boolean).join(" · "))),
      h("div", { class: "page-actions no-print" }, h("button", { type: "button", class: "btn", onclick: () => window.print() }, icon("print"), "Print or save PDF"))),
    h("p", { class: "notice" }, icon("info"), h("span", null, "A read-only snapshot shared from GEO Observability. Figures cover the date range above.")));
  const grid = h("div", { class: "widgets" });
  box.append(grid);
  renderWidgets(grid, data, ctx, { order: r.view && r.view.layout ? r.view.layout.order : null, editable: false });
}
