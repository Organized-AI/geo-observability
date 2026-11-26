/**
 * Sample LLM traces for the demo workspace: a fictional support assistant (an agent that calls tools) and a
 * documentation search app (retrieve, then answer). Rows are written the way the ingest path would store them.
 */
import { rng } from "../../src/engines/stub";
import { spanFacts } from "../../src/tracing/openinference";
import type { Attrs } from "../../src/tracing/otlp";

const q = (v: unknown) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const hex = (r: () => number, len: number) => Array.from({ length: len }, () => Math.floor(r() * 16).toString(16)).join("");

interface DemoSpan {
  id: string;
  parent: string | null;
  name: string;
  start: number;
  end: number;
  attrs: Attrs;
  error?: string;
  events?: { name: string; time_ms: number; attributes: Attrs }[];
}

const SUPPORT: [string, string, string, string][] = [
  ["How do I reset my password?", "search_help_center", '{"query":"reset password"}', "Open Settings, choose Security, then Reset password. We email you a link that works for one hour."],
  ["Where is my refund for order 48213?", "lookup_order", '{"order_id":"48213"}', "Your refund for order 48213 was issued on Tuesday. Banks usually show it within five working days."],
  ["Can I add a teammate to my plan?", "search_help_center", '{"query":"add teammate seats"}', "Yes. Go to Team, choose Invite, and enter their email. Each extra seat is billed pro rata."],
  ["Do you integrate with Slack?", "search_help_center", '{"query":"slack integration"}', "Yes. Install the Slack app from Integrations, then pick the channels that should receive ticket updates."],
  ["Cancel my subscription please", "lookup_account", '{"email":"customer@example.com"}', "I can help with that. Your plan renews on the 3rd; cancelling now keeps access until then. Shall I go ahead?"],
  ["Why was I charged twice this month?", "lookup_invoices", '{"months":2}', "I can see two charges: your monthly plan and a one-off charge for three extra seats added on the 12th."],
];
const DOCS: [string, string[], string][] = [
  ["How do webhooks retry?", ["Webhooks retry up to five times with a growing delay.", "A delivery counts as failed after a 10 second timeout.", "Signing secrets rotate from the dashboard."], "Failed deliveries are retried up to five times with a growing delay. A delivery fails when your endpoint takes longer than 10 seconds."],
  ["What is the rate limit on the tickets API?", ["The tickets API allows 120 requests a minute per key.", "Bulk import has its own limit.", "A 429 response carries a Retry-After header."], "120 requests a minute per key. When you go over, the API answers 429 with a Retry-After header."],
  ["How do I export all tickets?", ["Exports run as background jobs.", "CSV and JSON are supported.", "Large exports are split into files of 50,000 rows."], "Start an export from Settings or the API. It runs in the background and gives you CSV or JSON files of up to 50,000 rows each."],
];

const SYSTEM = "You are the Northwind Desk support assistant. Use the tools to look things up before you answer. Keep answers short.";

