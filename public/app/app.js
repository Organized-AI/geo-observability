// Portal shell: session boot, navigation, project/tenant switchers, global filters and hash routing.
import { h, clear, icon, store, toast, errorBox, csv, closeDrawer, segmented } from "./js/dom.js";
import { api, session, setTenant, filterQuery, onAuthError, openBilling } from "./js/api.js";
import { viewIn } from "./js/anim.js";
import overview, { renderShared } from "./js/views/overview.js";
import chats from "./js/views/chats.js";
import sources from "./js/views/sources.js";
import prompts from "./js/views/prompts.js";
import competitors from "./js/views/competitors.js";
import website from "./js/views/website.js";
import actions from "./js/views/actions.js";
import insights from "./js/views/insights.js";
import perception from "./js/views/perception.js";
import setup from "./js/views/setup.js";
import usage from "./js/views/usage.js";

const ROUTES = {
  overview: { label: "Overview", icon: "overview", filters: "all", view: overview },
  chats: { label: "Chats", icon: "chats", filters: "all", view: chats },
  sources: { label: "Sources", icon: "sources", filters: "all", view: sources },
  prompts: { label: "Prompts", icon: "prompts", filters: "all", view: prompts },
  competitors: { label: "Competitors", icon: "competitors", filters: "none", view: competitors },
  website: { label: "My website", icon: "website", filters: "date", view: website },
  actions: { label: "Actions", icon: "actions", filters: "none", view: actions },
  insights: { label: "Insights", icon: "insights", filters: "date", view: insights },
  perception: { label: "Perception", icon: "perception", filters: "all", view: perception },
  setup: { label: "Setup", icon: "setup", filters: "none", view: setup },
  usage: { label: "Usage & API", icon: "usage", filters: "none", view: usage },
};
const FILTER_KEYS = ["range", "from", "to", "engine", "country", "topic", "tag"];
const $ = (id) => document.getElementById(id);
const state = { me: null, engines: [], projects: [], pid: null, meta: new Map(), boot: null, token: 0, lastRoute: null };

const isoDay = (d) => d.toISOString().slice(0, 10);
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const i = raw.indexOf("?");
  const path = i >= 0 ? raw.slice(0, i) : raw;
  const parts = path.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  return { name: parts[0] || "overview", parts, q: new URLSearchParams(i >= 0 ? raw.slice(i + 1) : "") };
}
const buildHash = (parts, q) => { const s = q.toString(); return `#/${parts.map(encodeURIComponent).join("/")}${s ? `?${s}` : ""}`; };

export function filtersFrom(q) {
  let range = q.get("range") || (q.get("from") && q.get("to") ? "custom" : "14");
  let from = q.get("from"), to = q.get("to");
  if (range !== "custom" || !/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "")) {
    if (range === "custom") range = "14";
    const days = [7, 14, 30, 90].includes(+range) ? +range : 14;
    const end = new Date();
    to = isoDay(end);
    from = isoDay(new Date(end.getTime() - (days - 1) * 86400000));
  }
  const f = { range, from, to };
  for (const k of ["engine", "country", "topic", "tag"]) f[k] = q.get(k) || "";
  return f;
}
function keepQuery(q) {
  const out = new URLSearchParams();
  for (const k of ["p", ...FILTER_KEYS]) if (q.get(k)) out.set(k, q.get(k));
  return out;
}

// ---------- boot ----------
async function boot(force) {
  if (state.boot && !force) return state.boot;
  state.boot = (async () => {
    const main = $("main");
    clear(main).append(h("div", { class: "boot" }, h("span", { class: "spinner", "aria-hidden": "true" }), "Loading your workspace…"));
    try {
      let me;
      try { me = await api("me", { quiet: true }); }
      catch (err) {
        // A remembered workspace we no longer belong to: forget it and fall back to the default one.
        if (!session.tenant || ![403, 404].includes(err.status)) throw err;
        setTenant(null);
        me = await api("me", { quiet: true });
      }
      state.me = me;
      if (me.tenant && me.tenant.slug && session.tenant !== me.tenant.slug) setTenant(me.tenant.slug);
      const [engines, projects] = await Promise.all([api("engines").catch(() => []), api("projects")]);
      state.engines = Array.isArray(engines) ? engines : [];
      state.projects = Array.isArray(projects) ? projects : [];
      state.meta.clear();
      buildShell();
    } catch (err) {
      state.me = null;
      if (err.status === 401) showSignedOut();
      else if (err.code === "no_tenant") clear(main).append(h("div", { class: "signedout" }, h("h1", null, "No workspace yet"),
        h("p", null, "Your sign-in isn't linked to a workspace. Create one to start tracking, or ask the person who invited you to add you."),
        h("div", { class: "row" }, h("a", { class: "btn btn-primary", href: "/signup/" }, "Create a workspace"), h("a", { class: "btn", href: "/" }, "Back to the homepage"))));
      else clear(main).append(errorBox(err, () => { state.boot = null; render(); }));
      if (session.tenant && err.status === 403) setTenant(null);
    }
  })();
  return state.boot;
}

