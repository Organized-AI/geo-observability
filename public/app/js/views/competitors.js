// Competitors: your brand and the brands you're compared against, with aliases and domains for matching.
import { h, badge, empty, toast, field, csv, icon, dialog } from "../dom.js";
import { api } from "../api.js";
import { reveal } from "../anim.js";
import { pageHead, needProject, load, brandsFor, dropBrands } from "./common.js";

async function editBrand(ctx, brand) {
  const name = h("input", { class: "input", required: true, maxlength: 80, value: brand ? brand.name : "" });
  const aliases = h("input", { class: "input", value: brand ? (brand.aliases || []).join(", ") : "", placeholder: "Other names, product names, common misspellings" });
  const domains = h("input", { class: "input", value: brand ? (brand.domains || []).join(", ") : "", placeholder: "example.com, example.co.uk" });
  const ok = await dialog({
    title: brand ? `Edit ${brand.name}` : "Add a competitor",
    body: [field("Name", name), field("Aliases", aliases, "Comma separated. Used to spot the brand in answers."), field("Domains", domains, "Comma separated. Used to attribute citations.")],
    actions: [["cancel", "Cancel"], ["ok", brand ? "Save" : "Add competitor", "primary"]], onOpen: () => name.focus(),
  });
  if (!ok) return false;
  const body = { name: name.value.trim(), aliases: csv(aliases.value), domains: csv(domains.value).map((d) => d.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase()) };
  try {
    if (brand) await api(`projects/${ctx.pid}/brands/${encodeURIComponent(brand.id)}`, { method: "PATCH", body });
    else await api(`projects/${ctx.pid}/brands`, { method: "POST", body: { ...body, is_own: false } });
    toast(brand ? "Brand updated" : "Competitor added", "ok");
    dropBrands(ctx.pid);
    return true;
  } catch { return false; }
}

function brandCard(ctx, b, refresh) {
  const act = async (body, msg) => {
    try { await api(`projects/${ctx.pid}/brands/${encodeURIComponent(b.id)}`, { method: "PATCH", body }); toast(msg, "ok"); dropBrands(ctx.pid); refresh(); } catch { /* toast shown */ }
  };
  const remove = async () => {
    const ok = await dialog({ title: `Remove ${b.name}?`, body: h("p", null, "It stops being tracked in new answers. Past results keep their history."), actions: [["cancel", "Keep"], ["ok", "Remove", "danger"]] });
    if (!ok) return;
    try { await api(`projects/${ctx.pid}/brands/${encodeURIComponent(b.id)}`, { method: "DELETE" }); toast("Brand removed", "ok"); dropBrands(ctx.pid); refresh(); } catch { /* toast shown */ }
  };
  const chipsOf = (arr, label) => (arr && arr.length ? h("div", { class: "kv" }, h("span", { class: "muted small" }, label), h("div", { class: "chips" }, arr.map((a) => h("span", { class: "chip chip-static" }, a)))) : null);
  return h("article", { class: ["brand-card", b.is_own && "is-own"] },
    h("header", { class: "brand-head" }, h("h3", null, b.name), b.is_own ? badge("Your brand", "accent") : b.status === "suggested" ? badge("Suggested", "warn") : null),
    chipsOf(b.aliases, "Aliases"), chipsOf(b.domains, "Domains"),
    !(b.aliases || []).length && !(b.domains || []).length ? h("p", { class: "muted small" }, "No aliases or domains yet. Adding them improves matching.") : null,
    h("div", { class: "row-actions", "data-write": "" },
      b.status === "suggested"
        ? [h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => act({ status: "active" }, `${b.name} is now tracked`) }, "Track"),
          h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => act({ status: "rejected" }, "Suggestion dismissed") }, "Dismiss")]
        : [h("button", { type: "button", class: "btn btn-sm", onclick: async () => { if (await editBrand(ctx, b)) refresh(); } }, "Edit"),
          b.is_own ? null : h("button", { type: "button", class: "btn btn-sm btn-ghost btn-danger", onclick: remove }, "Remove")]));
}

// Reused by the setup wizard.
export function brandsManager(ctx, box, opts = {}) {
  const refresh = () => load(box, () => brandsFor(ctx.pid, true), (rows) => {
    const own = rows.filter((b) => b.is_own);
    const active = rows.filter((b) => !b.is_own && b.status !== "suggested" && b.status !== "rejected");
    const sugg = rows.filter((b) => !b.is_own && b.status === "suggested");
    const addBtn = h("button", { type: "button", class: "btn btn-primary", "data-write": "", onclick: async () => { if (await editBrand(ctx, null)) refresh(); } }, icon("plus"), "Add competitor");
    box.append(h("div", { class: "toolbar" }, h("p", { class: "muted" }, `${active.length} competitor${active.length === 1 ? "" : "s"} tracked`), addBtn));
    const grid = (list) => h("div", { class: "brand-grid" }, list.map((b) => brandCard(ctx, b, refresh)));
    if (own.length) box.append(h("h2", { class: "section-label" }, "Your brand"), grid(own));
    if (sugg.length) box.append(h("h2", { class: "section-label" }, `Suggested (${sugg.length})`), h("p", { class: "muted small" }, "Brands assistants often name alongside you. Track the ones that matter."), grid(sugg));
    box.append(h("h2", { class: "section-label" }, "Competitors"), active.length ? grid(active) : empty("No competitors yet", "Add the brands you lose deals to. Share of voice and win rate compare you against them."));
    reveal(Array.from(box.querySelectorAll(".brand-card")), { stagger: 0.03 });
    if (opts.onChange) opts.onChange(rows);
  }, 6);
  refresh();
  return refresh;
}

export default async function competitors(ctx) {
  if (needProject(ctx)) return;
  ctx.el.append(pageHead("Competitors", "The brands you're measured against. Aliases and domains decide how mentions and citations are matched."));
  const box = h("div", { class: "stack" });
  ctx.el.append(box);
  brandsManager(ctx, box);
}