function supportTrace(r: () => number, t0: number, session: string | null, failTool: boolean): DemoSpan[] {
  const [question, tool, args, answer] = SUPPORT[Math.floor(r() * SUPPORT.length)]!;
  const ids = [hex(r, 16), hex(r, 16), hex(r, 16), hex(r, 16)];
  const llm1 = 600 + Math.floor(r() * 900);
  const toolMs = failTool ? 5000 : 150 + Math.floor(r() * 500);
  const llm2 = 700 + Math.floor(r() * 1400);
  const p1 = 380 + Math.floor(r() * 200);
  const p2 = p1 + 160 + Math.floor(r() * 300);
  const c2 = 40 + Math.floor(r() * 60);
  const model = r() < 0.7 ? "gpt-5-mini" : "claude-haiku-5-5";
  const provider = model.startsWith("gpt") ? "openai" : "anthropic";
  const common: Attrs = session ? { "session.id": session, "user.id": `user-${session.slice(-2)}` } : {};
  const toolResult = failTool ? null : `{"results":["${answer.slice(0, 60)}…"]}`;
  const spans: DemoSpan[] = [
    {
      id: ids[0]!, parent: null, name: "support_agent", start: t0, end: t0 + 40 + llm1 + toolMs + (failTool ? 0 : llm2) + 30,
      attrs: { "openinference.span.kind": "AGENT", "agent.name": "support_agent", "input.value": question, ...(failTool ? {} : { "output.value": answer }), ...common, "tag.tags": ["demo", "support"] },
      ...(failTool ? { error: `${tool} timed out after 5000 ms` } : {}),
    },
    {
      id: ids[1]!, parent: ids[0]!, name: "ChatCompletion", start: t0 + 20, end: t0 + 20 + llm1,
      attrs: {
        "openinference.span.kind": "LLM", "llm.model_name": model, "llm.provider": provider, "llm.invocation_parameters": '{"temperature":0.2}',
        "llm.token_count.prompt": p1, "llm.token_count.completion": 24, "llm.token_count.total": p1 + 24, "llm.cost.total": Number(((p1 * 0.25 + 24 * 2) / 1e6).toFixed(6)),
        "llm.input_messages.0.message.role": "system", "llm.input_messages.0.message.content": SYSTEM,
        "llm.input_messages.1.message.role": "user", "llm.input_messages.1.message.content": question,
        "llm.output_messages.0.message.role": "assistant",
        "llm.output_messages.0.message.tool_calls.0.tool_call.id": `call_${ids[2]!.slice(0, 8)}`,
        "llm.output_messages.0.message.tool_calls.0.tool_call.function.name": tool,
        "llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments": args,
        "llm.tools.0.tool.json_schema": JSON.stringify({ type: "function", function: { name: tool, description: "Looks up information for the support assistant." } }),
        ...common,
      },
      events: [{ name: "first_token", time_ms: t0 + 20 + Math.floor(llm1 / 3), attributes: {} }],
    },
    {
      id: ids[2]!, parent: ids[0]!, name: tool, start: t0 + 30 + llm1, end: t0 + 30 + llm1 + toolMs,
      attrs: { "openinference.span.kind": "TOOL", "tool.name": tool, "input.value": args, "input.mime_type": "application/json", ...(toolResult ? { "output.value": toolResult, "output.mime_type": "application/json" } : {}), ...common },
      ...(failTool ? { error: "timed out after 5000 ms", events: [{ name: "exception", time_ms: t0 + 30 + llm1 + toolMs, attributes: { "exception.type": "TimeoutError", "exception.message": "upstream did not answer in 5000 ms" } }] } : {}),
    },
  ];
  if (!failTool) {
    spans.push({
      id: ids[3]!, parent: ids[0]!, name: "ChatCompletion", start: t0 + 40 + llm1 + toolMs, end: t0 + 40 + llm1 + toolMs + llm2,
      attrs: {
        "openinference.span.kind": "LLM", "llm.model_name": model, "llm.provider": provider,
        "llm.token_count.prompt": p2, "llm.token_count.completion": c2, "llm.token_count.total": p2 + c2, "llm.cost.total": Number(((p2 * 0.25 + c2 * 2) / 1e6).toFixed(6)),
        "llm.input_messages.0.message.role": "system", "llm.input_messages.0.message.content": SYSTEM,
        "llm.input_messages.1.message.role": "user", "llm.input_messages.1.message.content": question,
        "llm.input_messages.2.message.role": "assistant",
        "llm.input_messages.2.message.tool_calls.0.tool_call.function.name": tool,
        "llm.input_messages.2.message.tool_calls.0.tool_call.function.arguments": args,
        "llm.input_messages.3.message.role": "tool", "llm.input_messages.3.message.content": toolResult,
        "llm.output_messages.0.message.role": "assistant", "llm.output_messages.0.message.content": answer,
        ...common,
      },
    });
  }
  return spans;
}

