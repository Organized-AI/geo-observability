// Small pieces shared across views.
import { h, clear, badge, skeleton, errorBox, fmt, isNumber } from "../dom.js";
import { api } from "../api.js";

export function pageHead(title, sub, ...actions) {
  return h("header", { class: "page-head" },
    h("div", null, h("h1", null, title), sub ? h("p", { class: "page-sub" }, sub) : null),
    actions.length ? h("div", { class: "page-actions" }, actions) : null);
}

// Render into `box`: skeleton → data → build(data) or an error with retry.
export async function load(box, fetcher, build, sk = 5) {
  clear(box).append(skeleton(sk));
  try {
    const data = await fetcher();
    clear(box);
    await build(data);
  } catch (err) {
    clear(box).append(errorBox(err, () => load(box, fetcher, build, sk)));
  }
}

export function engineBadge(ctx, id) { return h("span", { class: `engine-badge engine-${String(id).replace(/[^a-z0-9]/gi, "")}` }, ctx.engineLabel(id)); }

export function channelBadge(channel) {
  if (channel === "stub") return h("span", { class: "badge badge-warn", title: "This answer came from the labelled stub engine, not a live model call." }, "Stub engine");
  if (channel === "api") return badge("Live API", "ok");
  if (channel === "unavailable") return badge("Not trackable", "");
  return channel ? badge(String(channel)) : null;
}

export function sentimentBadge(v) {
  if (!isNumber(v)) return null;
  const kind = v >= 60 ? "ok" : v <= 40 ? "neg" : "";
  return h("span", { class: `badge badge-${kind}`, title: "Sentiment, 0 to 100" }, `Sentiment ${Math.round(v)}`);
}

export function verdictBadge(v) {
  const k = String(v || "unverified").toLowerCase();
  const kind = /support|true|correct|accurate|confirm/.test(k) ? "ok" : /contra|false|incorrect|wrong|outdated/.test(k) ? "neg" : "warn";
  return badge(fmt.label(k), kind);
}

export function severityBadge(n) {
  const v = Number(n) || 1;
  return v >= 3 ? badge("Critical", "neg") : v === 2 ? badge("Notable", "warn") : badge("Info", "");
}

export function impactDots(n) {
  const v = Math.max(0, Math.min(3, Number(n) || 0));
  return h("span", { class: "impact", title: `Impact ${v} of 3`, "aria-label": `Impact ${v} of 3` }, [1, 2, 3].map((i) => h("span", { class: i <= v ? "on" : "" })));
}

// Brands are needed by several views (highlighting, colours); cache per project.
const brandCache = new Map();
export function brandsFor(pid, fresh) {
  if (fresh || !brandCache.has(pid)) brandCache.set(pid, api(`projects/${pid}/brands`).then((r) => (Array.isArray(r) ? r : [])).catch(() => []));
  return brandCache.get(pid);
}
export function dropBrands(pid) { brandCache.delete(pid); }

export function needProject(ctx) {
  if (ctx.pid) return false;
  ctx.el.append(h("div", { class: "empty" }, h("p", { class: "empty-title" }, "Create a project first"),
    h("p", { class: "empty-body" }, "Reports appear once a project has run its first pass."),
    ctx.readOnly ? null : h("a", { class: "btn btn-primary", href: "#/setup?tab=new" }, "Start setup")));
  return true;
}

export const yesNo = (v) => (typeof v === "boolean" ? (v ? "Yes" : "No") : isNumber(v) ? fmt.int(v) : v == null ? "–" : String(v));

// Sortable table state helper: returns sorted copy.
export function sortRows(rows, key, dir) {
  if (!key) return rows;
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return dir === "asc" ? c : -c;
  });
}
