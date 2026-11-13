// Actions: ranked recommendations with status tracking and on-demand content briefs.
import { h, clear, fmt, badge, tabs, skeleton, errorBox, empty, toast, drawer, safeUrl, copyBtn, icon } from "../dom.js";
import { api } from "../api.js";
import { flip, reveal } from "../anim.js";
import { pageHead, needProject, impactDots } from "./common.js";

const STATUSES = [["open", "Open"], ["in_progress", "In progress"], ["done", "Done"], ["dismissed", "Dismissed"]];

// Minimal, safe Markdown: headings, lists, paragraphs, bold, inline code and http(s) links. Builds nodes, never HTML.
function inline(text) {
  const frag = document.createDocumentFragment();
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1] != null) frag.append(h("strong", null, m[1]));
    else if (m[2] != null) frag.append(h("code", null, m[2]));
    else { const href = safeUrl(m[4]); frag.append(href ? h("a", { href, target: "_blank", rel: "noopener noreferrer nofollow" }, m[3]) : m[3]); }
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}
export function markdown(src) {
  const root = h("div", { class: "md" });
  let list = null, para = [];
  const flush = () => { if (para.length) { const p = h("p"); p.append(inline(para.join(" "))); root.append(p); para = []; } };
  for (const raw of String(src || "").replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const hm = /^(#{1,6})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (hm) { flush(); list = null; const el = h(`h${Math.min(6, hm[1].length + 2)}`); el.append(inline(hm[2])); root.append(el); }
    else if (ul || ol) {
      flush();
      const tag = ul ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== tag) { list = h(tag); root.append(list); }
      const li = h("li"); li.append(inline((ul || ol)[1])); list.append(li);
    } else if (!line.trim()) { flush(); list = null; }
    else if (/^-{3,}$/.test(line.trim())) { flush(); list = null; root.append(h("hr")); }
    else { list = null; para.push(line.trim()); }
  }
  flush();
  return root;
}

function evidenceList(ev) {
  if (!ev || typeof ev !== "object") return null;
  const entries = Object.entries(ev).filter(([, v]) => v != null && v !== "");
  if (!entries.length) return null;
  return h("details", { class: "evidence" }, h("summary", null, "Evidence"),
    h("dl", null, entries.slice(0, 12).flatMap(([k, v]) => [h("dt", null, fmt.label(k)), h("dd", null, typeof v === "object" ? JSON.stringify(v) : String(v))])));
}

function openBrief(ctx, a) {
  drawer("Content brief", async (body) => {
    body.append(h("p", { class: "eyebrow-sm" }, "Action"), h("h3", { class: "drawer-prompt" }, a.title), skeleton(10));
    try {
      const r = await api(`projects/${ctx.pid}/actions/${encodeURIComponent(a.id)}/brief`, { method: "POST" });
      const text = (r && r.brief) || "";
      body.querySelector(".skeleton")?.remove();
      body.append(h("div", { class: "row" }, copyBtn(text, "Copy Markdown")), text ? markdown(text) : empty("The brief came back empty", "Try again later."));
    } catch (err) {
      body.querySelector(".skeleton")?.replaceWith(errorBox(err, () => openBrief(ctx, a)));
    }
  });
}

function actionCard(ctx, a, onStatus) {
  const select = h("select", { class: "select select-sm", "aria-label": `Status for ${a.title}`, "data-write": "", onchange: async (e) => {
    const prev = a.status;
    try {
      await api(`projects/${ctx.pid}/actions/${encodeURIComponent(a.id)}`, { method: "PATCH", body: { status: e.target.value } });
      a.status = e.target.value;
      toast(`Marked ${fmt.label(a.status).toLowerCase()}`, "ok");
      onStatus(a, el);
    } catch { e.target.value = prev; }
  } }, STATUSES.map(([v, l]) => h("option", { value: v, selected: v === a.status }, l)));
  const el = h("article", { class: "action-card", "data-status": a.status },
    h("header", { class: "action-head" }, impactDots(a.impact), h("span", { class: "muted small" }, fmt.label(a.kind)),
      ctx.readOnly ? badge(fmt.label(a.status || "open")) : select),
    h("h3", null, a.title),
    a.detail ? h("p", { class: "action-detail" }, a.detail) : null,
    evidenceList(a.evidence),
    h("footer", { class: "action-foot" },
      h("span", { class: "muted small" }, a.done_at ? `Done ${fmt.dateLong(a.done_at)}` : a.created_at ? `Added ${fmt.dateLong(a.created_at)}` : ""),
      h("button", { type: "button", class: "btn btn-sm", onclick: () => openBrief(ctx, a) }, icon("prompts"), "Content brief")));
  return el;
}

export default async function actions(ctx) {
  if (needProject(ctx)) return;
  const status = ctx.q.get("status") || "open";
  ctx.el.append(pageHead("Actions", "What to do next, ranked by expected impact. Each one links back to the evidence behind it."));
  ctx.el.append(h("div", { class: "toolbar" }, tabs([...STATUSES, ["all", "All"]], status, (id) => ctx.setQuery({ status: id === "open" ? null : id }))));
  const box = h("div", null, skeleton(6, "block"));
  ctx.el.append(box);
  try {
    const r = await api(`projects/${ctx.pid}/actions`, { query: status === "all" ? {} : { status } });
    if (!ctx.alive()) return;
    const rows = ((r && r.items) || []).slice().sort((a, b) => (b.impact || 0) - (a.impact || 0));
    clear(box);
    if (!rows.length) { box.append(empty(status === "open" ? "No open actions" : "Nothing here", status === "open" ? "New actions are suggested as insights come in." : null)); return; }
    const grid = h("div", { class: "action-grid" });
    box.append(grid);
    const onStatus = (a, el) => {
      el.dataset.status = a.status;
      if (status !== "all" && a.status !== status) {
        const cards = Array.from(grid.children);
        flip(cards, () => el.remove(), { absolute: true });
        if (!grid.children.length) box.append(empty("All caught up", null));
      }
    };
    grid.append(...rows.map((a) => actionCard(ctx, a, onStatus)));
    reveal(Array.from(grid.children), { stagger: 0.04 });
  } catch (err) {
    if (ctx.alive()) clear(box).append(errorBox(err, () => { clear(ctx.el); actions(ctx); }));
  }
}