function docsTrace(r: () => number, t0: number): DemoSpan[] {
  const [question, docs, answer] = DOCS[Math.floor(r() * DOCS.length)]!;
  const ids = [hex(r, 16), hex(r, 16), hex(r, 16), hex(r, 16)];
  const embed = 40 + Math.floor(r() * 60);
  const search = 80 + Math.floor(r() * 200);
  const llm = 900 + Math.floor(r() * 1600);
  const p = 520 + Math.floor(r() * 300);
  const c = 50 + Math.floor(r() * 50);
  const docAttrs: Attrs = {};
  docs.forEach((d, i) => {
    docAttrs[`retrieval.documents.${i}.document.id`] = `kb-${100 + i * 7}`;
    docAttrs[`retrieval.documents.${i}.document.content`] = d;
    docAttrs[`retrieval.documents.${i}.document.score`] = Number((0.92 - i * 0.11).toFixed(2));
  });
  return [
    { id: ids[0]!, parent: null, name: "answer_from_docs", start: t0, end: t0 + embed + search + llm + 40, attrs: { "openinference.span.kind": "CHAIN", "input.value": question, "output.value": answer } },
    { id: ids[1]!, parent: ids[0]!, name: "embed_query", start: t0 + 5, end: t0 + 5 + embed, attrs: { "openinference.span.kind": "EMBEDDING", "embedding.model_name": "text-embedding-3-small", "embedding.embeddings.0.embedding.text": question, "llm.token_count.prompt": 12, "llm.token_count.total": 12 } },
    { id: ids[2]!, parent: ids[0]!, name: "search_knowledge_base", start: t0 + 10 + embed, end: t0 + 10 + embed + search, attrs: { "openinference.span.kind": "RETRIEVER", "input.value": question, ...docAttrs } },
    {
      id: ids[3]!, parent: ids[0]!, name: "ChatCompletion", start: t0 + 20 + embed + search, end: t0 + 20 + embed + search + llm,
      attrs: {
        "openinference.span.kind": "LLM", "llm.model_name": "gemini-2.5-flash", "llm.provider": "google",
        "llm.token_count.prompt": p, "llm.token_count.completion": c, "llm.token_count.total": p + c, "llm.cost.total": Number(((p * 0.3 + c * 2.5) / 1e6).toFixed(6)),
        "llm.input_messages.0.message.role": "system", "llm.input_messages.0.message.content": "Answer from the documents provided. Say so when they do not cover the question.",
        "llm.input_messages.1.message.role": "user", "llm.input_messages.1.message.content": `${question}\n\nDocuments:\n${docs.map((d, i) => `[${i + 1}] ${d}`).join("\n")}`,
        "llm.output_messages.0.message.role": "assistant", "llm.output_messages.0.message.content": answer,
      },
    },
  ];
}

const USAGE_KINDS = new Set(["LLM", "EMBEDDING", "DECISION"]);

const PEOPLE = ["Ada L.", "Grace H.", "Linus T.", "Margaret H.", "Dennis R.", "Barbara L."];
const CODING: [string, string[], string][] = [
  ["Fix the failing date test in the billing module", ["Read", "Grep", "Edit", "Bash"], "Fixed. The test parsed dates in local time; it now uses UTC."],
  ["Add a retry with backoff to the webhook sender", ["Read", "Edit", "Bash"], "Added three retries with a growing delay and a test for the timeout case."],
  ["Why is the tickets list slow for large accounts?", ["Grep", "Read", "Bash"], "The list loads every ticket before paging. I added a limit to the query and an index."],
  ["Rename customerId to accountId across the API", ["Grep", "Edit", "Edit", "Bash"], "Renamed in 14 files. Types and tests pass."],
  ["Write a migration that adds a status column to tickets", ["Read", "Write", "Bash"], "Added the migration with a default of open, and backfilled closed tickets."],
  ["Summarise what changed on this branch", ["Bash", "Read"], "Six commits: the retry helper, two bug fixes and their tests."],
];

