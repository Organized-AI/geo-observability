// Usage & API: this month's answers and model spend, plus API keys.
import { h, fmt, table, badge, empty, toast, field, dialog, copyBtn, icon, card } from "../dom.js";
import { api, openBilling } from "../api.js";
import { countUp } from "../anim.js";
import { bars } from "../charts.js";
import { pageHead, load } from "./common.js";

function usagePanel(ctx, box) {
  return load(box, () => api("usage"), (u) => {
    const spend = u.llm_cost_micros || 0, cap = u.spend_cap_micros || 0;
    const ratio = cap ? Math.min(1, spend / cap) : 0;
    const answers = h("span", { class: "kpi-value num" }, fmt.int(u.answers_run));
    const cost = h("span", { class: "kpi-value num" }, fmt.money(spend));
    requestAnimationFrame(() => { countUp(answers, u.answers_run, fmt.int); countUp(cost, spend, fmt.money); });
    const bar = h("div", { class: ["progress", ratio >= 0.9 ? "is-neg" : ratio >= 0.75 ? "is-warn" : ""], role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(ratio * 100), "aria-label": "Model spend against monthly cap" }, h("span", { style: { width: `${ratio * 100}%` } }));
    box.append(h("div", { class: "kpis kpis-compact" },
      h("div", { class: "kpi" }, h("p", { class: "kpi-label" }, `Answers run · ${u.month || "this month"}`), answers),
      h("div", { class: "kpi kpi-wide" }, h("p", { class: "kpi-label" }, "Model spend"), cost,
        cap ? [bar, h("p", { class: "kpi-help" }, `${fmt.pct(ratio)} of the ${fmt.money(cap)} monthly cap`)] : h("p", { class: "kpi-help" }, "No spend cap set"))));
    const rows = u.by_engine || [];
    if (rows.length) {
      box.append(h("h3", { class: "sub-title" }, "By engine"), table([
        { label: "Engine", render: (r) => ctx.engineLabel(r.engine) },
        { label: "Answers", num: true, render: (r) => fmt.int(r.answers) },
        { label: "Model cost", num: true, render: (r) => fmt.money(r.cost_micros) },
      ], rows, { label: "Usage by engine" }));
      box.append(bars(rows.map((r) => ({ label: ctx.engineLabel(r.engine), value: r.answers })), { format: fmt.int }));
    }
  }, 4);
}

const STATUS = {
  active: ["Active", "ok"], trialing: ["Trial", "accent"], past_due: ["Payment failed", "warn"],
  unpaid: ["Unpaid", "neg"], canceled: ["Ended", "neg"], incomplete: ["No card yet", "warn"],
};
const METER_LABEL = { answers_run: "Answers run", llm_cost_micros: "Model spend", browser_minutes: "Browser minutes", extra_engines: "Extra engines" };
const PUSH_LABEL = { pending: "Waiting to send", pushed: "Sent to Stripe", skipped: "Not billed", failed: "Couldn't send" };

