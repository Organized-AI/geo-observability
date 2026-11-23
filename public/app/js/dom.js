// DOM helpers. Everything from the API goes in as text nodes or attributes, never as HTML.
import { drawerIn, drawerOut } from "./anim.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Path the app is served under ("" at the root, "/geo-observability" on app.organizedai.vip). Set by the Worker. */
export const BASE = typeof window !== "undefined" && typeof window.__GEO_BASE__ === "string" ? window.__GEO_BASE__ : "";

/** Prefixes a root-relative URL with BASE, once. */
export function withBase(v) {
  if (!BASE || typeof v !== "string" || !v.startsWith("/") || v.startsWith("//")) return v;
  if (v === BASE || v.startsWith(`${BASE}/`) || v.startsWith(`${BASE}?`) || v.startsWith(`${BASE}#`)) return v;
  return BASE + v;
}

function apply(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.setAttribute("class", Array.isArray(v) ? v.filter(Boolean).join(" ") : v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value" || k === "checked" || k === "selected" || k === "indeterminate") el[k] = v;
    else if (k === "href" || k === "src" || k === "action") el.setAttribute(k, withBase(String(v)));
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}
function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false || k === "") continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  apply(el, attrs);
  append(el, kids);
  return el;
}
export function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs);
  append(el, kids);
  return el;
}
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

// Static, trusted icon markup only.
const ICONS = {
  overview: '<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 4v4h6V4z"/>',
  chats: '<path d="M5 5h14v10H9l-4 4z"/>',
  sources: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  prompts: '<path d="M4 6h16M4 12h10M4 18h7"/>',
  competitors: '<circle cx="9" cy="9" r="3.5"/><circle cx="16.5" cy="10.5" r="2.5"/><path d="M3 19c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5M15 15.2c2.6-.4 4.6.8 5.5 3.3"/>',
  website: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
  actions: '<path d="M5 12l4 4L19 6"/>',
  insights: '<path d="M12 3v2M5.6 5.6l1.4 1.4M3 12h2M19 12h2M17 7l1.4-1.4M9 17h6M10 21h4M8.5 14a4.5 4.5 0 1 1 7 0c-.7.7-1 1.5-1 2.5h-5c0-1-.3-1.8-1-2.5z"/>',
  perception: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  setup: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  usage: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  traces: '<path d="M4 6h8M8 12h9M13 18h7"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  up: '<path d="M7 14l5-5 5 5"/>',
  down: '<path d="M7 10l5 5 5-5"/>',
  drag: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  print: '<path d="M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6"/>',
  save: '<path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  alert: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17h.01"/>',
};
export function icon(name, label) {
  const span = document.createElement("span");
  span.className = "icon";
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  if (label) span.append(h("span", { class: "sr-only" }, label));
  return span;
}

// Formatting
const nf = new Intl.NumberFormat("en-US");
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
export const fmt = {
  pct: (v) => (isNum(v) ? `${(v * 100).toFixed(1)}%` : "–"),
  pts: (d) => (isNum(d) ? `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)} pts` : ""),
  int: (v) => (isNum(v) ? nf.format(Math.round(v)) : "–"),
  dec: (v, n = 1) => (isNum(v) ? v.toFixed(n) : "–"),
  signed: (d, n = 1) => (isNum(d) ? `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(n)}` : ""),
  money: (micros) => {
    if (!isNum(micros)) return "–";
    const usd = micros / 1e6;
    const digits = usd !== 0 && Math.abs(usd) < 1 ? (Math.abs(usd) < 0.01 ? 4 : 2) : 2;
    return usd.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
  },
  date: (d) => {
    if (!d) return "–";
    const dt = new Date(String(d).length === 10 ? `${d}T00:00:00Z` : d);
    if (Number.isNaN(dt.getTime())) return String(d);
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: String(d).length === 10 ? "UTC" : undefined });
  },
  dateLong: (d) => {
    if (!d) return "–";
    const dt = new Date(String(d).length === 10 ? `${d}T00:00:00Z` : d);
    if (Number.isNaN(dt.getTime())) return String(d);
    return dt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: String(d).length === 10 ? "UTC" : undefined });
  },
  label: (k) => String(k || "").replace(/[_-]+/g, " ").replace(/\b(ugc|ai|seo|api|faq|pr)\b/gi, (w) => w.toUpperCase()).replace(/^\w/, (c) => c.toUpperCase()),
};
export const isNumber = isNum;
export const plural = (n, word, many = `${word}s`) => `${fmt.int(n || 0)} ${(n || 0) === 1 ? word : many}`;

export function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export function safeUrl(u) {
  try { const url = new URL(String(u), location.origin); return url.protocol === "https:" || url.protocol === "http:" ? url.href : null; } catch { return null; }
}
export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* blocked */ } },
};

// Feedback
export function toast(msg, kind = "info") {
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = h("div", { class: `toast toast-${kind}`, role: kind === "error" ? "alert" : "status" }, msg);
  host.append(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, kind === "error" ? 6000 : 3200);
}
export async function copyText(text, what = "Copied") {
  try { await navigator.clipboard.writeText(text); toast(what, "ok"); }
  catch { toast("Couldn't copy. Select the text and copy it manually.", "error"); }
}
export function copyBtn(getText, label = "Copy") {
  return h("button", { class: "btn btn-sm", type: "button", onclick: () => copyText(typeof getText === "function" ? getText() : getText, "Copied to clipboard") }, icon("copy"), label);
}