async function signOut() {
  try { await fetch("/auth/logout", { method: "POST", headers: { Accept: "application/json" }, credentials: "same-origin" }); } catch { /* offline: cookie stays until it expires */ }
  setTenant(null);
  location.assign("/");
}

function showSignedOut() {
  document.body.classList.add("is-signedout");
  clear($("main")).append(h("div", { class: "signedout" }, h("h1", null, "Sign in to continue"),
    h("p", null, "Your session has ended or you haven't signed in yet. We'll email you a sign-in link."),
    h("div", { class: "row" }, h("a", { class: "btn btn-primary", href: "/login/" }, "Sign in"), h("a", { class: "btn", href: "/signup/" }, "Create a workspace"))));
}
onAuthError(() => {
  const b = $("banners");
  if (b && !b.querySelector(".banner-auth")) b.prepend(h("div", { class: "banner banner-neg banner-auth", role: "alert" }, icon("alert"), h("span", null, "You're signed out."), h("a", { class: "btn btn-sm", href: "/login/" }, "Sign in")));
});

const readOnly = () => !!(state.me && (state.me.read_only || state.me.demo));

function buildShell() {
  const me = state.me;
  document.body.classList.toggle("is-readonly", readOnly());
  // nav
  const list = clear($("nav-list"));
  for (const [id, r] of Object.entries(ROUTES)) {
    list.append(h("li", null, h("a", { href: `#/${id}`, "data-route": id, class: "nav-link" }, icon(r.icon), h("span", null, r.label))));
  }
  // tenant
  const tenantBox = clear($("tenant"));
  const tenants = me.tenants || [];
  if (tenants.length > 1) {
    const sel = h("select", { class: "select select-quiet", "aria-label": "Workspace", onchange: async (e) => {
      setTenant(e.target.value);
      store.set("geo-project", null);
      state.boot = null;
      location.hash = "#/overview";
      await boot(true);
      render();
    } }, tenants.map((t) => h("option", { value: t.slug || t.id, selected: (t.slug || t.id) === (me.tenant && (me.tenant.slug || me.tenant.id)) }, t.name)));
    tenantBox.append(sel);
  } else if (me.tenant) tenantBox.append(h("span", { class: "tenant-name" }, me.tenant.name));
  // user
  clear($("user")).append(
    me.user ? h("span", { class: "user-chip", title: me.user.email || "" }, (me.user.name || me.user.email || "").slice(0, 40)) : "",
    me.demo ? h("a", { class: "btn btn-sm btn-primary", href: "/signup/" }, "Sign up") : h("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: signOut }, "Sign out"));
  // banners
  const b = clear($("banners"));
  if (me.demo) b.append(h("div", { class: "banner", role: "status" }, icon("info"), h("span", null, "You're exploring the demo workspace with sample data. It's read-only, so every report is open but changes are turned off.")));
  else if (me.read_only) b.append(h("div", { class: "banner", role: "status" }, icon("info"), h("span", null, "You have view access to this workspace, so changes are turned off.")));
  const banner = me.billing && typeof me.billing.banner === "string" ? me.billing.banner.trim() : "";
  if (banner) b.append(h("div", { class: "banner banner-warn", role: "status" }, icon("alert"), h("span", null, banner), billingButton(me.billing)));
}

/** Owners of a card-billed workspace get a button in the billing banner: add a card (Checkout) or update it (Stripe portal). */
function billingButton(billing) {
  if (!billing || !billing.can_manage) return null;
  const needsCheckout = billing.status === "incomplete" || billing.status === "canceled";
  return h("button", { class: "btn btn-sm btn-primary", type: "button", onclick: (e) => openBilling(needsCheckout ? "checkout" : "portal", e.currentTarget) }, needsCheckout ? "Add a card" : "Update card");
}

/** Back from Checkout: the webhook may land a moment after the redirect, so wait for it before saying it's done. */
async function confirmCheckout() {
  const params = new URLSearchParams(location.search);
  if (params.get("billing") !== "success") return;
  params.delete("billing");
  const clean = location.pathname + (params.toString() ? `?${params}` : "") + location.hash;
  history.replaceState(null, "", clean);
  if (!state.me || !state.me.billing || state.me.billing.status !== "incomplete") { toast("Card saved. Your subscription is active.", "ok"); return; }
  const b = $("banners");
  const wait = h("div", { class: "banner", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", null, "Confirming your card with Stripe…"));
  if (b) b.prepend(wait);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const me = await api("me", { quiet: true }).catch(() => null);
    if (me && me.billing && me.billing.status !== "incomplete") {
      wait.remove();
      toast("Card saved. Set up your project to start the first run.", "ok");
      state.boot = null;
      await boot(true);
      render();
      return;
    }
  }
  wait.remove();
  toast("Stripe hasn't confirmed yet. Reload in a minute; if it's still waiting, check the Stripe dashboard.", "error");
}

function renderProjectSwitcher(route) {
  const box = clear($("project"));
  if (!state.projects.length) { box.append(h("span", { class: "muted" }, "No projects yet")); return; }
  const sel = h("select", { class: "select", "aria-label": "Project", onchange: (e) => {
    if (e.target.value === "__new") { location.hash = "#/setup?tab=new"; return; }
    store.set("geo-project", e.target.value);
    const q = keepQuery(route.q); q.set("p", e.target.value);
    location.hash = buildHash([route.name === "shared" ? "overview" : route.name], q);
  } },
  state.projects.map((p) => h("option", { value: p.id, selected: p.id === state.pid }, p.domain ? `${p.name} · ${p.domain}` : p.name)),
  readOnly() ? null : h("option", { value: "__new" }, "+ New project…"));
  box.append(sel);
}

// ---------- filter bar ----------
let openMs = null;
document.addEventListener("click", (e) => { if (openMs && !openMs.contains(e.target)) openMs.open = false; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openMs) { openMs.open = false; openMs.querySelector("summary").focus(); } });

function multiSelect(label, options, selectedCsv, onApply, emptyText) {
  const initial = new Set(csv(selectedCsv));
  const sel = new Set(initial);
  const summaryText = () => {
    if (!sel.size) return `${label}: All`;
    const names = options.filter((o) => sel.has(o.value)).map((o) => o.label);
    return names.length === 1 ? `${label}: ${names[0]}` : `${label}: ${sel.size} selected`;
  };
  const sum = h("summary", { class: "ms-summary" }, h("span", null, summaryText()), icon("down"));
  const panel = h("div", { class: "ms-panel" });
  if (!options.length) panel.append(h("p", { class: "muted ms-empty" }, emptyText || "Nothing to filter by yet."));
  for (const o of options) {
    panel.append(h("label", { class: ["ms-opt", o.disabled && "is-disabled"] },
      h("input", { type: "checkbox", value: o.value, checked: sel.has(o.value), disabled: o.disabled, onchange: (e) => { if (e.target.checked) sel.add(o.value); else sel.delete(o.value); sum.firstChild.textContent = summaryText(); } }),
      h("span", null, o.label), o.note ? h("small", { class: "muted" }, o.note) : null));
  }
  const d = h("details", { class: ["ms", initial.size && "is-active"] }, sum, panel);
  if (options.length) panel.append(h("div", { class: "ms-foot" },
    h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => { sel.clear(); panel.querySelectorAll("input").forEach((i) => { i.checked = false; }); sum.firstChild.textContent = summaryText(); } }, "Clear"),
    h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => { d.open = false; } }, "Apply")));
  d.addEventListener("toggle", () => {
    if (d.open) { if (openMs && openMs !== d) openMs.open = false; openMs = d; return; }
    if (openMs === d) openMs = null;
    const changed = sel.size !== initial.size || [...sel].some((v) => !initial.has(v));
    if (changed) onApply([...sel].join(","));
  });
  return d;
}