/** One turn of a coding tool, in the shape the geo-trace hook script sends. */
function codingTurn(r: () => number, t0: number, tool: "claude-code" | "codex", user: string, session: string): DemoSpan[] {
  const [prompt, baseTools, answer] = CODING[Math.floor(r() * CODING.length)]!;
  // Some turns also use a skill, a subagent or a tool from an MCP server or plugin, as real sessions do.
  const tools = [...baseTools];
  const style = Math.floor(r() * 100) + user.charCodeAt(0) * 7;
  if (tool === "claude-code" && style % 3 === 0) tools.splice(1, 0, "Skill");
  if (tool === "claude-code" && style % 4 === 0) tools.splice(1, 0, "Agent");
  if (style % 5 === 0) tools.push(tool === "codex" ? "mcp__linear__get_issue" : "mcp__plugin_github_github__create_pull_request");
  if (style % 11 === 0) tools.push("mcp__sentry__search_issues");
  const facts = (name: string): Attrs => {
    if (name === "Bash") return { "tool.kind": "shell", "command.program": ["git", "npm", "pytest", "rg", "docker"][Math.floor(r() * 5)]! };
    if (name === "Skill") { const s = ["code-review", "release-notes", "stripe:test-cards", "simplify"][Math.floor(r() * 4)]!; return { "tool.kind": "skill", "skill.name": s, ...(s.includes(":") ? { "plugin.name": s.split(":")[0]! } : {}) }; }
    if (name === "Agent") return { "tool.kind": "subagent", "subagent.type": ["Explore", "general-purpose", "Plan"][Math.floor(r() * 3)]! };
    const m = /^mcp__(?:plugin_([a-z]+)_)?([a-z]+)__/.exec(name);
    if (m) return { "tool.kind": "mcp", "mcp.server": m[2]!, ...(m[1] ? { "plugin.name": m[1] } : {}) };
    return { "tool.kind": "builtin" };
  };
  const slash = style % 6 === 0 ? ["review", "commit", "simplify"][style % 3]! : null;
  const cutShort = style % 17 === 0;
  const model = tool === "codex" ? "gpt-5-codex" : r() < 0.6 ? "claude-sonnet-5-5" : "claude-opus-5-5";
  const provider = tool === "codex" ? "openai" : "anthropic";
  const common: Attrs = { "session.id": `${tool}:${session}`, "user.id": user, "harness.name": tool };
  const rootId = hex(r, 16);
  const spans: DemoSpan[] = [];
  let at = t0;
  const failAt = r() < 0.08 ? Math.floor(r() * tools.length) : -1;
  tools.forEach((name, i) => {
    const think = 900 + Math.floor(r() * 2600);
    const cached = 8000 + Math.floor(r() * 30000);
    const fresh = 300 + Math.floor(r() * 2500);
    const out = 80 + Math.floor(r() * 500);
    spans.push({ id: hex(r, 16), parent: rootId, name: tool === "codex" ? "model request" : "model response", start: at, end: at + think,
      attrs: { "openinference.span.kind": "LLM", "llm.provider": provider, "llm.model_name": model, "llm.token_count.prompt": cached + fresh, "llm.token_count.completion": out, "llm.token_count.total": cached + fresh + out, "llm.token_count.prompt_details.cache_read": cached, "llm.output_messages.0.message.role": "assistant", "llm.output_messages.0.message.tool_calls.0.tool_call.function.name": name, ...common } });
    at += think + 20;
    const run = name === "Bash" ? 400 + Math.floor(r() * 4000) : 30 + Math.floor(r() * 250);
    spans.push({ id: hex(r, 16), parent: rootId, name, start: at, end: at + run, attrs: { "openinference.span.kind": "TOOL", "tool.name": name, ...facts(name), ...common }, ...(i === failAt ? { error: "The tool call failed." } : {}) });
    at += run + 20;
  });
  const last = 1200 + Math.floor(r() * 3000);
  const cached = 20000 + Math.floor(r() * 30000);
  spans.push({ id: hex(r, 16), parent: rootId, name: tool === "codex" ? "model request" : "model response", start: at, end: at + last,
    attrs: { "openinference.span.kind": "LLM", "llm.provider": provider, "llm.model_name": model, "llm.token_count.prompt": cached + 900, "llm.token_count.completion": 240, "llm.token_count.total": cached + 1140, "llm.token_count.prompt_details.cache_read": cached, "output.value": answer, ...common } });
  at += last + 30;
  spans.unshift({ id: rootId, parent: null, name: "turn", start: t0, end: at,
    attrs: { "openinference.span.kind": "AGENT", "agent.name": tool, ...common, "project.name": ["desk-api", "desk-web", "billing-jobs"][user.charCodeAt(0) % 3]!, "input.value": slash ? `/${slash} ${prompt}` : prompt, ...(slash ? { "slash.command": slash } : {}), ...(cutShort ? { "turn.incomplete": true } : { "output.value": answer }) } });
  return spans;
}