function billingPanel(ctx, box) {
  return load(box, () => api("billing"), (b) => {
    if (b.provider !== "stripe") {
      box.append(h("p", { class: "muted" }, b.enabled
        ? "This workspace isn't billed by card. Usage is tracked for reporting."
        : "Card billing isn't switched on. Usage is tracked for reporting."));
      return;
    }
    const [label, tone] = STATUS[b.status] || [b.status, "accent"];
    const facts = [h("div", { class: "kpi" }, h("p", { class: "kpi-label" }, "Status"), h("p", null, badge(label, tone)))];
    if (b.current_period_end) facts.push(h("div", { class: "kpi" }, h("p", { class: "kpi-label" }, b.cancel_at_period_end ? "Ends on" : "Renews on"), h("p", { class: "num" }, fmt.dateLong(b.current_period_end))));
    if (b.status === "past_due" && b.grace_until) facts.push(h("div", { class: "kpi" }, h("p", { class: "kpi-label" }, "Runs pause after"), h("p", { class: "num" }, fmt.dateLong(b.grace_until))));
    box.append(h("div", { class: "kpis kpis-compact" }, facts));
    if (b.can_manage) {
      const needsCheckout = b.status === "incomplete" || b.status === "canceled";
      box.append(h("div", { class: "row" },
        h("button", { type: "button", class: "btn btn-primary", onclick: (e) => openBilling(needsCheckout ? "checkout" : "portal", e.currentTarget) }, needsCheckout ? "Add a card" : "Manage billing"),
        h("span", { class: "muted small" }, needsCheckout ? "Opens Stripe Checkout." : "Opens Stripe to change your card, see invoices or cancel.")));
    } else box.append(h("p", { class: "muted small" }, "Only workspace owners can change billing."));
    const rows = (b.pushes || []).map((p) => ({ ...p, meterLabel: METER_LABEL[p.meter] || p.meter }));
    if (rows.length) {
      box.append(h("h3", { class: "sub-title" }, `Usage sent to Stripe · ${b.month}`), table([
        { label: "Meter", key: "meterLabel" },
        { label: "Status", render: (r) => badge(PUSH_LABEL[r.state] || r.state, r.state === "pushed" ? "ok" : r.state === "failed" ? "neg" : r.state === "pending" ? "accent" : "warn") },
        { label: "Amount", num: true, render: (r) => (r.meter === "llm_cost_micros" ? fmt.money(r.quantity) : fmt.int(r.quantity)) },
      ], rows, { label: "Usage sent to Stripe" }));
      box.append(h("p", { class: "muted small" }, "Usage is totalled per hour and sent to Stripe about 20 minutes after each hour ends."));
    }
  }, 3);
}

const PROVIDER = { cloudflare: "Cloudflare Email Service", resend: "Resend", outbox: "Development outbox", none: "Not set up" };

function emailPanel(ctx, box) {
  return load(box, () => api("email/status", { quiet: true }), (e) => {
    box.append(h("div", { class: "kpis kpis-compact" },
      h("div", { class: "kpi" }, h("p", { class: "kpi-label" }, "Sends with"), h("p", null, badge(PROVIDER[e.provider] || e.provider, e.provider === "none" ? "neg" : "ok"))),
      h("div", { class: "kpi" }, h("p", { class: "kpi-label" }, "From"), h("p", null, e.from || "EMAIL_FROM not set"))));
    const last = (e.recent || [])[0];
    if (last && last.status === "failed") box.append(h("div", { class: "banner banner-warn", role: "status" }, icon("alert"), h("span", null, `Last send failed: ${last.reason} (${last.code || "unknown"})`)));
    else if (last) box.append(h("p", { class: "muted small" }, `Last send went out ${fmt.dateLong(last.created_at)}.`));
    const btn = h("button", { type: "button", class: "btn", onclick: async () => {
      btn.disabled = true;
      try { const r = await api("email/test", { method: "POST" }); toast(`Test email sent to ${r.to}. Check your inbox and spam folder.`, "ok"); }
      catch { /* the error toast carries the reason */ }
      finally { btn.disabled = false; box.textContent = ""; emailPanel(ctx, box); }
    } }, "Send me a test email");
    box.append(h("div", { class: "row" }, btn, h("span", { class: "muted small" }, "Sign-in links go out the same way.")));
  }, 2);
}

