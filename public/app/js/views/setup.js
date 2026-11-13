// Setup: onboarding wizard for a new project, plus project settings, engines, countries and tracking.
import { h, clear, fmt, badge, tabs, skeleton, errorBox, empty, toast, field, csv, icon, copyBtn, card, table, isNumber } from "../dom.js";
import { api } from "../api.js";
import { viewIn, reveal } from "../anim.js";
import { pageHead, load, brandsFor, dropBrands, channelBadge } from "./common.js";
import { brandsManager } from "./competitors.js";

const STEPS = ["Brand", "Profile", "Topics", "Prompts", "Competitors", "Engines & countries", "Finish"];
const STEP_NAMES = ["brand", "profile", "topics", "prompts", "competitors", "engines", "finish"];
const DONE = STEPS.length;

export function stepOf(project) {
  if (!project) return 0;
  const s = project.onboarding_step;
  if (isNumber(s)) return s;
  if (/^\d+$/.test(String(s || ""))) return Number(s);
  if (["done", "complete", "completed", "finished"].includes(String(s))) return DONE;
  const i = STEP_NAMES.indexOf(String(s));
  return i >= 0 ? i : DONE;
}
const setStep = (pid, n) => api(`projects/${pid}`, { method: "PATCH", body: { onboarding_step: n }, quiet: true }).catch(() => null);

// ---------- shared forms ----------
function marketsText(markets) { return (markets || []).map((m) => (m.language ? `${m.country}:${m.language}` : m.country)).join(", "); }
function parseMarkets(text) {
  return csv(text).map((x) => { const [c, l] = x.split(":").map((s) => s.trim()); return { country: (c || "").toUpperCase().slice(0, 2), language: (l || "en").toLowerCase() }; }).filter((m) => m.country.length === 2);
}

function profileForm(ctx, pid, profile, { submitLabel = "Save profile", onSaved, allowDraft = true } = {}) {
  const sell = h("textarea", { class: "input", rows: 3, required: true, value: profile.what_you_sell || "" });
  const buyers = h("textarea", { class: "input", rows: 3, value: profile.buyers || "" });
  const markets = h("input", { class: "input", value: marketsText(profile.markets) || "US:en", placeholder: "US:en, GB:en, DE:de" });
  const facts = h("textarea", { class: "input", rows: 5, value: (profile.facts || []).map((f) => (typeof f === "string" ? f : f.text || f.claim || "")).join("\n"), placeholder: "One fact per line, e.g. Founded in 2019\nSOC 2 Type II certified" });
  const fill = (p) => { sell.value = p.what_you_sell || ""; buyers.value = p.buyers || ""; markets.value = marketsText(p.markets) || markets.value; facts.value = (p.facts || []).map((f) => (typeof f === "string" ? f : f.text || f.claim || "")).join("\n"); };
  const draftBtn = allowDraft ? h("button", { type: "button", class: "btn", onclick: async () => {
    draftBtn.disabled = true; draftBtn.textContent = "Reading your website…";
    try { const p = await api(`projects/${pid}/onboarding/profile`, { method: "POST" }); fill(p || {}); toast("Draft ready. Review it before saving.", "ok"); }
    catch { /* toast shown */ } finally { draftBtn.disabled = false; draftBtn.textContent = "Draft from my website"; }
  } }, "Draft from my website") : null;
  const form = h("form", { class: "form-grid", onsubmit: async (e) => {
    e.preventDefault();
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      const body = { what_you_sell: sell.value.trim(), buyers: buyers.value.trim(), markets: parseMarkets(markets.value), facts: facts.value.split("\n").map((s) => s.trim()).filter(Boolean) };
      await api(`projects/${pid}/profile`, { method: "PUT", body });
      toast("Profile saved", "ok");
      if (onSaved) onSaved(body);
    } catch { /* toast shown */ } finally { btn.disabled = false; }
  } },
  h("div", { class: "span-all" }, field("What you sell", sell, "A sentence or two in plain words. Used to write prompts and judge relevance.")),
  h("div", { class: "span-all" }, field("Who buys it", buyers, "Roles, company sizes and industries.")),
  h("div", { class: "span-all" }, field("Markets", markets, "Country and language pairs, comma separated.")),
  h("div", { class: "span-all" }, field("Facts", facts, "Claims assistants should get right. We check answers against these.")),
  h("div", { class: "form-actions" }, draftBtn, h("button", { type: "submit", class: "btn btn-primary" }, submitLabel)));
  return { form, fill };
}

