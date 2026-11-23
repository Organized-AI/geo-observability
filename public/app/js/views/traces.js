// Traces: runs of the client's own LLM apps, sent over OTLP. A list with filters, sessions, and a trace page
// with the span tree, a timeline and the detail of each span.
import { h, clear, fmt, plural, isNumber, badge, segmented, tabs, table, skeleton, errorBox, empty, drawer, copyBtn, icon } from "../dom.js";
import { api } from "../api.js";
import { reveal } from "../anim.js";
import { pageHead } from "./common.js";

const KIND_LABEL = { LLM: "LLM", CHAIN: "Chain", AGENT: "Agent", TOOL: "Tool", RETRIEVER: "Retriever", EMBEDDING: "Embedding", RERANKER: "Reranker", GUARDRAIL: "Guardrail", EVALUATOR: "Evaluator", PROMPT: "Prompt", DECISION: "Decision", UNKNOWN: "Span" };

export const dur = (ms) => {
  if (!isNumber(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
const when = (ms) => (isNumber(ms) ? new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "–");
const whenLong = (ms) => (isNumber(ms) ? new Date(ms).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }) : "–");
const kindBadge = (kind) => h("span", { class: `kind kind-${KIND_LABEL[kind] ? kind : "UNKNOWN"}` }, KIND_LABEL[kind] || "Span");
const statusBadge = (status) => (status === "ERROR" ? badge("Error", "neg") : status === "OK" ? badge("OK", "ok") : badge("No status"));
const cost = (micros) => (isNumber(micros) && micros > 0 ? fmt.money(micros) : "–");
const tokens = (n) => (isNumber(n) && n > 0 ? fmt.int(n) : "–");

function hashFor(ctx, parts, patch = {}) {
  const q = new URLSearchParams(ctx.q);
  q.delete("span");
  for (const [k, v] of Object.entries(patch)) { if (v == null || v === "") q.delete(k); else q.set(k, v); }
  const s = q.toString();
  return `#/${parts.map(encodeURIComponent).join("/")}${s ? `?${s}` : ""}`;
}

export default async function traces(ctx) {
  if (ctx.parts[1]) return tracePage(ctx, ctx.parts[1]);
  return traceList(ctx);
}

// ---------------------------------------------------------------- setup panel

function codeBlock(title, text) {
  return h("div", { class: "code-block" }, h("div", { class: "code-head" }, h("span", { class: "small muted" }, title), copyBtn(() => text)), h("pre", null, h("code", null, text)));
}

function openSetup() {
  drawer("Send traces", async (body) => {
    body.append(skeleton(6));
    try {
      const s = await api("tracing/setup");
      clear(body).append(h("div", { class: "tr-setup" },
        h("p", null, "Traces arrive over OpenTelemetry (OTLP over HTTP). Any app that already exports OpenTelemetry traces can send them here by changing three settings."),
        h("h3", { class: "section-label" }, "1. Make an ingest key"),
        h("p", null, "Under ", h("a", { href: "#/usage" }, "Usage & API"), ", create a key with the ", h("strong", null, "ingest"), " scope. It is shown once."),
        h("h3", { class: "section-label" }, "2. Point your exporter here"),
        codeBlock("Environment", `OTEL_EXPORTER_OTLP_ENDPOINT=${s.endpoint}\nOTEL_EXPORTER_OTLP_HEADERS=${s.key_header}=YOUR_INGEST_KEY\nOTEL_SERVICE_NAME=my-app`),
        h("p", { class: "small muted" }, `The service name becomes the app name in this list. Send a ${s.app_header} header to override it.`),
        h("h3", { class: "section-label" }, "3. Describe your LLM calls"),
        h("p", null, "Spans that carry OpenInference attributes (or OpenTelemetry's gen_ai attributes) show their model, messages, tool calls, tokens and cost. In Python:"),
        codeBlock("Python", `from opentelemetry import trace\nfrom opentelemetry.sdk.trace import TracerProvider\nfrom opentelemetry.sdk.trace.export import BatchSpanProcessor\nfrom opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter\nfrom openinference.instrumentation.openai import OpenAIInstrumentor\n\nprovider = TracerProvider()\nprovider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(\n    endpoint="${s.traces_url}",\n    headers={"${s.key_header}": "YOUR_INGEST_KEY"},\n)))\ntrace.set_tracer_provider(provider)\nOpenAIInstrumentor().instrument()`),
        h("h3", { class: "section-label" }, "Check it with one request"),
        codeBlock("curl", `curl -X POST ${s.traces_url} \\\n  -H "content-type: application/json" \\\n  -H "${s.key_header}: YOUR_INGEST_KEY" \\\n  -d '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"my-app"}}]},"scopeSpans":[{"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","name":"hello","startTimeUnixNano":"${Date.now()}000000","endTimeUnixNano":"${Date.now() + 250}000000","attributes":[{"key":"openinference.span.kind","value":{"stringValue":"LLM"}},{"key":"input.value","value":{"stringValue":"Hello"}},{"key":"output.value","value":{"stringValue":"Hi there"}}]}]}]}]}'`),
        h("p", { class: "small muted" }, `Limits: ${s.limits.body_mb} MB and ${fmt.int(s.limits.spans_per_request)} spans per request, ${fmt.int(s.limits.requests_per_minute)} requests a minute per key, ${s.limits.apps} apps per workspace. Very long values are cut and marked.`)));
    } catch (err) {
      clear(body).append(errorBox(err, () => openSetup()));
    }
  });
}

// ---------------------------------------------------------------- list

function statTiles(t) {
  const rate = t.traces ? t.errors / t.traces : null;
  const tile = (label, value, note) => h("div", { class: "kpi" }, h("span", { class: "kpi-label" }, label), h("span", { class: "kpi-value num" }, value), note ? h("span", { class: "kpi-help" }, note) : null);
  return h("div", { class: "kpis kpis-compact tr-kpis" },
    tile("Traces", fmt.int(t.traces)),
    tile("Errors", fmt.int(t.errors), rate == null ? null : `${(rate * 100).toFixed(1)}% of traces`),
    tile("Average latency", t.traces ? dur(t.avg_latency_ms) : "–"),
    tile("Tokens", tokens(t.total_tokens)),
    tile("Cost", cost(t.cost_micros), t.cost_micros ? "as reported by your apps" : null));
}

async function traceList(ctx) {
  const tab = ctx.q.get("tab") === "sessions" ? "sessions" : "traces";
  const app = ctx.q.get("app") || "";
  const st = ctx.q.get("st") === "error" ? "error" : "";
  const search = ctx.q.get("q") || "";
  const session = ctx.q.get("session") || "";
  const sendBtn = h("button", { type: "button", class: "btn", onclick: openSetup }, icon("plus"), "Send traces");
  ctx.el.append(pageHead("Traces", "Every run of your LLM apps: the model calls, tools and retrievals behind each answer.", sendBtn));

  const box = h("div", null, skeleton(6));
  ctx.el.append(box);
  let apps;
  try { apps = await api("tracing/apps"); }
  catch (err) { clear(box).append(errorBox(err, () => ctx.setQuery({}))); return; }
  if (!ctx.alive()) return;
  if (!apps.length) {
    clear(box).append(empty("No traces yet", "Point an OpenTelemetry exporter at this workspace and your app's runs appear here within seconds.",
      h("button", { type: "button", class: "btn btn-primary", onclick: openSetup }, "See how to send traces")));
    return;
  }

  const appSel = h("select", { class: "select select-sm", "aria-label": "App", onchange: (e) => ctx.setQuery({ app: e.target.value || null }) },
    h("option", { value: "" }, "All apps"), apps.map((a) => h("option", { value: a.id, selected: a.id === app }, `${a.name} (${fmt.int(a.trace_count)})`)));
  const searchIn = h("input", { type: "search", class: "input input-sm tr-search", placeholder: "Search name, input or output", value: search, "aria-label": "Search traces" });
  const form = h("form", { class: "tr-searchform", role: "search", onsubmit: (e) => { e.preventDefault(); ctx.setQuery({ q: searchIn.value.trim() || null }); } }, searchIn, h("button", { type: "submit", class: "btn btn-sm" }, "Search"));
  const controls = h("div", { class: "tr-controls" }, appSel);
  if (tab === "traces") controls.append(segmented([["", "All"], ["error", "Errors"]], st, (id) => ctx.setQuery({ st: id || null }), "Status"), form);

  clear(box).append(
    h("div", { class: "toolbar" }, tabs([["traces", "Traces"], ["sessions", "Sessions"]], tab, (id) => ctx.setQuery({ tab: id === "sessions" ? "sessions" : null, session: null })), controls));
  if (session && tab === "traces") {
    box.append(h("p", { class: "notice" }, icon("info"), h("span", null, "Showing the conversation ", h("strong", { class: "mono" }, session), ", newest turn first."),
      h("button", { type: "button", class: "btn btn-sm", onclick: () => ctx.setQuery({ session: null }) }, "Show all traces")));
  }
  const body = h("div", null, skeleton(8));
  box.append(body);
  if (tab === "sessions") return sessionList(ctx, body, app);

  const stats = h("div");
  const card = h("section", { class: "card card-flush", "aria-label": "Traces" });
  const more = h("div", { class: "load-more" });
  const rows = [];
  let cursor = null;
  const columns = [
    { label: "Started", class: "hide-sm", render: (t) => h("span", { class: "nowrap" }, when(t.start_ms)) },
    { label: "Trace", render: (t) => h("div", { class: "tr-name" },
        h("a", { href: hashFor(ctx, ["traces", t.trace_id]), class: "tr-link" }, t.name),
        h("span", { class: "small muted show-sm" }, when(t.start_ms)),
        h("span", { class: "tr-name-meta" }, kindBadge(t.kind), t.status === "ERROR" ? badge("Error", "neg") : null, app ? null : h("span", { class: "small muted" }, t.app))) },
    { label: "Input", class: "tr-preview", render: (t) => h("span", { class: "clamp-2" }, t.input_preview || h("span", { class: "muted" }, "–")) },
    { label: "Output", class: "tr-preview hide-sm", render: (t) => h("span", { class: "clamp-2" }, t.output_preview || h("span", { class: "muted" }, "–")) },
    { label: "Latency", num: true, render: (t) => dur(t.latency_ms) },
    { label: "Tokens", num: true, class: "hide-sm", render: (t) => tokens(t.total_tokens) },
    { label: "Cost", num: true, class: "hide-sm", render: (t) => cost(t.cost_micros) },
    { label: "Spans", num: true, class: "hide-sm", render: (t) => fmt.int(t.span_count) },
  ];
  const draw = () => {
    clear(card).append(table(columns, rows, { label: "Traces", rowAttrs: (t) => (t.status === "ERROR" ? { class: "is-error" } : null) }));
  };
  const page = async (first) => {
    try {
      const r = await api("tracing/traces", { query: { from: ctx.f.from, to: ctx.f.to, app, status: st, q: search, session, limit: 50, cursor: cursor || "" } });
      if (!ctx.alive()) return;
      if (first) {
        clear(body);
        if (!r.items.length) {
          body.append(empty(st ? "No failed traces in this range" : "No traces in this range", "Try a wider date range or fewer filters."));
          return;
        }
        if (r.totals) stats.append(statTiles(r.totals));
        body.append(stats, card, more);
      }
      rows.push(...r.items);
      draw();
      if (first) reveal([...card.querySelectorAll("tbody tr")].slice(0, 30), { y: 6, stagger: 0.015 });
      cursor = r.next_cursor;
      clear(more);
      if (cursor) more.append(h("button", { type: "button", class: "btn", onclick: (e) => { e.target.disabled = true; page(false); } }, "Load more"));
    } catch (err) {
      if (first) clear(body).append(errorBox(err, () => { clear(body).append(skeleton(8)); page(true); }));
      else clear(more).append(errorBox(err, () => page(false)));
    }
  };
  await page(true);
}

async function sessionList(ctx, body, app) {
  try {
    const list = await api("tracing/sessions", { query: { from: ctx.f.from, to: ctx.f.to, app, limit: 100 } });
    if (!ctx.alive()) return;
    clear(body);
    if (!list.length) {
      body.append(empty("No conversations in this range", "Traces are grouped into a conversation when your app sets a session.id attribute on its spans."));
      return;
    }
    body.append(h("section", { class: "card card-flush", "aria-label": "Sessions" }, table([
      { label: "Last active", class: "hide-sm", render: (s) => h("span", { class: "nowrap" }, when(s.end_ms)) },
      { label: "Conversation", render: (s) => h("div", { class: "tr-name" },
          h("a", { href: hashFor(ctx, ["traces"], { tab: null, session: s.session_id }), class: "tr-link mono" }, s.session_id),
          h("span", { class: "small muted show-sm" }, when(s.end_ms)),
          h("span", { class: "tr-name-meta" }, h("span", { class: "small muted" }, plural(s.traces, "turn")), s.errors ? badge(plural(s.errors, "error"), "neg") : null, s.user_id ? h("span", { class: "small muted" }, s.user_id) : null)) },
      { label: "First message", class: "tr-preview", render: (s) => h("span", { class: "clamp-2" }, s.first_input || h("span", { class: "muted" }, "–")) },
      { label: "Last answer", class: "tr-preview hide-sm", render: (s) => h("span", { class: "clamp-2" }, s.last_output || h("span", { class: "muted" }, "–")) },
      { label: "Tokens", num: true, class: "hide-sm", render: (s) => tokens(s.total_tokens) },
      { label: "Cost", num: true, class: "hide-sm", render: (s) => cost(s.cost_micros) },
    ], list, { label: "Sessions" })));
  } catch (err) {
    clear(body).append(errorBox(err, () => { clear(body).append(skeleton(8)); sessionList(ctx, body, app); }));
  }
}

// ---------------------------------------------------------------- trace page

/** Spans in tree order with a depth. A span whose parent never arrived is shown at the top level. */
export function treeOrder(spans) {
  const ids = new Set(spans.map((s) => s.span_id));
  const kids = new Map();
  const roots = [];
  for (const s of spans) {
    if (s.parent_span_id && ids.has(s.parent_span_id) && s.parent_span_id !== s.span_id) {
      if (!kids.has(s.parent_span_id)) kids.set(s.parent_span_id, []);
      kids.get(s.parent_span_id).push(s);
    } else roots.push(s);
  }
  const out = [];
  const seen = new Set();
  const walk = (s, depth) => {
    if (seen.has(s.span_id)) return; // a cycle in parent ids would otherwise never end
    seen.add(s.span_id);
    out.push({ span: s, depth, orphan: depth === 0 && !!s.parent_span_id });
    for (const k of kids.get(s.span_id) || []) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  for (const s of spans) if (!seen.has(s.span_id)) walk(s, 0);
  return out;
}

function pretty(text) {
  if (typeof text !== "string") return text == null ? "" : JSON.stringify(text, null, 2);
  const t = text.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try { return JSON.stringify(JSON.parse(t), null, 2); } catch { /* not JSON after all */ }
  }
  return text;
}
const textBlock = (text) => h("pre", { class: "tr-text" }, pretty(text));

function messageList(list) {
  return h("ol", { class: "tr-msgs" }, list.map((m) => h("li", { class: `tr-msg tr-msg-${String(m.role).replace(/[^a-z]/gi, "")}` },
    h("span", { class: "tr-role" }, m.role, m.name ? ` · ${m.name}` : ""),
    m.content ? textBlock(m.content) : null,
    (m.tool_calls || []).map((t) => h("div", { class: "tr-toolcall" }, h("span", { class: "small" }, h("span", { class: "muted" }, "Calls tool "), h("strong", { class: "mono" }, t.name || "tool")), t.arguments ? textBlock(t.arguments) : null)))));
}

function spanDetail(trace, d) {
  const box = h("div", { class: "tr-detail-body" });
  const meta = [
    ["Duration", dur(d.end_ms - d.start_ms)],
    ["Starts at", `+${dur(d.start_ms - trace.start_ms)}`],
    d.model ? ["Model", d.model] : null,
    d.provider ? ["Provider", d.provider] : null,
    isNumber(d.total_tokens) ? ["Tokens", `${tokens(d.total_tokens)}${isNumber(d.prompt_tokens) && isNumber(d.completion_tokens) ? ` (${fmt.int(d.prompt_tokens)} in, ${fmt.int(d.completion_tokens)} out)` : ""}`] : null,
    isNumber(d.cost_micros) ? ["Cost", cost(d.cost_micros)] : null,
  ].filter(Boolean);
  box.append(
    h("div", { class: "tr-detail-head" }, h("h2", { class: "tr-detail-title" }, d.name), h("div", { class: "chat-meta wrap" }, kindBadge(d.kind), statusBadge(d.status_code))),
    h("dl", { class: "tr-meta" }, meta.map(([k, v]) => h("div", null, h("dt", null, k), h("dd", { class: "num" }, v)))));
  if (d.status_code === "ERROR") box.append(h("p", { class: "notice notice-warn" }, icon("alert"), h("span", null, d.status_message || "This span failed without an error message.")));
  if (d.truncated) box.append(h("p", { class: "notice" }, icon("info"), h("span", null, "Some values on this span were longer than the storage limit and were cut.")));

  const attrKeys = Object.keys(d.attributes || {}).sort();
  const events = d.events || [];
  const panel = h("div", { class: "tr-panel" });
  const show = (id) => {
    tabBar.querySelectorAll(".tab").forEach((b, i) => b.setAttribute("aria-selected", ["overview", "attributes", "events"][i] === id ? "true" : "false"));
    clear(panel);
    if (id === "overview") {
      const ins = d.input_messages || [], outs = d.output_messages || [];
      if (ins.length) panel.append(h("h3", { class: "section-label" }, "Messages in"), messageList(ins));
      else if (d.input_text) panel.append(h("h3", { class: "section-label" }, "Input"), textBlock(d.input_text));
      if ((d.tools || []).length) panel.append(h("h3", { class: "section-label" }, "Tools offered"),
        h("ul", { class: "plain-list" }, d.tools.map((t) => h("li", null, h("strong", { class: "mono" }, t.name || "tool"), t.description ? h("span", { class: "muted" }, ` · ${t.description}`) : null))));
      if ((d.documents || []).length) panel.append(h("h3", { class: "section-label" }, `Documents retrieved (${d.documents.length})`),
        h("ol", { class: "tr-docs" }, d.documents.map((doc) => h("li", null,
          h("div", { class: "chat-meta" }, doc.id ? h("span", { class: "badge mono" }, doc.id) : null, isNumber(doc.score) ? h("span", { class: "small muted num" }, `score ${doc.score.toFixed(2)}`) : null),
          doc.content ? h("p", null, doc.content) : null))));
      if (outs.length) panel.append(h("h3", { class: "section-label" }, "Messages out"), messageList(outs));
      else if (d.output_text) panel.append(h("h3", { class: "section-label" }, "Output"), textBlock(d.output_text));
      if (!panel.childNodes.length) panel.append(h("p", { class: "muted" }, "This span carries no input or output. Its attributes may still say what it did."));
    } else if (id === "attributes") {
      if (!attrKeys.length) panel.append(h("p", { class: "muted" }, "No attributes were sent with this span."));
      else panel.append(h("dl", { class: "tr-attrs" }, attrKeys.map((k) => {
        const v = d.attributes[k];
        return h("div", null, h("dt", { class: "mono" }, k), h("dd", { class: "mono" }, typeof v === "string" ? v : JSON.stringify(v)));
      })));
    } else if (!events.length) panel.append(h("p", { class: "muted" }, "No events were recorded on this span."));
    else panel.append(h("ol", { class: "tr-events" }, events.map((e) => h("li", null,
      h("div", { class: "chat-meta" }, h("strong", null, e.name || "event"), h("span", { class: "small muted num" }, `+${dur(e.time_ms - d.start_ms)}`)),
      Object.keys(e.attributes || {}).length ? textBlock(JSON.stringify(e.attributes)) : null))));
  };
  const tabBar = tabs([["overview", "Overview"], ["attributes", `Attributes (${attrKeys.length})`], ["events", `Events (${events.length})`]], "overview", show);
  box.append(tabBar, panel);
  show("overview");
  return box;
}

async function tracePage(ctx, traceId) {
  const back = h("a", { class: "tr-back", href: hashFor(ctx, ["traces"]) }, icon("chev"), "All traces");
  const box = h("div", null, skeleton(8));
  ctx.el.append(back, box);
  let data;
  try { data = await api(`tracing/traces/${encodeURIComponent(traceId)}`); }
  catch (err) {
    clear(box).append(err.status === 404 ? empty("Trace not found", "It may have been deleted, or the link is for another workspace.") : errorBox(err, () => ctx.setQuery({})));
    return;
  }
  if (!ctx.alive()) return;
  const t = data.trace;
  document.title = `${t.name} · Traces · GEO Observability`;
  const total = Math.max(1, t.end_ms - t.start_ms);
  const order = treeOrder(data.spans);
  const detail = h("section", { class: "card tr-detail", "aria-label": "Span detail", "aria-live": "polite" });
  const rowsEl = h("ol", { class: "tr-tree" });
  let selected = null;

  const select = async (spanId, focusDetail) => {
    selected = spanId;
    rowsEl.querySelectorAll(".tr-row").forEach((b) => { if (b.dataset.span === spanId) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current"); });
    const q = new URLSearchParams(ctx.q);
    q.set("span", spanId);
    history.replaceState(null, "", `#/traces/${encodeURIComponent(traceId)}?${q}`);
    clear(detail).append(h("div", { class: "card-body" }, skeleton(6)));
    try {
      const d = await api(`tracing/traces/${encodeURIComponent(traceId)}/spans/${encodeURIComponent(spanId)}`);
      if (selected !== spanId || !ctx.alive()) return;
      clear(detail).append(h("div", { class: "card-body" }, spanDetail(t, d)));
      if (focusDetail && window.matchMedia("(max-width: 960px)").matches) detail.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      if (selected === spanId) clear(detail).append(h("div", { class: "card-body" }, errorBox(err, () => select(spanId))));
    }
  };

  for (const { span: s, depth, orphan } of order) {
    const left = Math.min(99.5, Math.max(0, ((s.start_ms - t.start_ms) / total) * 100));
    const width = Math.max(0.5, Math.min(100 - left, ((s.end_ms - s.start_ms) / total) * 100));
    rowsEl.append(h("li", null, h("button", { type: "button", class: ["tr-row", s.status_code === "ERROR" && "is-error"], "data-span": s.span_id, style: `--depth:${Math.min(depth, 12)}`, onclick: () => select(s.span_id, true) },
      h("span", { class: "tr-row-main" },
        kindBadge(s.kind),
        h("span", { class: "tr-row-name" }, s.name),
        orphan ? h("span", { class: "badge", title: "This span's parent was not received." }, "No parent") : null,
        s.status_code === "ERROR" ? badge("Error", "neg") : null,
        h("span", { class: "tr-row-dur num" }, dur(s.end_ms - s.start_ms))),
      h("span", { class: "tr-track", "aria-hidden": "true" }, h("span", { class: `tr-bar tr-bar-${KIND_LABEL[s.kind] ? s.kind : "UNKNOWN"}`, style: { left: `${left}%`, width: `${width}%` } })))));
  }

  const traceIdText = h("span", { class: "mono small muted tr-id" }, t.trace_id);
  clear(box).append(
    h("header", { class: "page-head tr-head" },
      h("div", null,
        h("h1", null, t.name),
        h("div", { class: "chat-meta wrap" }, kindBadge(t.kind), statusBadge(t.status), h("span", { class: "small muted" }, t.app), h("span", { class: "small muted" }, whenLong(t.start_ms)),
          t.session_id ? h("a", { class: "small", href: hashFor(ctx, ["traces"], { session: t.session_id, tab: null }) }, `Conversation ${t.session_id}`) : null)),
      h("div", { class: "page-actions" }, traceIdText, copyBtn(() => t.trace_id, "Copy trace ID"))),
    h("div", { class: "kpis kpis-compact tr-kpis" },
      [["Latency", dur(t.latency_ms)], ["Spans", fmt.int(t.span_count)], ["Model calls", fmt.int(t.llm_count)], ["Tokens", tokens(t.total_tokens)], ["Cost", cost(t.cost_micros)]]
        .map(([k, v]) => h("div", { class: "kpi" }, h("span", { class: "kpi-label" }, k), h("span", { class: "kpi-value num" }, v)))),
    data.spans_truncated ? h("p", { class: "notice" }, icon("info"), h("span", null, `This trace has more spans than fit on one page. The first ${fmt.int(data.spans.length)} are shown.`)) : "",
    h("div", { class: "tr-split" },
      h("section", { class: "card card-flush tr-treecard", "aria-label": "Spans" },
        h("header", { class: "card-head" }, h("h2", { class: "card-title" }, plural(data.spans.length, "span")), h("span", { class: "small muted num" }, `0 to ${dur(total)}`)), rowsEl),
      detail));

  const wanted = ctx.q.get("span");
  const firstError = order.find((o) => o.span.status_code === "ERROR");
  const start = (wanted && order.find((o) => o.span.span_id === wanted)) || firstError || order[0];
  if (start) select(start.span.span_id, false);
  else clear(detail).append(h("div", { class: "card-body" }, h("p", { class: "muted" }, "This trace has no spans.")));
}
