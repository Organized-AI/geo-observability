// Perception: how assistants describe you — attributes, objections, and fact checks.
import { h, clear, fmt, table, skeleton, errorBox, empty, card } from "../dom.js";
import { api } from "../api.js";
import { staggerRows } from "../anim.js";
import { bars } from "../charts.js";
import { pageHead, needProject, verdictBadge } from "./common.js";

export default async function perception(ctx) {
  if (needProject(ctx)) return;
  ctx.el.append(pageHead("Perception", "The words assistants attach to you, the doubts they raise, and whether what they say is true."));
  const box = h("div", { class: "stack" }, skeleton(6, "block"));
  ctx.el.append(box);
  try {
    const r = await api(`projects/${ctx.pid}/perception`, { query: ctx.fq() });
    if (!ctx.alive()) return;
    clear(box);
    const attrs = ((r && r.attributes) || []).slice().sort((a, b) => b.count - a.count).slice(0, 15);
    const objs = ((r && r.objections) || []).slice().sort((a, b) => b.count - a.count).slice(0, 15);
    const facts = ((r && r.facts) || []).slice().sort((a, b) => b.count - a.count);
    if (!attrs.length && !objs.length && !facts.length) { box.append(empty("No perception data yet", "This builds up as answers that name you are analysed.")); return; }
    box.append(h("div", { class: "grid-2" },
      card("Attributes", {}, h("p", { class: "muted small" }, "Qualities assistants associate with you, by how often they come up."),
        attrs.length ? bars(attrs.map((a) => ({ label: a.text, value: a.count })), { color: "var(--series-3)" }) : empty("None yet")),
      card("Objections", {}, h("p", { class: "muted small" }, "Concerns or drawbacks assistants mention about you."),
        objs.length ? bars(objs.map((a) => ({ label: a.text, value: a.count })), { color: "var(--series-2)" }) : empty("None yet", "No recurring objections. Good sign."))));
    const factCard = card("Facts", { class: "card-flush" });
    const fb = factCard.querySelector(".card-body");
    if (facts.length) {
      const t = table([
        { label: "Claim", class: "col-wide", render: (f) => f.claim },
        { label: "Verdict", render: (f) => verdictBadge(f.verdict) },
        { label: "Seen", num: true, render: (f) => fmt.int(f.count) },
      ], facts, { label: "Fact checks" });
      fb.append(h("p", { class: "muted small pad" }, "Claims about you checked against your profile facts. Fix contradicted ones at the source."), t);
      staggerRows(t.querySelector("tbody"));
    } else fb.append(empty("No claims checked yet", "Add facts to your profile in Setup so claims can be checked."));
    box.append(factCard);
  } catch (err) {
    if (ctx.alive()) clear(box).append(errorBox(err, () => { clear(ctx.el); perception(ctx); }));
  }
}