export function skeleton(lines = 4, kind = "rows") {
  const el = h("div", { class: `skeleton skeleton-${kind}`, "aria-busy": "true", "aria-label": "Loading" });
  for (let i = 0; i < lines; i++) el.append(h("span", { class: "sk", style: { width: `${70 + ((i * 37) % 30)}%` } }));
  return el;
}
export function empty(title, body, action) {
  return h("div", { class: "empty" }, h("p", { class: "empty-title" }, title), body ? h("p", { class: "empty-body" }, body) : null, action || null);
}
export function errorBox(err, retry) {
  return h("div", { class: "error-box", role: "alert" }, icon("alert"),
    h("div", null, h("p", { class: "empty-title" }, "This didn't load"), h("p", { class: "empty-body" }, (err && err.message) || "Something went wrong.")),
    retry ? h("button", { class: "btn btn-sm", type: "button", onclick: retry }, "Try again") : null);
}
export function badge(text, kind = "") { return h("span", { class: `badge ${kind ? `badge-${kind}` : ""}` }, text); }

export function card(title, opts = {}, ...body) {
  return h("section", { class: ["card", opts.class], "aria-label": typeof title === "string" ? title : null },
    title ? h("header", { class: "card-head" }, h("h2", { class: "card-title" }, title), opts.actions || null) : null,
    h("div", { class: "card-body" }, ...body));
}

export function table(columns, rows, opts = {}) {
  // columns: [{label, key|render, num, class}]
  const thead = h("thead", null, h("tr", null, columns.map((c) => h("th", { scope: "col", class: [c.num && "is-num", c.class] }, c.label))));
  const tbody = h("tbody");
  for (const r of rows) {
    const tr = h("tr", opts.rowAttrs ? opts.rowAttrs(r) : null, columns.map((c) => {
      const v = c.render ? c.render(r) : r[c.key];
      return h("td", { class: [c.num && "is-num num", c.class] }, v);
    }));
    tbody.append(tr);
    if (opts.after) { const extra = opts.after(r, tr); if (extra) tbody.append(extra); }
  }
  return h("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": opts.label || "Table" }, h("table", { class: "tbl" }, thead, tbody));
}

export function tabs(items, active, onSelect) {
  return h("div", { class: "tabs", role: "tablist" }, items.map(([id, label]) =>
    h("button", { class: "tab", type: "button", role: "tab", "aria-selected": id === active ? "true" : "false", onclick: () => onSelect(id) }, label)));
}

export function segmented(items, active, onSelect, label) {
  return h("div", { class: "seg", role: "group", "aria-label": label }, items.map(([id, text]) =>
    h("button", { type: "button", class: "seg-btn", "aria-pressed": String(id) === String(active) ? "true" : "false", onclick: () => onSelect(id) }, text)));
}

// Dialog: resolves with the clicked action id (or null on cancel).
export function dialog({ title, body, actions = [["cancel", "Cancel"], ["ok", "OK", "primary"]], onOpen }) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "dlg", "aria-labelledby": "dlg-title" });
    // Cancel buttons are type=button so Enter in a field submits the primary action, not Cancel.
    const cancel = () => dlg.close("cancel");
    const form = h("form", { method: "dialog" },
      h("header", { class: "dlg-head" }, h("h2", { id: "dlg-title" }, title),
        h("button", { type: "button", class: "btn btn-ghost icon-btn", "aria-label": "Close", onclick: cancel }, icon("close"))),
      h("div", { class: "dlg-body" }, body),
      h("footer", { class: "dlg-foot" }, actions.map(([id, label, kind]) => (id === "cancel"
        ? h("button", { type: "button", class: "btn", onclick: cancel }, label)
        : h("button", { type: "submit", class: `btn ${kind ? `btn-${kind}` : ""}`, value: id }, label)))));
    dlg.append(form);
    document.body.append(dlg);
    dlg.addEventListener("close", () => { const v = dlg.returnValue; dlg.remove(); resolve(v && v !== "cancel" ? v : null); });
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    if (onOpen) onOpen(dlg);
  });
}

// Side drawer with focus return and Escape to close.
let openDrawerEl = null;
export function drawer(title, build) {
  closeDrawer(true);
  const prev = document.activeElement;
  const body = h("div", { class: "drawer-body" });
  const closeBtn = h("button", { class: "btn btn-ghost icon-btn", type: "button", "aria-label": "Close panel", onclick: () => closeDrawer() }, icon("close"));
  const panel = h("aside", { class: "drawer", role: "dialog", "aria-modal": "true", "aria-label": title, tabindex: "-1" },
    h("header", { class: "drawer-head" }, h("h2", null, title), closeBtn), body);
  const backdrop = h("div", { class: "drawer-backdrop", onclick: () => closeDrawer() });
  const onKey = (e) => { if (e.key === "Escape") closeDrawer(); };
  document.addEventListener("keydown", onKey);
  document.body.append(backdrop, panel);
  document.body.classList.add("has-drawer");
  openDrawerEl = { panel, backdrop, prev, onKey };
  drawerIn(panel, backdrop);
  closeBtn.focus();
  build(body);
  return body;
}
export function closeDrawer(instant) {
  if (!openDrawerEl) return;
  const { panel, backdrop, prev, onKey } = openDrawerEl;
  openDrawerEl = null;
  document.removeEventListener("keydown", onKey);
  document.body.classList.remove("has-drawer");
  const done = () => { panel.remove(); backdrop.remove(); };
  if (instant) done(); else drawerOut(panel, backdrop, done);
  if (prev && prev.focus && !instant) prev.focus();
}

// Field helper for forms.
export function field(label, control, hint) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return h("div", { class: "field" }, h("label", { for: id }, label), control, hint ? h("p", { class: "hint" }, hint) : null);
}
export const csv = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