function keysPanel(ctx, box) {
  const refresh = () => load(box, () => api("keys"), (rows) => {
    rows = Array.isArray(rows) ? rows : [];
    const createBtn = h("button", { type: "button", class: "btn btn-primary", "data-write": "", onclick: async () => {
      const name = h("input", { class: "input", required: true, maxlength: 60, placeholder: "e.g. Looker Studio connector" });
      const scope = h("select", { class: "select" }, h("option", { value: "read" }, "Read: reports, public API and MCP"), h("option", { value: "ingest" }, "Ingest: tap.js, edge worker and conversions"));
      const ok = await dialog({ title: "Create an API key", body: [field("Name", name), field("Scope", scope)], actions: [["cancel", "Cancel"], ["ok", "Create key", "primary"]], onOpen: () => name.focus() });
      if (!ok) return;
      try {
        const r = await api("keys", { method: "POST", body: { name: name.value.trim(), scope: scope.value } });
        const secret = h("input", { class: "input mono", readonly: true, value: r.secret || "", onfocus: (e) => e.target.select() });
        await dialog({ title: "Copy your new key now", body: [h("p", { class: "notice notice-warn" }, icon("alert"), h("span", null, "This is the only time the full key is shown. Store it somewhere safe.")), field("Secret", secret), h("div", { class: "row" }, copyBtn(() => secret.value, "Copy key"))], actions: [["ok", "I've stored it", "primary"]], onOpen: () => secret.select() });
        refresh();
      } catch { /* toast shown */ }
    } }, icon("plus"), "Create key");
    box.append(h("div", { class: "card-toolbar" }, h("span", { class: "muted small" }, "Use read keys with the public API and MCP server, and ingest keys for site tracking."), createBtn));
    if (!rows.length) { box.append(empty("No API keys yet", ctx.readOnly ? null : "Create a read key to pull reports into your own tools.")); return; }
    box.append(table([
      { label: "Name", key: "name" },
      { label: "Key", render: (k) => h("span", { class: "mono" }, `${k.prefix || ""}…`) },
      { label: "Scope", render: (k) => badge(fmt.label(k.scope), k.scope === "ingest" ? "warn" : "accent") },
      { label: "Created", render: (k) => fmt.dateLong(k.created_at) },
      { label: "Last used", render: (k) => (k.last_used_at ? fmt.dateLong(k.last_used_at) : "Never") },
      { label: "", render: (k) => h("button", { type: "button", class: "btn btn-sm btn-ghost btn-danger", "data-write": "", onclick: async () => {
        const ok = await dialog({ title: `Revoke "${k.name}"?`, body: h("p", null, "Anything using this key stops working straight away. This can't be undone."), actions: [["cancel", "Keep key"], ["ok", "Revoke", "danger"]] });
        if (!ok) return;
        try { await api(`keys/${encodeURIComponent(k.id)}`, { method: "DELETE" }); toast("Key revoked", "ok"); refresh(); } catch { /* toast shown */ }
      } }, "Revoke") },
    ], rows, { label: "API keys" }));
  }, 4);
  refresh();
}

export default async function usage(ctx) {
  ctx.el.append(pageHead("Usage & API", "Answers run and model spend this month, billing, and keys for the API, MCP server and tracking."));
  const u = card("This month", {});
  const bl = card("Billing", {});
  const k = card("API keys", { class: "card-flush" });
  const owner = ctx.me && !ctx.me.demo && ctx.me.tenant && (ctx.me.tenant.role === "owner" || (ctx.me.user && ctx.me.user.is_agency));
  const em = owner ? card("Sign-in email", {}) : null;
  ctx.el.append(h("div", { class: "stack" }, u, bl, em, k,
    card("Using the API", {}, h("p", null, "Read keys work with the REST API under ", h("code", null, "/api/v1"), " and the MCP server at ", h("code", null, "/mcp"), ". Send the key in the ", h("code", null, "X-API-Key"), " header for REST, or as a bearer token for MCP."),
      h("p", { class: "muted small" }, "Full reference: ", h("a", { href: "/docs/" }, "documentation"), "."))));
  usagePanel(ctx, u.querySelector(".card-body"));
  billingPanel(ctx, bl.querySelector(".card-body"));
  if (em) emailPanel(ctx, em.querySelector(".card-body"));
  keysPanel(ctx, k.querySelector(".card-body"));
}
