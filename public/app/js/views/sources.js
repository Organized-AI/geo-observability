// Sources: which domains and pages assistants cite, with a gap view for places that cite competitors but not you.
import { h, clear, fmt, badge, tabs, table, skeleton, errorBox, empty, safeUrl, icon } from "../dom.js";
import { api } from "../api.js";
import { flip, staggerRows } from "../anim.js";
import { pageHead, needProject, yesNo } from "./common.js";

function typeChips(rows, onChange) {
  const types = [...new Set(rows.map((r) => r.type).filter(Boolean))].sort();
  const active = new Set();
  const wrap = h("div", { class: "chips", role: "group", "aria-label": "Filter by domain type" });
  if (types.length < 2) return wrap;
  const all = h("button", { type: "button", class: "chip", "aria-pressed": "true", onclick: () => { active.clear(); sync(); } }, "All types");
  const btns = types.map((t) => h("button", { type: "button", class: "chip", "aria-pressed": "false", onclick: () => { if (active.has(t)) active.delete(t); else active.add(t); sync(); } }, fmt.label(t)));
  const sync = () => {
    all.setAttribute("aria-pressed", active.size ? "false" : "true");
    btns.forEach((b, i) => b.setAttribute("aria-pressed", active.has(types[i]) ? "true" : "false"));
    onChange(active);
  };
  wrap.append(all, ...btns);
  return wrap;
}

function domainsTable(ctx, rows) {
  const ms = Math.max(0.0001, maxShare(rows));
  return table([
    { label: "Domain", render: (r) => h("button", { type: "button", class: "link-btn", title: "See cited pages on this domain", onclick: () => ctx.setQuery({ tab: "urls", domain: r.domain, gap: null }) }, r.domain) },
    { label: "Type", render: (r) => (r.type ? badge(fmt.label(r.type)) : "–") },
    { label: "Citations", num: true, render: (r) => fmt.int(r.citations) },
    { label: "Answers", num: true, render: (r) => fmt.int(r.answers) },
    { label: "Share", num: true, render: (r) => h("span", { class: "share-cell" }, h("span", { class: "share-bar", "aria-hidden": "true" }, h("span", { style: { width: `${Math.min(100, ((r.share || 0) * 100) / ms)}%` } })), fmt.pct(r.share)) },
    { label: "Mentions you", num: true, render: (r) => yesNo(r.mentions_own) },
    { label: "Competitors named", render: (r) => { const c = r.competitors || []; return c.length ? `${c.slice(0, 3).join(", ")}${c.length > 3 ? ` +${c.length - 3}` : ""}` : "–"; } },
  ], rows, { label: "Cited domains", rowAttrs: (r) => ({ "data-type": r.type || "" }) });
}
const maxShare = (rows) => Math.max(0, ...rows.map((r) => r.share || 0));

function urlsTable(rows) {
  return table([
    { label: "Page", render: (r) => { const href = safeUrl(r.url); return h("div", { class: "url-cell" }, h("span", { class: "url-title" }, r.title || r.url), href ? h("a", { href, target: "_blank", rel: "noopener noreferrer nofollow", class: "url-link" }, r.url, icon("ext")) : h("span", { class: "muted small" }, r.url)); } },
    { label: "Domain", key: "domain" },
    { label: "Citations", num: true, render: (r) => fmt.int(r.citations) },
    { label: "Answers", num: true, render: (r) => fmt.int(r.answers) },
    { label: "Cited", num: true, render: (r) => yesNo(r.cited) },
    { label: "Used", num: true, render: (r) => yesNo(r.used) },
    { label: "First seen", render: (r) => fmt.date(r.first_seen) },
    { label: "Last seen", render: (r) => fmt.date(r.last_seen) },
  ], rows, { label: "Cited pages" });
}

export default async function sources(ctx) {
  if (needProject(ctx)) return;
  const tab = ctx.q.get("tab") === "urls" ? "urls" : "domains";
  const gap = ctx.q.get("gap") === "1";
  const domain = ctx.q.get("domain") || "";
  ctx.el.append(pageHead("Sources", "The sites and pages AI assistants cite when they answer your prompts."));
  const tools = h("div", { class: "toolbar" }, tabs([["domains", "Domains"], ["urls", "URLs"]], tab, (id) => ctx.setQuery({ tab: id === "domains" ? null : id, domain: null })));
  if (tab === "domains") {
    tools.append(h("label", { class: "switch" }, h("input", { type: "checkbox", checked: gap, onchange: (e) => ctx.setQuery({ gap: e.target.checked ? "1" : null }) }), h("span", null, "Gaps only")));
  } else if (domain) {
    tools.append(h("span", { class: "chip", "aria-pressed": "true" }, `Domain: ${domain}`, h("button", { type: "button", class: "chip-x", "aria-label": "Clear domain filter", onclick: () => ctx.setQuery({ domain: null }) }, icon("close"))));
  }
  ctx.el.append(tools);
  if (tab === "domains" && gap) ctx.el.append(h("p", { class: "notice" }, icon("info"), h("span", null, "Gaps are domains cited in answers that name a competitor but not you. They're the best places to earn a mention.")));
  const chipBox = h("div");
  const box = h("div", { class: "card card-flush" }, skeleton(8));
  ctx.el.append(chipBox, box);

  try {
    const path = tab === "domains" ? "sources/domains" : "sources/urls";
    const r = await api(`projects/${ctx.pid}/${path}`, { query: ctx.fq(tab === "domains" ? { gap: gap ? 1 : null } : { domain }) });
    if (!ctx.alive()) return;
    const rows = (r && r.items) || [];
    clear(box);
    if (!rows.length) {
      box.append(empty(gap ? "No gaps found" : "No citations yet", gap ? "Every domain that cites a competitor in this range also cites you. Nice." : "Sources appear when answers in this range cite web pages."));
      return;
    }
    const t = tab === "domains" ? domainsTable(ctx, rows) : urlsTable(rows);
    box.append(t);
    staggerRows(t.querySelector("tbody"));
    if (tab === "domains") {
      chipBox.append(typeChips(rows, (active) => {
        const trs = Array.from(t.querySelectorAll("tbody tr"));
        flip(trs, () => trs.forEach((tr) => { tr.hidden = active.size > 0 && !active.has(tr.dataset.type); }));
      }));
    }
  } catch (err) {
    if (ctx.alive()) clear(box).append(errorBox(err, () => { clear(ctx.el); sources(ctx); }));
  }
}