function projectMeta(pid) {
  if (!pid) return Promise.resolve({ countries: [], topics: [], tags: [] });
  if (!state.meta.has(pid)) {
    state.meta.set(pid, Promise.all([
      api(`projects/${pid}/countries`).then((r) => (r && r.countries) || []).catch(() => []),
      api(`projects/${pid}/topics`).then((r) => (Array.isArray(r) ? r : [])).catch(() => []),
      api(`projects/${pid}/prompts`, { query: { status: "active" } }).then((r) => (Array.isArray(r) ? r : [])).catch(() => []),
    ]).then(([countries, topics, promptsList]) => ({
      countries, topics: topics.filter((t) => t.status !== "rejected"),
      tags: [...new Set(promptsList.flatMap((p) => p.tags || []))].sort(),
    })));
  }
  return state.meta.get(pid);
}

function renderFilterBar(route, def, f, setQuery) {
  const bar = clear($("filterbar"));
  bar.hidden = def.filters === "none";
  if (bar.hidden) return;
  const dateBox = h("div", { class: "fb-group" });
  const customBox = h("div", { class: "fb-custom", hidden: f.range !== "custom" });
  const today = isoDay(new Date());
  const fromIn = h("input", { type: "date", class: "input input-sm", value: f.from, max: today, "aria-label": "From date" });
  const toIn = h("input", { type: "date", class: "input input-sm", value: f.to, max: today, "aria-label": "To date" });
  customBox.append(fromIn, h("span", { class: "muted" }, "to"), toIn, h("button", { type: "button", class: "btn btn-sm", onclick: () => {
    if (!fromIn.value || !toIn.value || fromIn.value > toIn.value) { toast("Pick a start date on or before the end date.", "error"); return; }
    setQuery({ range: "custom", from: fromIn.value, to: toIn.value });
  } }, "Apply"));
  dateBox.append(segmented([["7", "7d"], ["14", "14d"], ["30", "30d"], ["90", "90d"], ["custom", "Custom"]], f.range, (id) => {
    if (id === "custom") { customBox.hidden = false; bar.querySelectorAll(".seg-btn").forEach((b) => b.setAttribute("aria-pressed", b.textContent === "Custom" ? "true" : "false")); fromIn.focus(); return; }
    setQuery({ range: id, from: null, to: null });
  }, "Date range"), customBox);
  bar.append(dateBox);
  if (def.filters !== "all") return;
  const engineOpts = state.engines.map((e) => ({ value: e.id, label: e.label || e.id, disabled: e.available === false || e.channel === "unavailable", note: e.channel === "stub" ? "stub" : e.channel === "unavailable" ? "not trackable" : "" }));
  bar.append(multiSelect("Engines", engineOpts, f.engine, (v) => setQuery({ engine: v })));
  const holder = h("div", { class: "fb-group fb-meta" }, h("span", { class: "sk sk-inline" }));
  bar.append(holder);
  const active = ["engine", "country", "topic", "tag"].some((k) => f[k]) || f.range !== "14";
  if (active) bar.append(h("button", { type: "button", class: "btn btn-sm btn-ghost fb-reset", onclick: () => setQuery({ range: null, from: null, to: null, engine: null, country: null, topic: null, tag: null }) }, "Reset filters"));
  projectMeta(state.pid).then((m) => {
    if (!holder.isConnected) return;
    clear(holder).append(
      multiSelect("Country", m.countries.map((c) => ({ value: c, label: c })), f.country, (v) => setQuery({ country: v }), "Add countries in Setup."),
      multiSelect("Topic", m.topics.map((t) => ({ value: t.id, label: t.name })), f.topic, (v) => setQuery({ topic: v }), "Topics appear once you've added them in Setup."),
      multiSelect("Tag", m.tags.map((t) => ({ value: t, label: t })), f.tag, (v) => setQuery({ tag: v }), "Tag prompts to filter by tag."));
  });
}

