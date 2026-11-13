// Prompts: performance per prompt, plus managing the prompt list (add, archive, CSV import, suggestions).
import { h, clear, fmt, plural, badge, tabs, table, skeleton, empty, toast, field, csv, icon } from "../dom.js";
import { api } from "../api.js";
import { staggerRows } from "../anim.js";
import { pageHead, needProject, sortRows, load } from "./common.js";

const INTENTS = ["informational", "commercial", "transactional", "navigational"];

function sortableTable(cols, rows, label) {
  let key = null, dir = "desc";
  const box = h("div");
  const draw = () => {
    const sorted = sortRows(rows, key, dir);
    const t = table(cols.map((c) => ({ ...c, label: c.sort ? h("button", { type: "button", class: "sort-btn", "aria-label": `Sort by ${c.label}`, onclick: () => { dir = key === c.sort && dir === "desc" ? "asc" : "desc"; key = c.sort; draw(); } }, c.label, key === c.sort ? icon(dir === "desc" ? "down" : "up") : null) : c.label })), sorted, { label });
    t.querySelectorAll("th").forEach((th, i) => { if (cols[i].sort) th.setAttribute("aria-sort", key === cols[i].sort ? (dir === "asc" ? "ascending" : "descending") : "none"); });
    box.replaceChildren(t);
    return t;
  };
  staggerRows(draw().querySelector("tbody"));
  return box;
}

function performance(ctx, box) {
  return load(box, () => api(`projects/${ctx.pid}/prompts/performance`, { query: ctx.fq() }), (r) => {
    const rows = (r && r.items) || [];
    if (!rows.length) { box.append(empty("No prompt results in this range", "Results appear after your prompts run. Check Setup for run progress.")); return; }
    box.append(sortableTable([
      { label: "Prompt", render: (p) => h("span", { class: "prompt-cell" }, p.text), class: "col-wide" },
      { label: "Topic", render: (p) => p.topic || "–" },
      { label: "Visibility", sort: "visibility", num: true, render: (p) => fmt.pct(p.visibility) },
      { label: "Position", sort: "position", num: true, render: (p) => fmt.dec(p.position, 1) },
      { label: "Sentiment", sort: "sentiment", num: true, render: (p) => fmt.dec(p.sentiment, 0) },
      { label: "Answers", sort: "answers", num: true, render: (p) => fmt.int(p.answers) },
      { label: "Best engine", render: (p) => (p.best_engine ? ctx.engineLabel(p.best_engine) : "–") },
      { label: "Worst engine", render: (p) => (p.worst_engine ? ctx.engineLabel(p.worst_engine) : "–") },
    ], rows, "Prompt performance"));
  }, 8);
}

function addForm(ctx, topics, onDone) {
  const text = h("textarea", { class: "input", rows: 2, required: true, maxlength: 500, placeholder: "e.g. What's the best project tracking tool for a small design studio?" });
  const country = h("input", { class: "input", maxlength: 2, placeholder: "US", value: "US", style: { textTransform: "uppercase" } });
  const topic = h("select", { class: "select" }, h("option", { value: "" }, "No topic"), topics.map((t) => h("option", { value: t.id }, t.name)));
  const intent = h("select", { class: "select" }, INTENTS.map((i) => h("option", { value: i, selected: i === "commercial" }, fmt.label(i))));
  const tags = h("input", { class: "input", placeholder: "comma, separated" });
  const branded = h("input", { type: "checkbox" });
  const form = h("form", { class: "form-grid", onsubmit: async (e) => {
    e.preventDefault();
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      await api(`projects/${ctx.pid}/prompts`, { method: "POST", body: { text: text.value.trim(), country: country.value.trim().toUpperCase() || undefined, topic_id: topic.value || undefined, tags: csv(tags.value), intent: intent.value, branded: branded.checked } });
      toast("Prompt added", "ok");
      text.value = ""; tags.value = "";
      ctx.invalidateMeta();
      onDone();
    } catch { /* toast shown */ } finally { btn.disabled = false; }
  } },
  h("div", { class: "span-all" }, field("Prompt", text)), field("Country", country), field("Topic", topic), field("Intent", intent), field("Tags", tags),
  h("label", { class: "check" }, branded, "Branded (names your brand)"),
  h("div", { class: "form-actions" }, h("button", { type: "submit", class: "btn btn-primary" }, icon("plus"), "Add prompt")));
  return form;
}