function progressPoller(ctx, pid, box, onDone) {
  const bar = h("div", { class: "progress progress-lg", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": 0, "aria-label": "First pass progress" }, h("span", { style: { width: "0%" } }));
  const label = h("p", { class: "muted", "aria-live": "polite" }, "Queuing answers…");
  box.append(bar, label);
  let errors = 0, polls = 0;
  const tick = async () => {
    if (!box.isConnected) return;
    polls++;
    try {
      const p = await api(`projects/${pid}/progress`, { quiet: true });
      errors = 0;
      const total = p.total || 0, done = (p.done || 0) + (p.failed || 0);
      const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
      bar.firstChild.style.width = `${pct}%`;
      bar.setAttribute("aria-valuenow", String(pct));
      label.textContent = total ? `${fmt.int(p.done || 0)} of ${fmt.int(total)} answers collected${p.failed ? `, ${fmt.int(p.failed)} failed` : ""}${p.running ? `, ${fmt.int(p.running)} running` : ""}.` : polls > 10 ? "Waiting for the run to start…" : "Queuing answers…";
      if (total && done >= total && !p.running) { label.textContent = `Done: ${fmt.int(p.done || 0)} answers collected${p.failed ? `, ${fmt.int(p.failed)} failed` : ""}.`; if (onDone) onDone(p); return; }
    } catch (err) {
      errors++;
      if (errors >= 3) label.textContent = `Can't read progress right now (${err.message}). Still checking…`;
    }
    setTimeout(tick, Math.min(8000, 2000 + errors * 2000));
  };
  tick();
}

// ---------- wizard ----------
function wizard(ctx, host, startProject) {
  let project = startProject;
  let step = project ? Math.max(1, Math.min(stepOf(project), DONE - 1)) : 0; // step 0 creates a project, so never revisit it
  const wctx = () => ({ ...ctx, pid: project && project.id });
  const stepper = h("ol", { class: "stepper" });
  const body = h("div", { class: "wizard-body" });
  host.append(h("div", { class: "card wizard" }, h("div", { class: "card-body" }, stepper, body)));

  const go = (n) => {
    step = n;
    clear(stepper).append(...STEPS.map((s, i) => h("li", { class: [i < step && "is-done", i === step && "is-current"], "aria-current": i === step ? "step" : null }, h("span", { class: "step-dot num" }, i < step ? "✓" : String(i + 1)), h("span", { class: "step-name" }, s))));
    clear(body);
    if (project && step > stepOf(project) && step < DONE) { project.onboarding_step = step; setStep(project.id, step); }
    [stepBrand, stepProfile, stepTopics, stepPrompts, stepCompetitors, stepEngines, stepFinish][step]();
    viewIn(body);
  };
  const nav = (back, next, nextLabel = "Continue", disabled = false) => h("div", { class: "wizard-nav" },
    back ? h("button", { type: "button", class: "btn btn-ghost", onclick: () => go(step - 1) }, "Back") : h("span"),
    next ? h("button", { type: "button", class: "btn btn-primary", disabled, onclick: next }, nextLabel) : null);
  const title = (t, sub) => [h("h2", { class: "wizard-title" }, t), sub ? h("p", { class: "muted" }, sub) : null];

  function stepBrand() {
    const name = h("input", { class: "input", required: true, maxlength: 80, placeholder: "Acme" });
    const domain = h("input", { class: "input", required: true, maxlength: 120, placeholder: "acme.com", inputmode: "url" });
    // Start from what they gave at signup, the way Peec asks for the domain only once.
    const t = ctx.me && ctx.me.tenant ? ctx.me.tenant : null;
    if (t && !ctx.projects.length) {
      if (t.signup_website) domain.value = t.signup_website;
      if (t.name) name.value = t.name;
    }
    const form = h("form", { class: "form-grid", onsubmit: async (e) => {
      e.preventDefault();
      const d = domain.value.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) { toast("Enter a domain like acme.com", "error"); domain.focus(); return; }
      const btn = form.querySelector("[type=submit]"); btn.disabled = true;
      try {
        project = await api("projects", { method: "POST", body: { name: name.value.trim(), domain: d } });
        await ctx.refreshProjects(project.id);
        await setStep(project.id, 1);
        project.onboarding_step = 1;
        history.replaceState(null, "", `#/setup?tab=onboarding&p=${encodeURIComponent(project.id)}`);
        go(1);
      } catch { btn.disabled = false; }
    } }, field("Brand name", name), field("Website domain", domain, "We'll read it to draft your profile."),
    h("div", { class: "form-actions" }, h("button", { type: "submit", class: "btn btn-primary" }, "Create project")));
    body.append(...title("Start with your brand", "Each project tracks one brand on one website."), form);
    name.focus();
  }

  function stepProfile() {
    body.append(...title("Describe what you sell", "We draft this from your website. Edit anything that's off, then save."));
    const box = h("div");
    body.append(box);
    load(box, () => api(`projects/${project.id}`), (r) => {
      const { form } = profileForm(wctx(), project.id, (r && r.profile) || {}, { submitLabel: "Save and continue", onSaved: () => go(2) });
      box.append(form);
      if (!(r && r.profile && r.profile.what_you_sell)) {
        const draftBtn = form.querySelector(".form-actions .btn:not(.btn-primary)");
        if (draftBtn) draftBtn.click();
      }
    });
    body.append(nav(false, null));
  }

  function stepTopics() {
    body.append(...title("Pick your topics", "Topics group prompts so you can filter reports by the themes you care about."));
    const list = h("div", { class: "check-list" });
    const custom = h("input", { class: "input", placeholder: "Add your own topic", maxlength: 60 });
    const addRow = (t, checked) => list.append(h("label", { class: "check-row" }, h("input", { type: "checkbox", value: t.id, checked, "data-status": t.status }), h("span", null, t.name), t.status === "suggested" ? badge("Suggested", "warn") : null));
    const box = h("div", null, skeleton(5));
    body.append(box, nav(true, async () => {
      const inputs = Array.from(list.querySelectorAll("input"));
      if (!inputs.some((i) => i.checked)) { toast("Keep at least one topic.", "error"); return; }
      await Promise.all(inputs.map((i) => {
        const want = i.checked ? "active" : "rejected";
        return i.dataset.status === want ? null : api(`projects/${project.id}/topics/${encodeURIComponent(i.value)}`, { method: "PATCH", body: { status: want }, quiet: true }).catch(() => null);
      }));
      ctx.invalidateMeta && ctx.invalidateMeta();
      go(3);
    }));
    (async () => {
      try {
        let topics = await api(`projects/${project.id}/topics`);
        topics = Array.isArray(topics) ? topics.filter((t) => t.status !== "rejected") : [];
        if (!topics.length) { const r = await api(`projects/${project.id}/onboarding/topics`, { method: "POST" }); topics = (r && r.topics) || []; }
        clear(box).append(list, h("form", { class: "row", onsubmit: async (e) => {
          e.preventDefault();
          const n = custom.value.trim(); if (!n) return;
          try { const t = await api(`projects/${project.id}/topics`, { method: "POST", body: { name: n } }); addRow({ id: t.id, name: t.name || n, status: t.status || "active" }, true); custom.value = ""; } catch { /* toast shown */ }
        } }, custom, h("button", { type: "submit", class: "btn" }, icon("plus"), "Add")));
        topics.forEach((t) => addRow(t, true));
        reveal(Array.from(list.children), { stagger: 0.03 });
      } catch (err) { clear(box).append(errorBox(err, () => go(2))); }
    })();
  }

  function stepPrompts() {
    body.append(...title("Generate prompts", "Choose the mix, generate, then accept at least 10 to track."));
    const count = h("select", { class: "select" }, [10, 20, 30, 50].map((n) => h("option", { value: n, selected: n === 20 }, `${n} prompts`)));
    const branded = h("input", { type: "range", min: 0, max: 60, step: 5, value: 20, class: "range" });
    const brandedOut = h("output", { class: "num" }, "20%");
    branded.addEventListener("input", () => { brandedOut.textContent = `${branded.value}%`; });
    const mix = { informational: 25, commercial: 50, transactional: 25 };
    const mixOut = h("p", { class: "muted small num" });
    const showMix = () => { const t = Object.values(mix).reduce((a, b) => a + b, 0) || 1; mixOut.textContent = Object.entries(mix).map(([k, v]) => `${fmt.label(k)} ${Math.round((v / t) * 100)}%`).join(" · "); };
    const sliders = Object.keys(mix).map((k) => field(fmt.label(k), h("input", { type: "range", min: 0, max: 100, step: 5, value: mix[k], class: "range", oninput: (e) => { mix[k] = Number(e.target.value); showMix(); } })));
    showMix();
    const country = h("input", { class: "input", value: "US", maxlength: 2, style: { textTransform: "uppercase" } });
    const acceptedNote = h("p", { class: "muted", "aria-live": "polite" });
    const results = h("div");
    let accepted = 0;
    const nextBtn = h("button", { type: "button", class: "btn btn-primary", disabled: true, onclick: () => go(4) }, "Continue");
    const refreshCount = async () => {
      try { const a = await api(`projects/${project.id}/prompts`, { query: { status: "active" }, quiet: true }); accepted = Array.isArray(a) ? a.length : 0; } catch { /* keep */ }
      acceptedNote.textContent = accepted >= 10 ? `${accepted} prompts accepted. You can continue or add more.` : `${accepted} of 10 prompts accepted so far.`;
      nextBtn.disabled = accepted < 10;
    };
    const gen = h("button", { type: "button", class: "btn btn-primary", onclick: async () => {
      gen.disabled = true; gen.textContent = "Generating…";
      clear(results).append(skeleton(6));
      try {
        const t = Object.values(mix).reduce((a, b) => a + b, 0) || 1;
        const topics = await api(`projects/${project.id}/topics`).catch(() => []);
        const r = await api(`projects/${project.id}/onboarding/prompts`, { method: "POST", body: {
          count: Number(count.value), branded_share: Number(branded.value) / 100,
          intent_mix: Object.fromEntries(Object.entries(mix).map(([k, v]) => [k, +(v / t).toFixed(3)])),
          country: (country.value.trim() || "US").toUpperCase(), language: "en",
          topic_ids: (Array.isArray(topics) ? topics : []).filter((x) => x.status === "active").map((x) => x.id),
        } });
        const rows = (r && r.prompts) || [];
        clear(results);
        if (!rows.length) { results.append(empty("No prompts came back", "Try again, or add prompts by hand later.")); return; }
        const list = h("div", { class: "check-list" }, rows.map((p) => h("label", { class: "check-row" }, h("input", { type: "checkbox", value: p.id, checked: true }),
          h("span", null, p.text), p.intent ? badge(fmt.label(p.intent)) : null, p.branded ? badge("Branded", "accent") : null)));
        const acceptBtn = h("button", { type: "button", class: "btn btn-primary", onclick: async () => {
          acceptBtn.disabled = true;
          const boxes = Array.from(list.querySelectorAll("input"));
          await Promise.all(boxes.map((b) => api(`projects/${project.id}/prompts/${encodeURIComponent(b.value)}`, { method: "PATCH", body: { status: b.checked ? "active" : "rejected" }, quiet: true }).catch(() => null)));
          toast(`Accepted ${boxes.filter((b) => b.checked).length} prompts`, "ok");
          clear(results);
          refreshCount();
        } }, "Accept selected");
        results.append(h("div", { class: "card-toolbar" }, h("span", { class: "muted small" }, "Untick any you don't want."), acceptBtn), list);
        reveal(Array.from(list.children), { stagger: 0.02 });
      } catch (err) { clear(results).append(errorBox(err)); }
      finally { gen.disabled = false; gen.textContent = "Generate prompts"; }
    } }, "Generate prompts");
    body.append(h("div", { class: "form-grid" }, field("How many", count), field("Country", country),
      h("div", { class: "span-all" }, field("Branded share", h("div", { class: "range-row" }, branded, brandedOut), "How many prompts name your brand. Unbranded prompts show whether you come up on your own.")),
      h("fieldset", { class: "span-all fieldset" }, h("legend", null, "Intent mix"), h("div", { class: "grid-3" }, sliders), mixOut),
      h("div", { class: "form-actions" }, gen)), results, acceptedNote,
      h("div", { class: "wizard-nav" }, h("button", { type: "button", class: "btn btn-ghost", onclick: () => go(2) }, "Back"), nextBtn));
    refreshCount();
  }

  function stepCompetitors() {
    body.append(...title("Who do you compete with?", "Track the brands you lose deals to. Add aliases so we catch every mention."));
    const box = h("div", { class: "stack" });
    body.append(box, nav(true, () => go(5)));
    (async () => {
      const brands = await brandsFor(project.id, true);
      if (!brands.some((b) => b.is_own)) {
        await api(`projects/${project.id}/brands`, { method: "POST", body: { name: project.name, domains: project.domain ? [project.domain] : [], is_own: true }, quiet: true }).catch(() => null);
        dropBrands(project.id);
      }
      brandsManager(wctx(), box);
    })();
  }

  function stepEngines() {
    body.append(...title("Engines and countries", "Choose where to ask. Each engine and country multiplies the answers per pass."));
    const box = h("div", { class: "stack" });
    body.append(box);
    let save = null;
    load(box, () => Promise.all([api(`projects/${project.id}/models`), api(`projects/${project.id}/countries`).catch(() => ({ countries: [] }))]), ([models, c]) => {
      const e = enginesEditor(models || [], planLimit(ctx, "models"));
      const k = countriesEditor((c && c.countries) || [], planLimit(ctx, "countries"));
      box.append(h("h3", { class: "sub-title" }, "Engines"), e.el, h("h3", { class: "sub-title" }, "Countries"), k.el);
      save = async () => {
        const engines = e.value(), countries = k.value();
        if (!engines.length) { toast("Pick at least one engine.", "error"); return; }
        if (!countries.length) { toast("Add at least one country.", "error"); return; }
        try {
          await api(`projects/${project.id}/models`, { method: "PUT", body: { engines } });
          await api(`projects/${project.id}/countries`, { method: "PUT", body: { countries } });
          ctx.invalidateMeta && ctx.invalidateMeta();
          go(6);
        } catch { /* toast shown */ }
      };
    });
    body.append(nav(true, () => save && save()));
  }

  function stepFinish() {
    body.append(...title("Run your first pass", "We'll ask every engine every prompt now. You'll land on your overview when it's done."));
    const box = h("div", { class: "stack" });
    body.append(box);
    load(box, () => api(`projects/${project.id}`), (r) => {
      const c = (r && r.counts) || {};
      box.append(h("div", { class: "kpis kpis-compact" }, [["Prompts", c.prompts], ["Brands", c.brands], ["Topics", c.topics]].map(([l, v]) => h("div", { class: "kpi" }, h("p", { class: "kpi-label" }, l), h("span", { class: "kpi-value num" }, fmt.int(v))))));
      const run = h("button", { type: "button", class: "btn btn-primary btn-lg", onclick: async () => {
        run.disabled = true;
        try {
          await api(`projects/${project.id}/onboarding/finish`, { method: "POST" });
          project.onboarding_step = DONE;
          await setStep(project.id, DONE);
          const p = h("div", { class: "stack" });
          run.replaceWith(p);
          progressPoller(ctx, project.id, p, () => {
            ctx.refreshProjects(project.id);
            p.append(h("div", { class: "row" }, h("a", { class: "btn btn-primary", href: `#/overview?p=${encodeURIComponent(project.id)}` }, "Open your overview")));
            setTimeout(() => { if (p.isConnected) location.hash = `#/overview?p=${encodeURIComponent(project.id)}`; }, 1500);
          });
        } catch { run.disabled = false; }
      } }, "Run first pass");
      box.append(run);
    });
    body.append(nav(true, null));
  }

  go(step);
}

// ---------- editors ----------
const planLimit = (ctx, key) => { const n = ctx && ctx.me && ctx.me.tenant && ctx.me.tenant.limits ? Number(ctx.me.tenant.limits[key]) : 0; return Number.isFinite(n) && n > 0 ? n : 0; };

/** Engine checkboxes. With a plan limit, boxes beyond it are disabled and the limit is said up front. */
function enginesEditor(models, limit = 0) {
  const note = limit ? h("p", { class: "muted small" }, `Your plan includes up to ${limit} engine${limit === 1 ? "" : "s"} per project.`) : null;
  const list = h("div", { class: "check-list" }, models.map((m) => {
    const off = m.available === false || m.channel === "unavailable";
    return h("label", { class: ["check-row", off && "is-disabled"] },
      h("input", { type: "checkbox", value: m.engine, checked: !!m.enabled && !off, disabled: off, "data-off": off ? "1" : null }),
      h("span", null, m.label || m.engine), channelBadge(m.channel), m.note ? h("small", { class: "muted" }, m.note) : null);
  }));
  const boxes = () => Array.from(list.querySelectorAll("input"));
  const enforce = () => {
    if (!limit) return;
    const checked = boxes().filter((i) => i.checked);
    checked.slice(limit).forEach((i) => { i.checked = false; });
    const full = boxes().filter((i) => i.checked).length >= limit;
    boxes().forEach((i) => {
      if (i.dataset.off) return;
      i.disabled = full && !i.checked;
      i.closest(".check-row")?.classList.toggle("is-disabled", i.disabled);
    });
  };
  list.addEventListener("change", enforce);
  enforce();
  const el = h("div", { class: "stack-sm" }, note, list);
  if (!models.length) el.append(h("p", { class: "muted" }, "No engines are configured for this workspace."));
  return { el, value: () => boxes().filter((i) => i.checked).map((i) => i.value) };
}

function countriesEditor(list, limit = 0) {
  const set = new Set(list.map((c) => String(c).toUpperCase()));
  const chips = h("div", { class: "chips" });
  const draw = () => clear(chips).append(...[...set].map((c) => h("span", { class: "chip chip-static" }, c, h("button", { type: "button", class: "chip-x", "aria-label": `Remove ${c}`, onclick: () => { set.delete(c); draw(); } }, icon("close")))));
  const input = h("input", { class: "input input-sm", maxlength: 2, placeholder: "GB", "aria-label": "Country code", style: { textTransform: "uppercase", width: "80px" } });
  const add = () => { const v = input.value.trim().toUpperCase(); if (/^[A-Z]{2}$/.test(v)) { if (limit && !set.has(v) && set.size >= limit) { toast(`Your plan covers up to ${limit} countr${limit === 1 ? "y" : "ies"}. Remove one to add another.`, "error"); return; } set.add(v); input.value = ""; draw(); } else toast("Use a two-letter country code, like GB.", "error"); };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  draw();
  return { el: h("div", { class: "stack-sm" }, chips, h("div", { class: "row" }, input, h("button", { type: "button", class: "btn btn-sm", onclick: add }, icon("plus"), "Add country"))), value: () => [...set] };
}

// ---------- tabs ----------
function projectTab(ctx, box) {
  load(box, () => api(`projects/${ctx.pid}`), (r) => {
    const p = (r && r.project) || ctx.project || {};
    const name = h("input", { class: "input", required: true, value: p.name || "" });
    const schedule = h("select", { class: "select" }, [["daily", "Daily"], ["weekly", "Weekly"], ["paused", "Paused"]].map(([v, l]) => h("option", { value: v, selected: v === p.schedule }, l)));
    const settings = h("form", { class: "form-grid", onsubmit: async (e) => {
      e.preventDefault();
      try { await api(`projects/${ctx.pid}`, { method: "PATCH", body: { name: name.value.trim(), schedule: schedule.value } }); toast("Settings saved", "ok"); ctx.refreshProjects(ctx.pid); } catch { /* toast shown */ }
    } }, field("Project name", name), field("Schedule", schedule, "How often every prompt is asked on every engine."),
    h("div", { class: "form-actions" }, h("button", { type: "submit", class: "btn btn-primary" }, "Save settings")));
    const runBox = h("div", { class: "stack-sm" });
    const runBtn = h("button", { type: "button", class: "btn", onclick: async () => {
      runBtn.disabled = true;
      try { await api(`projects/${ctx.pid}/run`, { method: "POST" }); toast("Pass queued", "ok"); progressPoller(ctx, ctx.pid, runBox, () => { runBtn.disabled = false; }); } catch { runBtn.disabled = false; }
    } }, "Run a pass now");
    const c = (r && r.counts) || {};
    box.append(...[
      h("div", { class: "kpis kpis-compact" }, [["Prompts", c.prompts], ["Brands", c.brands], ["Topics", c.topics], ["Runs", c.runs]].map(([l, v]) => h("div", { class: "kpi" }, h("p", { class: "kpi-label" }, l), h("span", { class: "kpi-value num" }, fmt.int(v))))),
      card("Project", {}, ctx.readOnly ? h("p", null, `${p.name || ""} · ${p.domain || ""} · ${fmt.label(p.schedule || "")} schedule`) : settings),
      ctx.readOnly ? null : card("Run now", {}, h("p", { class: "muted small" }, "Queue a full pass outside the schedule, for example after changing prompts."), runBtn, runBox),
      card("Profile", {}, ctx.readOnly ? h("dl", { class: "kv-list" }, h("dt", null, "What you sell"), h("dd", null, (r.profile && r.profile.what_you_sell) || "–"), h("dt", null, "Buyers"), h("dd", null, (r.profile && r.profile.buyers) || "–"))
        : profileForm(ctx, ctx.pid, (r && r.profile) || {}).form)].filter(Boolean));
    if (stepOf(p) < DONE && !ctx.readOnly) box.prepend(h("p", { class: "notice" }, icon("info"), h("span", null, "Setup isn't finished for this project. "), h("a", { href: `#/setup?tab=onboarding&p=${encodeURIComponent(ctx.pid)}` }, "Continue setup")));
  }, 6);
}

function enginesTab(ctx, box) {
  load(box, () => api(`projects/${ctx.pid}/models`), (models) => {
    const e = enginesEditor(Array.isArray(models) ? models : [], planLimit(ctx, "models"));
    if (ctx.readOnly) e.el.querySelectorAll("input").forEach((i) => { i.disabled = true; });
    box.append(h("p", { class: "muted" }, "Engines marked as stub run on a labelled stand-in until a live API key is configured, so their answers aren't real model output."), e.el,
      h("div", { class: "form-actions", "data-write": "" }, h("button", { type: "button", class: "btn btn-primary", onclick: async () => {
        const engines = e.value();
        if (!engines.length) { toast("Pick at least one engine.", "error"); return; }
        try { await api(`projects/${ctx.pid}/models`, { method: "PUT", body: { engines } }); toast("Engines saved", "ok"); } catch { /* toast shown */ }
      } }, "Save engines")));
  });
}

function countriesTab(ctx, box) {
  load(box, () => api(`projects/${ctx.pid}/countries`), (r) => {
    const list = (r && r.countries) || [];
    if (ctx.readOnly) { box.append(list.length ? h("div", { class: "chips" }, list.map((c) => h("span", { class: "chip chip-static" }, c))) : empty("No countries set")); return; }
    const k = countriesEditor(list, planLimit(ctx, "countries"));
    box.append(h("p", { class: "muted" }, "Prompts run once per country, so answers reflect what buyers in each market see."), k.el,
      h("div", { class: "form-actions" }, h("button", { type: "button", class: "btn btn-primary", onclick: async () => {
        const countries = k.value();
        if (!countries.length) { toast("Add at least one country.", "error"); return; }
        try { await api(`projects/${ctx.pid}/countries`, { method: "PUT", body: { countries } }); toast("Countries saved", "ok"); ctx.invalidateMeta(); } catch { /* toast shown */ }
      } }, "Save countries")));
  });
}

function codeBlock(text, label) {
  return h("div", { class: "code-block" }, h("div", { class: "code-head" }, h("span", { class: "muted small" }, label), copyBtn(text, "Copy")), h("pre", null, h("code", null, text)));
}
function kvRows(obj) {
  if (!obj) return [];
  if (Array.isArray(obj)) return obj.map((x) => (typeof x === "object" ? [x.name || x.key, x.value ?? x.example ?? ""] : [String(x), ""]));
  return Object.entries(obj).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
}

function trackingTab(ctx, box) {
  load(box, () => api(`projects/${ctx.pid}/tracking`), (t) => {
    const vars = kvRows(t.edge_worker && t.edge_worker.vars);
    const headers = kvRows(t.sgtm && t.sgtm.headers);
    const kvTable = (rows, label) => table([
      { label: "Name", render: (r) => h("code", null, r[0]) },
      { label: "Value", render: (r) => h("code", { class: "break" }, r[1]) },
      { label: "", render: (r) => copyBtn(r[1], "Copy") },
    ], rows, { label });
    box.append(...[
      h("p", { class: "muted" }, "Send website data with an ingest key from Usage & API. Use one or more of these, depending on how your site is hosted."),
      card("1. Page tap (tap.js)", {}, h("p", { class: "muted small" }, "Paste before the closing </head> tag on every page. It records visits that arrive from AI assistants."), t.tap_snippet ? codeBlock(t.tap_snippet, "HTML") : empty("No snippet available")),
      card("2. Edge worker", {}, h("p", { class: "muted small" }, "Logs AI crawler hits (training, search and retrieval bots) at your edge, before caching hides them."),
        t.edge_worker && t.edge_worker.repo_path ? h("p", null, "Worker source: ", h("code", null, t.edge_worker.repo_path)) : null,
        vars.length ? kvTable(vars, "Edge worker variables") : null),
      card("3. Server-side conversions", {}, h("p", { class: "muted small" }, "Send conversions from your server-side tagging so revenue lines up with pages and prompts."),
        t.sgtm && t.sgtm.endpoint ? codeBlock(t.sgtm.endpoint, "Endpoint") : null,
        headers.length ? kvTable(headers, "Request headers") : null),
      t.ingest_endpoint ? card("Ingest endpoint", {}, codeBlock(t.ingest_endpoint, "Base URL")) : null].filter(Boolean));
  }, 6);
}

export default async function setup(ctx) {
  const project = ctx.project;
  const inOnboarding = project && !ctx.readOnly && stepOf(project) < DONE;
  let tab = ctx.q.get("tab") || (inOnboarding ? "onboarding" : project ? "project" : "new");
  if (!project && !["new"].includes(tab)) tab = "new";
  const items = [["project", "Project"], ["engines", "Engines"], ["countries", "Countries"], ["tracking", "Tracking"]];
  if (inOnboarding) items.unshift(["onboarding", "Finish setup"]);
  if (!ctx.readOnly) items.push(["new", "New project"]);
  ctx.el.append(pageHead("Setup", tab === "new" ? "Create a project and run its first pass." : project ? `${project.name} · ${project.domain || ""}` : ""));
  if (project || !ctx.readOnly) ctx.el.append(h("div", { class: "toolbar" }, tabs(items.filter(([id]) => project || id === "new"), tab, (id) => ctx.setQuery({ tab: id }))));
  const box = h("div", { class: "stack" });
  ctx.el.append(box);
  if ((tab === "new" || tab === "onboarding") && ctx.readOnly) { box.append(empty("Setup is turned off here", "This workspace is read-only. Explore the reports, or open the docs to see how setup works.", h("a", { class: "btn", href: "/docs/" }, "Read the docs"))); return; }
  if (tab === "new") wizard(ctx, box, null);
  else if (tab === "onboarding") wizard(ctx, box, project);
  else if (tab === "engines") enginesTab(ctx, box);
  else if (tab === "countries") countriesTab(ctx, box);
  else if (tab === "tracking") trackingTab(ctx, box);
  else projectTab(ctx, box);
}