// ---------- routing ----------
async function render() {
  const route = parseHash();
  const token = ++state.token;
  closeDrawer(true);
  document.body.classList.remove("nav-open");
  if (route.name === "shared") {
    document.body.classList.add("is-shared");
    const main = clear($("main"));
    const el = h("div", { class: "view" });
    main.append(el);
    viewIn(el);
    return renderShared(el, route.parts[1] || "");
  }
  document.body.classList.remove("is-shared");
  await boot();
  if (token !== state.token || !state.me) return;

  let def = ROUTES[route.name];
  if (!def) { location.replace(buildHash(["overview"], keepQuery(route.q))); return; }
  const ids = state.projects.map((p) => p.id);
  let pid = route.q.get("p");
  if (!ids.includes(pid)) pid = ids.includes(store.get("geo-project")) ? store.get("geo-project") : ids[0] || null;
  state.pid = pid;
  if (pid) store.set("geo-project", pid);
  if (!pid && route.name !== "setup" && route.name !== "usage") {
    if (readOnly()) { def = null; }
    else { location.replace("#/setup?tab=new"); return; }
  }

  const keep = keepQuery(route.q);
  if (pid) keep.set("p", pid);
  const ks = keep.toString();
  document.querySelectorAll("#nav-list .nav-link").forEach((a) => {
    a.href = `#/${a.dataset.route}${ks ? `?${ks}` : ""}`;
    if (a.dataset.route === route.name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  renderProjectSwitcher(route);

  const main = clear($("main"));
  const el = h("div", { class: "view" });
  main.append(el);
  if (!def) { el.append(h("div", { class: "empty" }, h("p", { class: "empty-title" }, "No projects in this workspace yet"), h("p", { class: "empty-body" }, "Someone with edit access needs to create the first project."))); return; }
  document.title = `${def.label} · GEO Observability`;
  const f = filtersFrom(route.q);
  const project = state.projects.find((p) => p.id === pid) || null;
  const setQuery = (patch, parts = route.parts.length ? route.parts : [route.name]) => {
    const q = new URLSearchParams(parseHash().q); // current hash, in case a view rewrote it in place
    if (pid) q.set("p", pid);
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === "") q.delete(k); else q.set(k, v); }
    location.hash = buildHash(parts, q);
  };
  renderFilterBar(route, def, f, setQuery);
  if (state.lastRoute !== route.name) { viewIn(el); $("main").focus({ preventScroll: true }); window.scrollTo(0, 0); }
  state.lastRoute = route.name;

  const ctx = {
    el, route, q: route.q, name: route.name, parts: route.parts, pid, project, projects: state.projects,
    me: state.me, readOnly: readOnly(), engines: state.engines, f,
    fq: (extra) => filterQuery(f, extra),
    alive: () => token === state.token,
    setQuery,
    go: (name, patch = {}, keepFilters = true) => {
      const q = keepFilters ? new URLSearchParams(keep) : new URLSearchParams(pid ? { p: pid } : {});
      for (const [k, v] of Object.entries(patch)) { if (v == null || v === "") q.delete(k); else q.set(k, v); }
      location.hash = buildHash([name], q);
    },
    engineLabel: (id) => (state.engines.find((e) => e.id === id) || {}).label || id,
    meta: () => projectMeta(pid),
    invalidateMeta: () => state.meta.delete(pid),
    refreshProjects: async (selectId) => {
      state.projects = await api("projects").catch(() => state.projects);
      if (selectId) { state.pid = selectId; store.set("geo-project", selectId); }
      renderProjectSwitcher(route);
      return state.projects;
    },
  };
  try { await def.view(ctx); }
  catch (err) { if (ctx.alive()) el.append(errorBox(err, () => render())); console.error(err); }
}

// ---------- chrome wiring ----------
function wireChrome() {
  const menu = $("menu-btn");
  menu.addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    menu.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) $("nav").querySelector("a")?.focus();
  });
  $("nav-backdrop").addEventListener("click", () => { document.body.classList.remove("nav-open"); menu.setAttribute("aria-expanded", "false"); });
  $("nav").addEventListener("click", (e) => { if (e.target.closest("a")) { document.body.classList.remove("nav-open"); menu.setAttribute("aria-expanded", "false"); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("nav-open")) { document.body.classList.remove("nav-open"); menu.focus(); } });
  document.addEventListener("click", (e) => {
    document.querySelectorAll("details.menu[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  });
  window.addEventListener("beforeprint", () => document.body.classList.add("is-printing"));
  window.addEventListener("afterprint", () => document.body.classList.remove("is-printing"));
  if (window.oaWireTheme) window.oaWireTheme();
}

window.addEventListener("hashchange", render);
wireChrome();
render().then(confirmCheckout);