function importForm(ctx, onDone) {
  const file = h("input", { type: "file", accept: ".csv,text/csv", class: "input" });
  const out = h("div", { "aria-live": "polite" });
  const form = h("form", { class: "import", onsubmit: async (e) => {
    e.preventDefault();
    const f = file.files && file.files[0];
    if (!f) { toast("Choose a CSV file first.", "error"); return; }
    if (f.size > 2_000_000) { toast("That file is too large. Keep imports under 2 MB.", "error"); return; }
    const body = await f.text();
    clear(out);
    try {
      const r = await api(`projects/${ctx.pid}/prompts/import`, { method: "POST", body, headers: { "Content-Type": "text/csv" } });
      out.append(h("p", { class: "notice" }, icon("info"), h("span", null, `Imported ${fmt.int(r.imported || 0)} prompts.${(r.errors || []).length ? ` ${r.errors.length} lines were skipped:` : ""}`)));
      if ((r.errors || []).length) out.append(h("ul", { class: "plain-list small" }, r.errors.slice(0, 20).map((er) => h("li", null, `Line ${er.line}: ${er.message}`))));
      file.value = "";
      ctx.invalidateMeta();
      onDone();
    } catch { /* toast shown */ }
  } },
  h("p", { class: "muted small" }, "Columns: prompt, country, topic, then any number of tags. One prompt per line."),
  h("div", { class: "row" }, file, h("button", { type: "submit", class: "btn" }, "Import CSV")), out);
  return form;
}

async function patchPrompt(ctx, id, body, msg) {
  try { await api(`projects/${ctx.pid}/prompts/${encodeURIComponent(id)}`, { method: "PATCH", body }); if (msg) toast(msg, "ok"); ctx.invalidateMeta(); return true; } catch { return false; }
}

function manage(ctx, box, status) {
  const listBox = h("div", { class: "card card-flush" });
  const reload = () => drawList();
  const drawList = () => load(listBox, () => Promise.all([api(`projects/${ctx.pid}/prompts`, { query: { status } }), api(`projects/${ctx.pid}/topics`).catch(() => [])]), ([rows]) => {
    rows = Array.isArray(rows) ? rows : [];
    if (!rows.length) { listBox.append(empty(status === "archived" ? "No archived prompts" : "No active prompts yet", status === "archived" ? null : "Add prompts above, import a CSV, or accept suggestions.")); return; }
    const search = h("input", { class: "input input-sm", type: "search", placeholder: "Search prompts", "aria-label": "Search prompts" });
    const t = table([
      { label: "Prompt", class: "col-wide", render: (p) => h("span", { class: "prompt-cell" }, p.text) },
      { label: "Topic", render: (p) => p.topic || "–" },
      { label: "Country", key: "country" },
      { label: "Intent", render: (p) => (p.intent ? fmt.label(p.intent) : "–") },
      { label: "Branded", render: (p) => (p.branded ? badge("Branded", "accent") : "–") },
      { label: "Tags", render: (p) => (p.tags || []).map((tg) => badge(tg)) },
      { label: "Volume", num: true, render: (p) => fmt.int(p.volume) },
      { label: "", render: (p) => h("button", { type: "button", class: "btn btn-sm", "data-write": "", onclick: async () => { if (await patchPrompt(ctx, p.id, { status: status === "archived" ? "active" : "archived" }, status === "archived" ? "Prompt restored" : "Prompt archived")) reload(); } }, status === "archived" ? "Restore" : "Archive") },
    ], rows, { label: "Prompts", rowAttrs: (p) => ({ "data-q": String(p.text || "").toLowerCase() }) });
    search.addEventListener("input", () => { const v = search.value.toLowerCase().trim(); t.querySelectorAll("tbody tr").forEach((tr) => { tr.hidden = !!v && !tr.dataset.q.includes(v); }); });
    listBox.append(h("div", { class: "card-toolbar" }, search, h("span", { class: "muted small" }, plural(rows.length, "prompt"))), t);
    staggerRows(t.querySelector("tbody"));
  }, 8);

  const topicsP = api(`projects/${ctx.pid}/topics`).catch(() => []);
  if (!ctx.readOnly && status === "active") {
    const add = h("div", { class: "card" }, h("header", { class: "card-head" }, h("h2", { class: "card-title" }, "Add a prompt")), h("div", { class: "card-body" }, skeleton(2)));
    const imp = h("div", { class: "card" }, h("header", { class: "card-head" }, h("h2", { class: "card-title" }, "Import from CSV")), h("div", { class: "card-body" }, importForm(ctx, reload)));
    box.append(h("div", { class: "grid-2" }, add, imp));
    topicsP.then((topics) => add.querySelector(".card-body").replaceChildren(addForm(ctx, Array.isArray(topics) ? topics : [], reload)));
  }
  box.append(h("div", { class: "toolbar" }, tabs([["active", "Active"], ["archived", "Archived"]], status, (id) => ctx.setQuery({ status: id === "active" ? null : id }))), listBox);
  drawList();
}