/** SQL for the demo workspace's apps, spans and trace summaries. */
export function demoTraces(tenant: string, dayList: string[]): string[] {
  const out: string[] = [];
  const apps = { support: "app_demo_support", docs: "app_demo_docs", claude: "app_demo_claude", codex: "app_demo_codex" };
  const lastSeen = `${dayList[dayList.length - 1]}T18:00:00.000Z`;
  for (const [id, name] of [[apps.support, "support-assistant"], [apps.docs, "docs-search"], [apps.claude, "claude-code"], [apps.codex, "codex"]]) {
    out.push(`INSERT INTO trace_apps (id, tenant_id, name, kind, last_seen_at) VALUES ('${id}', '${tenant}', '${name}', '${id === apps.claude || id === apps.codex ? "coding_tool" : "app"}', '${lastSeen}');`);
  }

  const emit = (appId: string, traceId: string, spans: DemoSpan[]) => {
    let prompt = 0, completion = 0, total = 0, cost = 0, errors = 0, llms = 0;
    let model: string | null = null;
    for (const s of spans) {
      const f = spanFacts(s.attrs);
      if (s.error) errors++;
      if (f.kind === "LLM") llms++;
      if (USAGE_KINDS.has(f.kind)) {
        prompt += f.promptTokens ?? 0;
        completion += f.completionTokens ?? 0;
        total += f.totalTokens ?? 0;
        cost += f.costMicros ?? 0;
      }
      model = model ?? f.model;
      out.push(
        `INSERT INTO llm_spans (tenant_id, app_id, trace_id, span_id, parent_span_id, name, kind, status_code, status_message, start_ms, end_ms, model, provider, prompt_tokens, completion_tokens, total_tokens, cost_micros, session_id, user_id, input_text, output_text, attributes, events) VALUES ('${tenant}', '${appId}', '${traceId}', '${s.id}', ${q(s.parent)}, ${q(s.name)}, '${f.kind}', '${s.error ? "ERROR" : "OK"}', ${q(s.error ?? null)}, ${s.start}, ${s.end}, ${q(f.model)}, ${q(f.provider)}, ${q(f.promptTokens)}, ${q(f.completionTokens)}, ${q(f.totalTokens)}, ${q(f.costMicros)}, ${q(f.sessionId)}, ${q(f.userId)}, ${q(f.input)}, ${q(f.output)}, ${q(JSON.stringify(s.attrs))}, ${q(JSON.stringify(s.events ?? []))});`,
      );
    }
    const root = spans[0]!;
    const rf = spanFacts(root.attrs);
    const lastOutput = [...spans].reverse().map((s) => spanFacts(s.attrs).output).find(Boolean) ?? null;
    out.push(
      `INSERT INTO llm_traces (tenant_id, app_id, trace_id, session_id, user_id, root_span_id, name, kind, status, start_ms, end_ms, span_count, error_count, llm_count, prompt_tokens, completion_tokens, total_tokens, cost_micros, model, input_preview, output_preview) VALUES ('${tenant}', '${appId}', '${traceId}', ${q(rf.sessionId)}, ${q(rf.userId)}, '${root.id}', ${q(root.name)}, '${rf.kind}', '${errors ? "ERROR" : "OK"}', ${root.start}, ${Math.max(...spans.map((s) => s.end))}, ${spans.length}, ${errors}, ${llms}, ${prompt}, ${completion}, ${total}, ${cost}, ${q(model)}, ${q(rf.input?.slice(0, 400))}, ${q((rf.output ?? lastOutput)?.slice(0, 400))});`,
    );
  };

  dayList.slice(-10).forEach((day, di) => {
    const r = rng(`traces-${di}`);
    const dayStart = Date.parse(`${day}T00:00:00Z`);
    const n = 5 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const t0 = dayStart + Math.floor((8 + r() * 10) * 3_600_000);
      const isDocs = r() < 0.35;
      const session = !isDocs && r() < 0.6 ? `sess-${day.slice(5)}-${String(Math.floor(r() * 3)).padStart(2, "0")}` : null;
      const spans = isDocs ? docsTrace(r, t0) : supportTrace(r, t0, session, r() < 0.14);
      emit(isDocs ? apps.docs : apps.support, hex(r, 32), spans);
    }
    // Coding tools: each person works in one or two sessions on the days they are active.
    const weekday = new Date(dayStart).getUTCDay();
    PEOPLE.forEach((user, pi) => {
      const cr = rng(`coding-${di}-${pi}`);
      if (weekday === 0 || weekday === 6 ? cr() < 0.85 : cr() < 0.2 + pi * 0.08) return;
      const sessions = 1 + Math.floor(cr() * 2);
      for (let si = 0; si < sessions; si++) {
        const tool = pi % 3 === 2 || (pi % 3 === 1 && cr() < 0.5) ? "codex" : "claude-code";
        const session = hex(cr, 12);
        let at = dayStart + Math.floor((9 + cr() * 7) * 3_600_000);
        const turns = 1 + Math.floor(cr() * (pi < 2 ? 6 : 3));
        for (let ti = 0; ti < turns; ti++) {
          const spans = codingTurn(cr, at, tool, user, session);
          emit(tool === "codex" ? apps.codex : apps.claude, hex(cr, 32), spans);
          at = spans[0]!.end + 20_000 + Math.floor(cr() * 240_000);
        }
      }
    });
  });
  return out;
}
