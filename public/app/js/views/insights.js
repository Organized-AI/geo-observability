// Insights: plain-language notes on what moved, grouped by day.
import { h, clear, fmt, skeleton, errorBox, empty } from "../dom.js";
import { api } from "../api.js";
import { reveal } from "../anim.js";
import { pageHead, needProject, severityBadge } from "./common.js";

export default async function insights(ctx) {
  if (needProject(ctx)) return;
  ctx.el.append(pageHead("Insights", "What changed in your AI visibility, written up each day from the answers we collected."));
  const box = h("div", null, skeleton(6, "block"));
  ctx.el.append(box);
  try {
    const r = await api(`projects/${ctx.pid}/insights`, { query: { from: ctx.f.from, to: ctx.f.to } });
    if (!ctx.alive()) return;
    const rows = (r && r.items) || [];
    clear(box);
    if (!rows.length) { box.append(empty("No insights in this range", "Insights are written once enough answers come in to compare against the previous period.")); return; }
    const byDay = new Map();
    for (const i of rows) { const d = String(i.day || "").slice(0, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(i); }
    const days = [...byDay.keys()].sort().reverse();
    const timeline = h("div", { class: "timeline" });
    for (const d of days) {
      const items = byDay.get(d).sort((a, b) => (b.severity || 0) - (a.severity || 0));
      timeline.append(h("section", { class: "day-group", "aria-label": fmt.dateLong(d) },
        h("h2", { class: "day-label" }, fmt.dateLong(d)),
        h("ul", { class: "insight-list" }, items.map((i) => h("li", { class: `sev-${Math.min(3, Number(i.severity) || 1)}` },
          severityBadge(i.severity),
          h("div", null, h("p", null, i.text), i.kind ? h("p", { class: "muted small" }, fmt.label(i.kind)) : null,
            i.evidence && typeof i.evidence === "object" && Object.keys(i.evidence).length
              ? h("details", { class: "evidence" }, h("summary", null, "Evidence"), h("pre", { class: "mono small" }, JSON.stringify(i.evidence, null, 2)))
              : null))))));
    }
    box.append(timeline);
    reveal(Array.from(timeline.children), { stagger: 0.05 });
  } catch (err) {
    if (ctx.alive()) clear(box).append(errorBox(err, () => { clear(ctx.el); insights(ctx); }));
  }
}