function suggested(ctx, box) {
  const listBox = h("div", { class: "card card-flush" });
  box.append(h("p", { class: "muted" }, "Suggested prompts come from setup and from questions we see assistants answer in your space. Accept the ones worth tracking."), listBox);
  const draw = () => load(listBox, () => api(`projects/${ctx.pid}/prompts`, { query: { status: "suggested" } }), (rows) => {
    rows = Array.isArray(rows) ? rows : [];
    if (!rows.length) { listBox.append(empty("No suggestions waiting", "New suggestions appear here as they're generated.")); return; }
    const acceptAll = h("button", { type: "button", class: "btn btn-primary btn-sm", "data-write": "", onclick: async () => {
      acceptAll.disabled = true;
      let ok = 0;
      for (const p of rows) if (await patchPrompt(ctx, p.id, { status: "active" })) ok++;
      toast(`Accepted ${ok} prompts`, "ok");
      draw();
    } }, `Accept all ${rows.length}`);
    const t = table([
      { label: "Prompt", class: "col-wide", render: (p) => h("span", { class: "prompt-cell" }, p.text) },
      { label: "Topic", render: (p) => p.topic || "–" },
      { label: "Intent", render: (p) => (p.intent ? fmt.label(p.intent) : "–") },
      { label: "Country", key: "country" },
      { label: "", render: (p) => h("div", { class: "row-actions", "data-write": "" },
        h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: async (e) => { if (await patchPrompt(ctx, p.id, { status: "active" }, "Prompt accepted")) e.target.closest("tr").remove(); } }, "Accept"),
        h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: async (e) => { if (await patchPrompt(ctx, p.id, { status: "rejected" }, "Suggestion dismissed")) e.target.closest("tr").remove(); } }, "Reject")) },
    ], rows, { label: "Suggested prompts" });
    listBox.append(h("div", { class: "card-toolbar" }, h("span", { class: "muted small" }, plural(rows.length, "suggestion")), acceptAll), t);
    staggerRows(t.querySelector("tbody"));
  }, 6);
  draw();
}

export default async function prompts(ctx) {
  if (needProject(ctx)) return;
  const tab = ["manage", "suggested"].includes(ctx.q.get("tab")) ? ctx.q.get("tab") : "performance";
  ctx.el.append(pageHead("Prompts", "The questions we ask each assistant on your behalf, and how you do on each."));
  ctx.el.append(h("div", { class: "toolbar" }, tabs([["performance", "Performance"], ["manage", "Manage"], ["suggested", "Suggested"]], tab, (id) => ctx.setQuery({ tab: id === "performance" ? null : id, status: null }))));
  const box = h("div", { class: "stack" });
  ctx.el.append(box);
  if (tab === "performance") { const c = h("div", { class: "card card-flush" }); box.append(c); await performance(ctx, c); }
  else if (tab === "manage") manage(ctx, box, ctx.q.get("status") === "archived" ? "archived" : "active");
  else suggested(ctx, box);
}
