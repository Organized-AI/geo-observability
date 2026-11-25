#!/usr/bin/env node
/**
 * geo-trace: sends Claude Code and Codex sessions to a GEO Observability workspace as traces.
 *
 *   node geo-trace.mjs install --endpoint <url> --key <ingest key> [--user you@company.com] [--tools claude,codex]
 *                              [--no-content] [--tool-content]
 *   node geo-trace.mjs status | test | uninstall | print-managed <claude|codex>
 *   node geo-trace.mjs import [--days 30] [--tools claude,codex] [--dry-run]
 *   node geo-trace.mjs hook <claude|codex>        (run by the tools; reads one hook event on stdin)
 *
 * Both tools run "hooks" at points in a session (prompt sent, tool used, turn finished) and hand the hook a JSON
 * event. Each event is appended to a small file. When the turn finishes, the events become one trace: the turn,
 * its model calls and its tool calls. Nothing is printed and the exit code is always 0, so a session is never
 * altered or blocked. One file, no dependencies, Node 18 or later.
 */
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

export const VERSION = "1";
const HARNESSES = { claude: { service: "claude-code", provider: "anthropic" }, codex: { service: "codex", provider: "openai" } };
const CLAUDE_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop", "Stop", "SessionEnd"];
const CODEX_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PreModelRequest", "PostModelRequest", "SubagentStart", "SubagentStop", "Stop", "SessionEnd"];
const LIMITS = { prompt: 32_000, answer: 32_000, tool: 8_000, eventsPerTurn: 4000, outbox: 50, transcriptBytes: 64 * 1024 * 1024 };
const MARK = "geo-trace.mjs";

// ------------------------------------------------------------------ paths and config

export const dataDir = () => process.env.GEO_TRACE_HOME || join(homedir(), ".geo-observability");
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const codexDir = () => process.env.CODEX_HOME || join(homedir(), ".codex");
const safe = (s) => String(s || "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);

/** The workspace's level can only narrow what this machine sends, never widen it. */
export function narrow(capture, workspace) {
  const c = { ...capture };
  if (workspace === "metadata") { c.prompts = false; c.responses = false; c.tool_io = false; }
  if (workspace === "prompts") c.tool_io = false;
  return c;
}

export function loadConfig() {
  try {
    const c = JSON.parse(readFileSync(join(dataDir(), "config.json"), "utf8"));
    return { ...c, capture: narrow({ prompts: true, responses: true, tool_io: false, ...(c.capture || {}) }, c.workspace_capture) };
  } catch {
    return null;
  }
}

function writePrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

const cut = (v, max) => {
  const s = typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)} …[cut]` : s;
};
const randomHex = (bytes) => randomBytes(bytes).toString("hex");
const hex = randomHex;

// ------------------------------------------------------------------ what a tool call was (names only)

const nameOnly = (v, max = 80) => (typeof v === "string" && /^[A-Za-z0-9 ._:@/-]{1,200}$/.test(v.trim()) ? v.trim().slice(0, max) : undefined);

/** The program a shell command starts with ("git", "npm"), never its arguments. */
export function programOf(command) {
  let c = Array.isArray(command) ? command[command.length - 1] : command;
  if (typeof c !== "string") return undefined;
  // Skip leading "cd x &&", environment assignments and sudo, which say nothing about what was run.
  c = c.trim().replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, "");
  const words = c.split(/\s+/);
  while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0] === "sudo" || words[0] === "env" || words[0] === "time")) words.shift();
  const first = (words[0] || "").split("/").pop();
  return /^[A-Za-z0-9._+-]{1,40}$/.test(first) ? first : undefined;
}

/**
 * Names that describe a tool call without its content: the skill, the subagent type, the MCP server and plugin a
 * tool belongs to, the program a shell command runs. These are sent even when tool inputs are switched off,
 * because they are what makes usage readable; arguments, paths and output are not included.
 */
export function toolFacts(tool, input) {
  const f = {};
  const name = String(tool || "");
  let obj = input;
  if (typeof obj === "string") { try { obj = JSON.parse(obj); } catch { obj = null; } }
  if (!obj || typeof obj !== "object") obj = {};
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    f.kind = "mcp";
    const plugin = /^plugin_([^_]+(?:-[^_]+)*)_(.+)$/.exec(mcp[1]);
    f.server = plugin ? plugin[2] : mcp[1];
    if (plugin) f.plugin = plugin[1];
  } else if (name === "Skill") {
    f.kind = "skill";
    const skill = nameOnly(obj.skill ?? obj.name ?? obj.command);
    if (skill) { f.skill = skill; if (skill.includes(":")) f.plugin = skill.split(":")[0]; }
  } else if (name === "Agent" || name === "Task") {
    f.kind = "subagent";
    const type = nameOnly(obj.subagent_type ?? obj.agent_type);
    f.subagent = type || "general-purpose";
  } else if (/^(Bash|shell|local_shell|exec_command|shell_command)$/i.test(name)) {
    f.kind = "shell";
    const program = programOf(obj.command ?? obj.cmd ?? obj.script);
    if (program) f.program = program;
  } else f.kind = "builtin";
  return f;
}

/** A prompt that starts with a slash command: the command's name, nothing after it. */
export const slashCommand = (prompt) => { const m = /^\s*\/([A-Za-z0-9][A-Za-z0-9:._-]{0,60})(?:\s|$)/.exec(typeof prompt === "string" ? prompt : ""); return m ? m[1] : undefined; };

// ------------------------------------------------------------------ capture (one hook event -> one stored line)

/** The fields kept from a hook event. Content the config switches off never reaches the disk. */
export function slimEvent(harness, d, cfg, now = Date.now()) {
  const name = d.hook_event_name || d.event || d.kind || "";
  const cap = cfg.capture;
  const e = { t: now, e: name, sid: d.session_id || d.thread_id || "" };
  for (const [from, to] of [["cwd", "cwd"], ["prompt_id", "pid"], ["turn_id", "pid"], ["transcript_path", "tp"], ["model", "model"], ["permission_mode", "pm"], ["agent_id", "aid"], ["agent_type", "atype"], ["tool_use_id", "tid"], ["tool_name", "tool"], ["request_id", "rid"]]) {
    if (typeof d[from] === "string" && d[from] && e[to] === undefined) e[to] = d[from];
  }
  if (name === "UserPromptSubmit" && typeof d.prompt === "string") { const cmd = slashCommand(d.prompt); if (cmd) e.cmd = cmd; }
  if (name === "PreToolUse") e.meta = toolFacts(d.tool_name, d.tool_input);
  if (name === "UserPromptSubmit" && cap.prompts && typeof d.prompt === "string") e.prompt = cut(d.prompt, LIMITS.prompt);
  if ((name === "Stop" || name === "SubagentStop") && cap.responses && typeof d.last_assistant_message === "string") e.answer = cut(d.last_assistant_message, LIMITS.answer);
  if (name === "SubagentStop" && typeof d.agent_transcript_path === "string") e.atp = d.agent_transcript_path;
  if (name === "PreToolUse" && cap.tool_io && d.tool_input !== undefined) e.input = cut(d.tool_input, LIMITS.tool);
  if (name === "PostToolUse" || name === "PostToolUseFailure") {
    if (cap.tool_io && d.tool_response !== undefined) e.output = cut(d.tool_response, LIMITS.tool);
    if (typeof d.duration_ms === "number") e.dur = d.duration_ms;
    if (name === "PostToolUseFailure") e.err = cap.tool_io && typeof d.error === "string" ? cut(d.error, 2000) : "The tool call failed.";
  }
  if (name === "PostModelRequest") {
    if (d.token_usage && typeof d.token_usage === "object") e.usage = d.token_usage;
    if (typeof d.status === "string") e.status = d.status;
    if (d.status === "failed") e.err = cap.tool_io && typeof d.error === "string" ? cut(d.error, 2000) : "The model request failed.";
  }
  if (name === "SessionEnd" && typeof d.reason === "string") e.reason = d.reason;
  return e;
}

const stateFile = (harness, sid) => join(dataDir(), "state", `${harness}-${safe(sid)}.jsonl`);

function readEvents(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ Claude Code transcript (model and token counts only)

/**
 * Model calls found in a Claude Code transcript. The format is internal to Claude Code and may change, so this
 * reads defensively and returns [] when it does not recognise what it finds. One model response is written as
 * several lines sharing a message id; they are folded together and the largest usage is kept.
 */
export function transcriptCalls(text, { promptId, sinceMs } = {}) {
  const calls = new Map();
  // The person's own lines carry the prompt id; the model's lines that follow them belong to that prompt.
  const haveIds = promptId ? text.includes(`"${promptId}"`) : false;
  let inTurn = false;
  for (const line of text.split("\n")) {
    if (!line || !(line.includes('"assistant"') || (haveIds && line.includes('"promptId"')))) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || typeof d !== "object") continue;
    if (haveIds && typeof d.promptId === "string") inTurn = d.promptId === promptId;
    const m = d.type === "assistant" ? d.message : null;
    if (!m || typeof m !== "object" || !m.id || !m.usage) continue;
    const ts = Date.parse(d.timestamp);
    if (haveIds ? !inTurn : Number.isFinite(sinceMs) && !(ts >= sinceMs - 1000)) continue;
    foldCall(calls, d, m, ts);
  }
  return [...calls.values()].filter((c) => Number.isFinite(c.first)).sort((a, b) => a.first - b.first);
}

/** Adds one transcript line of a model response to the call it belongs to (lines share a message id). */
function foldCall(calls, _d, m, ts) {
  const u = m.usage;
  const n = (x) => (typeof x === "number" && x >= 0 ? x : 0);
  const usage = { input: n(u.input_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens), output: n(u.output_tokens) };
  const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
  const prev = calls.get(m.id);
  const blocks = Array.isArray(m.content) ? m.content : [];
  const texts = blocks.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text);
  const toolNames = blocks.filter((b) => b && b.type === "tool_use" && typeof b.name === "string").map((b) => b.name);
  if (!prev) calls.set(m.id, { id: m.id, model: typeof m.model === "string" ? m.model : null, first: ts, last: ts, usage, total, texts, toolNames });
  else {
    if (Number.isFinite(ts)) { prev.first = Math.min(prev.first, ts); prev.last = Math.max(prev.last, ts); }
    if (total > prev.total) { prev.usage = usage; prev.total = total; }
    prev.texts.push(...texts);
    prev.toolNames.push(...toolNames);
  }
}

function readTranscript(path, opts) {
  try {
    if (!path || !existsSync(path) || statSync(path).size > LIMITS.transcriptBytes) return [];
    return transcriptCalls(readFileSync(path, "utf8"), opts);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ one turn -> spans

/**
 * Builds the spans of one turn from its stored events.
 *   turn (AGENT)  -> model calls (LLM)  -> tool calls (TOOL)  -> subagents (AGENT) with their own calls and tools
 */
export function buildTurn(harness, cfg, events, extra = {}) {
  if (!events.length) return null;
  const h = HARNESSES[harness];
  const start = events.find((e) => e.e === "UserPromptSubmit") || events[0];
  const stop = [...events].reverse().find((e) => e.e === "Stop");
  const lastT = events.reduce((m, e) => Math.max(m, e.t), start.t);
  const sid = start.sid || events.find((e) => e.sid)?.sid || "unknown";
  const cwd = events.find((e) => e.cwd)?.cwd || "";
  const model = [...events].reverse().find((e) => e.model)?.model || null;
  // With a seed (imports), ids are derived from it, so importing the same session twice sends the same ids.
  // Each step's id comes from what it is (its tool call id, its message id), not from its position, so a turn that
  // was still running when it was first imported adds its later steps without repeating the earlier ones.
  let n = 0;
  const id = (key) => (extra.seed ? createHash("sha256").update(`${extra.seed}|${key}`).digest("hex").slice(0, 16) : randomHex(8));
  const traceId = extra.seed ? createHash("sha256").update(`${extra.seed}|trace`).digest("hex").slice(0, 32) : randomHex(16);
  const rootId = id("root");
  const spans = [];
  const common = { "session.id": `${h.service}:${sid}`, "user.id": cfg.user || "unknown", "harness.name": h.service };

  const root = {
    id: rootId, parent: null, name: "turn", start: start.t, end: Math.max(stop ? stop.t : lastT, start.t), error: null,
    attrs: { "openinference.span.kind": "AGENT", "agent.name": h.service, ...common, ...(cwd ? { "project.name": basename(cwd) } : {}), ...(start.pid ? { "turn.id": start.pid } : {}), ...(start.pm ? { "permission.mode": start.pm } : {}), ...(model ? { "harness.model": model } : {}), ...(stop ? {} : { "turn.incomplete": true }) },
  };
  if (start.cmd) root.attrs["slash.command"] = start.cmd;
  if (start.prompt !== undefined) root.attrs["input.value"] = start.prompt;
  if (stop && stop.answer !== undefined) root.attrs["output.value"] = stop.answer;
  spans.push(root);

  // Subagents: a span each, parent of everything that happened inside them.
  const agents = new Map();
  for (const e of events) {
    if (!e.aid) continue;
    let a = agents.get(e.aid);
    if (!a) { a = { id: id(`agent:${e.aid}`), start: e.t, end: e.t, type: e.atype || "subagent", answer: undefined, atp: null }; agents.set(e.aid, a); }
    a.start = Math.min(a.start, e.t);
    a.end = Math.max(a.end, e.t);
    if (e.atype) a.type = e.atype;
    if (e.e === "SubagentStop") { if (e.answer !== undefined) a.answer = e.answer; if (e.atp) a.atp = e.atp; }
  }
  for (const [aid, a] of agents) {
    spans.push({ id: a.id, parent: rootId, name: `subagent: ${a.type}`, start: a.start, end: a.end, error: null,
      attrs: { "openinference.span.kind": "AGENT", "agent.name": a.type, "subagent.id": aid, ...common, ...(a.answer !== undefined ? { "output.value": a.answer } : {}) } });
  }
  const parentOf = (e) => (e.aid && agents.has(e.aid) && e.e !== "SubagentStart" && e.e !== "SubagentStop" ? agents.get(e.aid).id : rootId);

  const facts = (meta) => {
    const m = meta || {};
    return { ...(m.kind ? { "tool.kind": m.kind } : {}), ...(m.server ? { "mcp.server": m.server } : {}), ...(m.plugin ? { "plugin.name": m.plugin } : {}), ...(m.skill ? { "skill.name": m.skill } : {}), ...(m.subagent ? { "subagent.type": m.subagent } : {}), ...(m.program ? { "command.program": m.program } : {}) };
  };
  // Tool calls: a Pre and a Post event share a tool_use_id.
  const pre = new Map();
  for (const e of events) if (e.e === "PreToolUse" && e.tid) pre.set(e.tid, e);
  const done = new Set();
  for (const e of events) {
    if (e.e !== "PostToolUse" && e.e !== "PostToolUseFailure") continue;
    if (e.tid && done.has(e.tid)) continue; // a result reported twice is one tool call
    const p = e.tid ? pre.get(e.tid) : null;
    if (e.tid) done.add(e.tid);
    const s = p ? p.t : typeof e.dur === "number" ? e.t - e.dur : e.t;
    spans.push({ id: id(`tool:${e.tid || n++}`), parent: parentOf(e), name: e.tool || p?.tool || "tool", start: Math.min(s, e.t), end: e.t, error: e.e === "PostToolUseFailure" ? e.err || "The tool call failed." : null,
      attrs: { "openinference.span.kind": "TOOL", "tool.name": e.tool || p?.tool || "tool", ...facts(p?.meta || toolFacts(e.tool || p?.tool)), ...common, ...(p && p.input !== undefined ? { "input.value": p.input, "input.mime_type": "application/json" } : {}), ...(e.output !== undefined ? { "output.value": e.output } : {}) } });
  }
  for (const [tid, p] of pre) {
    if (done.has(tid)) continue; // started but never reported back: interrupted or denied
    spans.push({ id: id(`tool:${tid}`), parent: parentOf(p), name: p.tool || "tool", start: p.t, end: p.t, error: null,
      attrs: { "openinference.span.kind": "TOOL", "tool.name": p.tool || "tool", "tool.unfinished": true, ...facts(p.meta), ...common, ...(p.input !== undefined ? { "input.value": p.input } : {}) } });
  }

  // Model calls. Codex reports each request with its token counts; for Claude Code they come from the transcript.
  const llm = (key, parent, name, s, e2, mdl, usage, more = {}, error = null) => {
    const attrs = { "openinference.span.kind": "LLM", "llm.provider": h.provider, ...common, ...(mdl ? { "llm.model_name": mdl } : {}), ...more };
    if (usage) {
      attrs["llm.token_count.prompt"] = usage.prompt;
      attrs["llm.token_count.completion"] = usage.completion;
      attrs["llm.token_count.total"] = usage.prompt + usage.completion;
      if (usage.cacheRead) attrs["llm.token_count.prompt_details.cache_read"] = usage.cacheRead;
      if (usage.cacheWrite) attrs["llm.token_count.prompt_details.cache_write"] = usage.cacheWrite;
      if (usage.reasoning) attrs["llm.token_count.completion_details.reasoning"] = usage.reasoning;
    }
    spans.push({ id: id(`llm:${key}`), parent, name, start: Math.min(s, e2), end: e2, error, attrs });
  };
  const preReq = new Map();
  let prevT = start.t;
  let reqN = 0;
  for (const e of events) {
    if (e.e === "PreModelRequest" && e.rid) preReq.set(e.rid, e.t);
    if (e.e === "PostModelRequest") {
      const u = e.usage || null;
      const n = (x) => (typeof x === "number" && x >= 0 ? x : 0);
      const usage = u ? { prompt: n(u.input_tokens), completion: n(u.output_tokens), cacheRead: n(u.cached_input_tokens), cacheWrite: n(u.cache_write_input_tokens), reasoning: n(u.reasoning_output_tokens) } : null;
      llm(`request:${reqN++}`, parentOf(e), "model request", (e.rid && preReq.get(e.rid)) || prevT, e.t, e.model || model, usage, {}, e.status === "failed" ? e.err || "The model request failed." : null);
    }
    prevT = e.t;
  }
  // The transcript only says when a response finished. It began when the turn started or the last tool returned.
  const marks = events.filter((e) => e.e === "PostToolUse" || e.e === "PostToolUseFailure").map((e) => e.t).sort((x, y) => x - y);
  const addCalls = (calls, parent, floor) => {
    let prev = floor;
    for (const c of calls) {
      for (const m of marks) if (m <= c.first && m > prev) prev = m;
      const usage = { prompt: c.usage.input + c.usage.cacheRead + c.usage.cacheWrite, completion: c.usage.output, cacheRead: c.usage.cacheRead, cacheWrite: c.usage.cacheWrite, reasoning: 0 };
      const more = {};
      if (cfg.capture.responses && c.texts.length) more["output.value"] = cut(c.texts.join("\n"), LIMITS.answer);
      c.toolNames.slice(0, 20).forEach((n, i) => { more[`llm.output_messages.0.message.tool_calls.${i}.tool_call.function.name`] = n; });
      if (c.toolNames.length) more["llm.output_messages.0.message.role"] = "assistant";
      llm(c.id, parent, "model response", Math.min(prev, c.first), Math.max(c.last, prev), c.model || model, usage, more);
      prev = Math.max(c.last, prev);
    }
  };
  if (extra.calls) addCalls(extra.calls, rootId, start.t);
  for (const [aid, calls] of Object.entries(extra.agentCalls || {})) if (agents.has(aid)) addCalls(calls, agents.get(aid).id, agents.get(aid).start);

  // A span may not end before it starts or outlive the turn by accident of clock order.
  for (const s of spans) { if (s.end < s.start) s.end = s.start; root.end = Math.max(root.end, s.end); }
  return { traceId, spans, service: h.service };
}

const anyValue = (v) => (typeof v === "boolean" ? { boolValue: v } : typeof v === "number" ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: String(v) });
// Things that look like secrets are replaced before a turn leaves the machine. The server runs the same rules
// (src/tracing/redact.ts); a test keeps the two lists equal.
export const SECRET_RULES = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ["stripe-key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["aws-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["google-key", /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["bearer", /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/g],
  ["url-password", /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]{3,}(@)/gi],
  ["assignment", /(\b[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi],
];

export function redact(text) {
  let out = String(text);
  for (const [name, re] of SECRET_RULES) {
    out = out.replace(re, (...m) => {
      const g1 = typeof m[1] === "string" && m.length > 3 ? m[1] : "";
      const g2 = typeof m[2] === "string" && m.length > 4 ? m[2] : "";
      return `${g1}${g1 && name === "bearer" ? " " : ""}[redacted:${name}]${g2}`;
    });
  }
  return out;
}

const scrub = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? redact(v) : v]));

const kvs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([key, v]) => ({ key, value: anyValue(v) }));

/** OTLP/JSON body for one turn. */
export function toOtlp(turn) {
  return {
    resourceSpans: [{
      resource: { attributes: kvs({ "service.name": turn.service, "telemetry.sdk.name": "geo-trace", "telemetry.sdk.version": VERSION }) },
      scopeSpans: [{ scope: { name: "geo-trace", version: VERSION }, spans: turn.spans.map((s) => ({
        traceId: turn.traceId, spanId: s.id, ...(s.parent ? { parentSpanId: s.parent } : {}), name: s.name, kind: 1,
        startTimeUnixNano: `${Math.round(s.start)}000000`, endTimeUnixNano: `${Math.round(s.end)}000000`,
        attributes: kvs(scrub(s.attrs)), status: s.error ? { code: 2, message: redact(String(s.error)) } : { code: 1 },
      })) }],
    }],
  };
}

// ------------------------------------------------------------------ sending

export const tracesUrl = (endpoint) => (/\/v1\/traces\/?$/.test(endpoint) ? endpoint : `${endpoint.replace(/\/+$/, "")}/v1/traces`);

export const policyUrl = (endpoint) => `${endpoint.replace(/\/v1\/traces\/?$/, "").replace(/\/+$/, "")}/policy`;

/** The workspace's capture level for this key, or null when it can't be read. */
async function fetchPolicy(cfg, timeoutMs = 4000) {
  try {
    const res = await fetch(policyUrl(cfg.endpoint), { headers: { "x-ingest-key": cfg.key }, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    if (!res.ok) return null;
    const p = await res.json();
    return ["full", "prompts", "metadata"].includes(p.capture) ? p : null;
  } catch {
    return null;
  }
}

/** Re-reads the workspace level once a day, so an owner's change reaches every machine. */
async function refreshPolicy(cfg) {
  if (Date.now() - (cfg.policy_at || 0) < 86_400_000) return cfg;
  const p = await fetchPolicy(cfg, 2500);
  const raw = JSON.parse(readFileSync(join(dataDir(), "config.json"), "utf8"));
  raw.policy_at = Date.now();
  if (p) raw.workspace_capture = p.capture;
  writePrivate(join(dataDir(), "config.json"), `${JSON.stringify(raw, null, 2)}\n`);
  return p ? { ...cfg, workspace_capture: p.capture, capture: narrow(cfg.capture, p.capture) } : cfg;
}

async function post(cfg, body, timeoutMs = 8000) {
  const res = await fetch(tracesUrl(cfg.endpoint), { method: "POST", headers: { "content-type": "application/json", "x-ingest-key": cfg.key }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  return res.status;
}

/** Sends a body; when the server cannot be reached (or is busy) it is kept in the outbox for the next turn. */
async function deliver(cfg, body) {
  let status = 0;
  try { status = await post(cfg, body); } catch { status = 0; }
  if (status >= 200 && status < 300) return true;
  if (status === 0 || status === 429 || status >= 500) {
    const dir = join(dataDir(), "outbox");
    mkdirSync(dir, { recursive: true });
    const files = readdirSync(dir).sort();
    for (const f of files.slice(0, Math.max(0, files.length - LIMITS.outbox + 1))) rmSync(join(dir, f), { force: true });
    writePrivate(join(dir, `${Date.now()}-${hex(4)}.json`), JSON.stringify(body));
  } // other 4xx: the server refused it (bad key, bad body); keeping it would never help
  log(`send failed with status ${status}`);
  return false;
}

async function drainOutbox(cfg, max = 5) {
  const dir = join(dataDir(), "outbox");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).sort().slice(0, max)) {
    const path = join(dir, f);
    let status = 0;
    try { status = await post(cfg, JSON.parse(readFileSync(path, "utf8")), 5000); } catch { status = 0; }
    if ((status >= 200 && status < 300) || (status >= 400 && status < 500 && status !== 429)) rmSync(path, { force: true });
    else break;
  }
}

function log(msg) {
  try {
    const path = join(dataDir(), "geo-trace.log");
    if (existsSync(path) && statSync(path).size > 512 * 1024) rmSync(path, { force: true });
    appendFileSync(path, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch { /* logging must never fail a hook */ }
}

// ------------------------------------------------------------------ the hook

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function flush(harness, cfgIn, _path, events) {
  if (!events.length) return;
  let cfg = cfgIn;
  try { cfg = await refreshPolicy(cfgIn); } catch { /* keep the last known level */ }
  const start = events.find((e) => e.e === "UserPromptSubmit") || events[0];
  const extra = {};
  if (harness === "claude") {
    const tp = events.find((e) => e.tp)?.tp;
    extra.calls = readTranscript(tp, { promptId: start.pid, sinceMs: start.t });
    extra.agentCalls = {};
    for (const e of events) if (e.e === "SubagentStop" && e.aid && e.atp) extra.agentCalls[e.aid] = readTranscript(e.atp, {});
  }
  // The same identity an import of this turn would use, so a turn sent live and later imported is stored once.
  if (start.sid && start.pid) extra.seed = `${harness}:${start.sid}:${start.pid}`;
  const turn = buildTurn(harness, cfg, events.slice(0, LIMITS.eventsPerTurn), extra);
  if (turn) await deliver(cfg, toOtlp(turn));
}

/**
 * Takes ownership of a session's stored events by renaming the file. Hooks run as separate background processes,
 * so two of them (the end of one turn, the start of the next) can reach the file together; only one rename wins.
 */
function claim(path) {
  const mine = `${path}.${process.pid}.${hex(3)}`;
  try { renameSync(path, mine); } catch { return null; }
  const events = readEvents(mine).sort((a, b) => a.t - b.t);
  rmSync(mine, { force: true });
  return events;
}
const putBack = (path, events) => { if (events.length) appendFileSync(path, events.map((x) => `${JSON.stringify(x)}\n`).join(""), { mode: 0o600 }); };

export async function runHook(harness, raw, now = Date.now()) {
  const cfg = loadConfig();
  if (!cfg || cfg.enabled === false || !cfg.endpoint || !cfg.key || process.env.GEO_TRACE_DISABLED === "1" || !HARNESSES[harness]) return;
  let d;
  try { d = JSON.parse(raw); } catch { return; }
  if (!d || typeof d !== "object" || Array.isArray(d)) return;
  const e = slimEvent(harness, d, cfg, now);
  if (!e.e || !e.sid) return;
  const path = stateFile(harness, e.sid);
  mkdirSync(dirname(path), { recursive: true });

  if (e.e === "UserPromptSubmit") {
    // Whatever is stored belongs to the previous turn, finished or not (interrupted, crashed): send it as it stands.
    const left = claim(path) || [];
    appendFileSync(path, `${JSON.stringify(e)}\n`, { mode: 0o600 });
    if (left.some((x) => x.e === "UserPromptSubmit")) await flush(harness, cfg, path, left);
    await drainOutbox(cfg);
    return;
  }
  e.k = hex(4);
  appendFileSync(path, `${JSON.stringify(e)}\n`, { mode: 0o600 });
  if (e.e !== "Stop" && e.e !== "SessionEnd") return;
  // Other hooks of this turn run in the background and the transcript is written late: give both a moment.
  if (e.e === "Stop") await sleep(Number(process.env.GEO_TRACE_SETTLE_MS ?? 700));
  const events = claim(path);
  if (!events) return; // the next turn's first hook already sent this one
  const at = events.findIndex((x) => x.k === e.k);
  if (at < 0) { putBack(path, events); return; } // these belong to a newer turn
  putBack(path, events.slice(at + 1));
  const turn = events.slice(0, at + 1);
  if (turn.some((x) => x.e === "UserPromptSubmit")) await flush(harness, cfg, path, turn);
  await drainOutbox(cfg);
}

// ------------------------------------------------------------------ import (history already on this machine)

const tsOf = (d) => { const t = Date.parse(d && d.timestamp); return Number.isFinite(t) ? t : null; };
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b && typeof b.text === "string" && (b.type === "text" || b.type === "input_text" || b.type === "output_text")).map((b) => b.text).join("\n") : "");

/** Turns in a Claude Code session file, as the events the hooks would have produced. Reads defensively. */
export function claudeTurns(text, cfg) {
  const cap = cfg.capture;
  const turns = [];
  let cur = null;
  let sid = "";
  let cwd = "";
  for (const line of text.split("\n")) {
    if (!line || !(line.includes('"user"') || line.includes('"assistant"'))) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || typeof d !== "object" || d.isSidechain) continue;
    const t = tsOf(d);
    const m = d.message;
    if (t === null || !m || typeof m !== "object") continue;
    if (typeof d.sessionId === "string") sid = d.sessionId;
    if (typeof d.cwd === "string") cwd = d.cwd;
    if (d.type === "user") {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const results = blocks.filter((b) => b && b.type === "tool_result");
      if (typeof d.promptId === "string" && (!cur || cur.pid !== d.promptId) && !results.length && !d.isMeta) {
        const cmd = slashCommand(textOf(m.content)) || (/<command-name>\/?([A-Za-z0-9][A-Za-z0-9:._-]{0,60})<\/command-name>/.exec(textOf(m.content)) || [])[1];
        cur = { pid: d.promptId, sid, events: [{ t, e: "UserPromptSubmit", sid, pid: d.promptId, cwd, ...(cmd ? { cmd } : {}), ...(cap.prompts ? { prompt: cut(textOf(m.content), LIMITS.prompt) } : {}) }], calls: new Map(), tools: new Map(), last: t, answer: "" };
        turns.push(cur);
        continue;
      }
      if (!cur) continue;
      cur.last = Math.max(cur.last, t);
      for (const r of results) {
        const name = cur.tools.get(r.tool_use_id) || "tool";
        cur.events.push({ t, e: r.is_error ? "PostToolUseFailure" : "PostToolUse", sid, tid: r.tool_use_id, tool: name, ...(cap.tool_io ? { output: cut(r.content, LIMITS.tool) } : {}), ...(r.is_error ? { err: cap.tool_io ? cut(r.content, 2000) : "The tool call failed." } : {}) });
      }
    } else if (d.type === "assistant" && cur) {
      cur.last = Math.max(cur.last, t);
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b && b.type === "tool_use" && typeof b.id === "string") {
          cur.tools.set(b.id, b.name || "tool");
          cur.events.push({ t, e: "PreToolUse", sid, tid: b.id, tool: b.name || "tool", meta: toolFacts(b.name, b.input), ...(cap.tool_io ? { input: cut(b.input, LIMITS.tool) } : {}) });
        } else if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) cur.answer = b.text;
      }
      if (m.id && m.usage) foldCall(cur.calls, d, m, t);
    }
  }
  return turns.map((c) => {
    c.events.push({ t: c.last, e: "Stop", sid: c.sid, ...(cap.responses && c.answer ? { answer: cut(c.answer, LIMITS.answer) } : {}) });
    return { harness: "claude", sid: c.sid, key: c.pid, events: c.events.sort((a, b) => a.t - b.t), extra: { calls: [...c.calls.values()].sort((a, b) => a.first - b.first) } };
  }).filter((c) => c.sid);
}

/** Turns in a Codex session file (a "rollout"), as hook-style events. The format is internal to Codex. */
export function codexTurns(text, cfg) {
  const cap = cfg.capture;
  const turns = [];
  let cur = null;
  let sid = "";
  let cwd = "";
  let lastTotal = "";
  let thread = "";
  let child = false;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d && typeof d === "object" && d.payload && typeof d.payload === "object" ? d.payload : null;
    const t = tsOf(d);
    if (!p || t === null) continue;
    if (d.type === "session_meta") {
      // The first one describes this file. A subagent's file also carries a copy of its parent's, and a replay of
      // the parent's earlier turns; neither is this thread's own work.
      if (!thread) { thread = String(p.id || p.session_id || ""); sid = String(p.session_id || p.id || ""); child = !!p.parent_thread_id; if (typeof p.cwd === "string") cwd = p.cwd; }
      continue;
    }
    if (d.type === "turn_context") { if (typeof p.cwd === "string") cwd = p.cwd; if (cur && typeof p.model === "string") { cur.model = p.model; cur.events[0].cwd = cwd; } continue; }
    if (d.type === "event_msg" && p.type === "task_started") {
      cur = { pid: String(p.turn_id || turns.length), events: [{ t, e: "UserPromptSubmit", sid, pid: String(p.turn_id || turns.length), cwd }], model: null, prompt: "", answer: "", done: false, last: t, pending: new Map(), prev: t };
      turns.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.last = Math.max(cur.last, t);
    if (d.type === "event_msg") {
      if (p.type === "user_message" && typeof p.message === "string") cur.prompt = p.message;
      else if (p.type === "agent_message" && typeof p.message === "string") cur.answer = p.message;
      else if (p.type === "task_complete") { cur.done = true; if (typeof p.last_agent_message === "string") cur.answer = p.last_agent_message; cur.events.push({ t, e: "Stop", sid }); }
      else if (p.type === "token_count" && p.info && p.info.last_token_usage) {
        const total = JSON.stringify(p.info.total_token_usage || null);
        if (total !== lastTotal) cur.events.push({ t, e: "PostModelRequest", sid, usage: p.info.last_token_usage, status: "completed" }); // an unchanged total is a repeat of the last report
        lastTotal = total;
      }
    } else if (d.type === "response_item") {
      const kind = String(p.type || "");
      if (kind === "message" && p.role === "user" && !cur.prompt) cur.firstUser = textOf(p.content) || cur.firstUser;
      else if (kind === "message" && p.role === "assistant") cur.answer = textOf(p.content) || cur.answer;
      else if (typeof p.call_id === "string" && /_call$/.test(kind)) {
        const name = String(p.name || (kind === "local_shell_call" ? "shell" : kind.replace(/_call$/, "")));
        cur.pending.set(p.call_id, name);
        cur.events.push({ t, e: "PreToolUse", sid, tid: p.call_id, tool: name, meta: toolFacts(name, p.arguments ?? p.input ?? p.action), ...(cap.tool_io ? { input: cut(p.arguments ?? p.input ?? p.action ?? "", LIMITS.tool) } : {}) });
      } else if (typeof p.call_id === "string" && /_output$/.test(kind)) {
        cur.events.push({ t, e: "PostToolUse", sid, tid: p.call_id, tool: cur.pending.get(p.call_id) || "tool", ...(cap.tool_io ? { output: cut(p.output ?? "", LIMITS.tool) } : {}) });
      }
    }
  }
  return turns.filter((c) => sid && !(child && !c.events.some((e) => e.e === "PostModelRequest"))).map((c) => {
    const first = c.events[0];
    const prompt = c.prompt || c.firstUser || "";
    if (cap.prompts && prompt) first.prompt = cut(prompt, LIMITS.prompt);
    for (const e of c.events) { e.sid = sid; if (c.model) e.model = c.model; }
    const stop = c.events.find((e) => e.e === "Stop");
    if (stop && cap.responses && c.answer) stop.answer = cut(c.answer, LIMITS.answer);
    return { harness: "codex", sid, key: thread === sid ? c.pid : `${thread}:${c.pid}`, events: c.events.sort((a, b) => a.t - b.t), extra: {} };
  });
}

function sessionFiles(root, since, match, depth) {
  const out = [];
  const walk = (dir, left) => {
    let names = [];
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const path = join(dir, n.name);
      if (n.isDirectory()) { if (left > 0 && n.name !== "subagents") walk(path, left - 1); continue; }
      if (!match.test(n.name)) continue;
      try { const st = statSync(path); if (st.mtimeMs >= since && st.size <= LIMITS.transcriptBytes) out.push(path); } catch { /* vanished */ }
    }
  };
  walk(root, depth);
  return out.sort();
}

async function importHistory(a, say) {
  const cfg = loadConfig();
  if (!cfg && !a["dry-run"]) throw new Error("Not installed. Run install first, or add --dry-run to only count what would be sent.");
  const use = cfg || { user: defaultUser(), capture: { prompts: true, responses: true, tool_io: false } };
  const days = Math.max(1, Math.min(365, Number(a.days) || 30));
  const since = Date.now() - days * 86_400_000;
  const want = String(a.tools || "claude,codex").split(",").map((s) => s.trim());
  const sources = [
    want.includes("claude") && { label: "Claude Code", files: sessionFiles(join(claudeDir(), "projects"), since, /\.jsonl$/, 1), read: claudeTurns },
    want.includes("codex") && { label: "Codex", files: sessionFiles(join(codexDir(), "sessions"), since, /^rollout-.*\.jsonl$/, 4), read: codexTurns },
  ].filter(Boolean);
  let batch = [];
  let batchSpans = 0;
  let sent = 0;
  let failed = 0;
  const send = async () => {
    if (!batch.length || a["dry-run"]) { batch = []; batchSpans = 0; return; }
    const body = { resourceSpans: batch.flatMap((b) => b.resourceSpans) };
    let status = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { status = await post(use, body, 30_000); } catch { status = 0; }
      if (status !== 429 && status !== 0 && status < 500) break;
      await sleep(3000 * (attempt + 1));
    }
    if (status >= 200 && status < 300) sent += batchSpans; else { failed += batchSpans; log(`import batch failed with status ${status}`); }
    batch = [];
    batchSpans = 0;
  };
  for (const src of sources) {
    let turns = 0, spans = 0, tokens = 0, sessions = 0, skipped = 0;
    for (const file of src.files) {
      let list = [];
      try { list = src.read(readFileSync(file, "utf8"), use); } catch { skipped++; continue; }
      const recent = list.filter((x) => x.events[x.events.length - 1].t >= since);
      if (recent.length) sessions++;
      for (const x of recent) {
        const turn = buildTurn(x.harness, use, x.events.slice(0, LIMITS.eventsPerTurn), { ...x.extra, seed: `${x.harness}:${x.sid}:${x.key}` });
        if (!turn) continue;
        turns++;
        spans += turn.spans.length;
        for (const s of turn.spans) tokens += s.attrs["llm.token_count.total"] || 0;
        batch.push(toOtlp(turn));
        batchSpans += turn.spans.length;
        if (batchSpans >= 600) await send();
      }
    }
    await send();
    say(`- ${src.label}: ${sessions} session file(s), ${turns} turn(s), ${spans} step(s), ${tokens.toLocaleString("en-US")} tokens${skipped ? `, ${skipped} file(s) could not be read` : ""}`);
  }
  if (a["dry-run"]) say(`Dry run: nothing was sent. Last ${days} day(s), as ${use.user}.`);
  else say(`Sent ${sent.toLocaleString("en-US")} step(s) from the last ${days} day(s) as ${use.user}${failed ? `; ${failed.toLocaleString("en-US")} were not accepted (see ${join(dataDir(), "geo-trace.log")})` : ""}.`);
  return failed ? 1 : 0;
}

// ------------------------------------------------------------------ install

const hookCommand = (script, harness) => `"${process.execPath}" "${script}" hook ${harness}`;
const isOurs = (entry) => !!entry && Array.isArray(entry.hooks) && entry.hooks.some((x) => x && typeof x.command === "string" && x.command.includes(MARK));

/** Adds our hook to each event and leaves every other entry alone. Running it again replaces only our entries. */
export function mergeHooks(settings, events, command) {
  const out = { ...settings, hooks: { ...(settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) } };
  for (const ev of events) {
    const list = Array.isArray(out.hooks[ev]) ? out.hooks[ev].filter((x) => !isOurs(x)) : [];
    list.push({ hooks: [{ type: "command", command, async: true, timeout: 30 }] });
    out.hooks[ev] = list;
  }
  return out;
}

export function removeHooks(settings) {
  if (!settings.hooks || typeof settings.hooks !== "object") return settings;
  const hooks = {};
  for (const [ev, list] of Object.entries(settings.hooks)) {
    const kept = Array.isArray(list) ? list.filter((x) => !isOurs(x)) : list;
    if (!Array.isArray(kept) || kept.length) hooks[ev] = kept;
  }
  const out = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete out.hooks;
  return out;
}

/** Reads a JSON settings file. A missing file is {}; a file that is not valid JSON stops the install untouched. */
function readJsonFile(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v;
  } catch {
    throw new Error(`${path} is not valid JSON. Fix or remove it, then run this again. Nothing was changed.`);
  }
}

function updateJsonFile(path, change) {
  const before = readJsonFile(path);
  const after = change(before);
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  if (existsSync(path)) copyFileSync(path, `${path}.geo-trace.bak`);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(after, null, 2)}\n`);
  renameSync(tmp, path);
  return true;
}

const TARGETS = {
  claude: { label: "Claude Code", file: () => join(claudeDir(), "settings.json"), events: CLAUDE_EVENTS, present: () => existsSync(claudeDir()) },
  codex: { label: "Codex", file: () => join(codexDir(), "hooks.json"), events: CODEX_EVENTS, present: () => existsSync(codexDir()) },
};

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) out._.push(a);
    else if (a.includes("=")) out[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

function defaultUser() {
  try {
    const email = execFileSync("git", ["config", "--global", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
    if (email) return email;
  } catch { /* no git or no email set */ }
  try { return userInfo().username; } catch { return "unknown"; }
}

function testTurn(cfg) {
  const now = Date.now();
  return buildTurn("claude", cfg, [
    { t: now - 1200, e: "UserPromptSubmit", sid: `connection-test-${hex(3)}`, prompt: cfg.capture.prompts ? "geo-trace connection test" : undefined, cwd: process.cwd() },
    { t: now - 900, e: "PreToolUse", sid: "x", tid: "t1", tool: "ConnectionCheck" },
    { t: now - 600, e: "PostToolUse", sid: "x", tid: "t1", tool: "ConnectionCheck" },
    { t: now, e: "Stop", sid: "x", answer: cfg.capture.responses ? "It works. This turn was sent by geo-trace test." : undefined },
  ]);
}

async function install(a, say) {
  const prev = loadConfig() || {};
  const endpoint = String(a.endpoint || prev.endpoint || "").trim();
  const key = String(a.key || process.env.GEO_TRACE_KEY || prev.key || "").trim();
  if (!/^https?:\/\//.test(endpoint)) throw new Error("Give the endpoint from the Traces page: --endpoint https://<host>/ingest/otlp");
  if (key.length < 20) throw new Error("Give an ingest key from Usage & API: --key <ingest key>");
  if (endpoint.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|100\.\d+\.\d+\.\d+|[a-z0-9-]+)(:\d+)?(\/|$)/i.test(endpoint)) throw new Error("Use an https:// endpoint. Plain http is only accepted for a local or private-network address.");
  const cfg = {
    endpoint, key, user: String(a.user || prev.user || defaultUser()), enabled: true,
    capture: { prompts: !a["no-content"], responses: !a["no-content"], tool_io: !!a["tool-content"] && !a["no-content"] },
  };
  const dest = join(dataDir(), MARK);
  mkdirSync(dataDir(), { recursive: true });
  const self = fileURLToPath(import.meta.url);
  if (self !== dest && !(existsSync(dest) && realpathSync(dest) === self)) copyFileSync(self, dest);
  chmodSync(dest, 0o700);
  const policy = await fetchPolicy(cfg);
  if (policy) Object.assign(cfg, { workspace_capture: policy.capture, policy_at: Date.now() });
  writePrivate(join(dataDir(), "config.json"), `${JSON.stringify(cfg, null, 2)}\n`);
  const sent = narrow(cfg.capture, cfg.workspace_capture);

  const want = String(a.tools || "claude,codex").split(",").map((s) => s.trim()).filter((s) => TARGETS[s]);
  const done = [];
  for (const name of want) {
    const t = TARGETS[name];
    if (!t.present() && !a.force) { say(`- ${t.label}: not found on this machine, skipped (use --force to set it up anyway)`); continue; }
    updateJsonFile(t.file(), (s) => mergeHooks(s, t.events, hookCommand(dest, name)));
    done.push(name);
    say(`- ${t.label}: connected (${t.file()})`);
  }
  say("");
  say("What this machine sends from now on");
  say(`  To:        ${tracesUrl(cfg.endpoint)}`);
  say(`  As:        ${policy?.person ? `${policy.person} (set by your personal key)` : `${cfg.user} (a workspace key: the name is not verified)`}`);
  say(`  Always:    timings, models, token counts, tool and skill names, project folder name`);
  say(`  Prompts and answers:      ${sent.prompts ? "sent" : "not sent"}`);
  say(`  Tool inputs and outputs:  ${sent.tool_io ? "sent" : "not sent"}`);
  if (policy) say(`  Workspace level: ${policy.capture} (set by your workspace owner; it can only reduce what is sent)`);
  else say("  Workspace level: could not be read yet; it is checked again each day");
  say("  Things that look like passwords, keys and tokens are replaced before sending.");
  say("  Who can read it: you and your workspace owners. Usage numbers are visible to your team.");
  say(`  Stop at any time: node ${join(dataDir(), MARK)} uninstall`);
  say("");
  if (done.includes("codex")) say("Codex asks you to approve new hooks: open Codex, run /hooks and approve geo-trace. Until then Codex sends nothing.");
  if (!a["skip-test"]) {
    let status = 0;
    try { status = await post(cfg, toOtlp(testTurn(cfg))); } catch { status = 0; }
    if (status >= 200 && status < 300) say("Connection test: a test turn was accepted. It appears under Traces.");
    else say(`Connection test failed (${status === 0 ? "the server could not be reached" : status === 401 ? "the key was refused: it must be an ingest key" : `status ${status}`}). The hooks are installed; fix the endpoint or key and run install again.`);
  }
}

function uninstall(say) {
  for (const t of Object.values(TARGETS)) {
    try {
      if (existsSync(t.file()) && updateJsonFile(t.file(), removeHooks)) say(`- ${t.label}: disconnected`);
    } catch (err) { say(`- ${t.label}: ${err.message}`); }
  }
  rmSync(dataDir(), { recursive: true, force: true });
  say("Removed geo-trace and its settings.");
}

function status(say) {
  const cfg = loadConfig();
  if (!cfg) { say("Not installed."); return; }
  say(`Sending as ${cfg.user} to ${tracesUrl(cfg.endpoint)}${cfg.enabled === false ? " (paused)" : ""}`);
  say(`Prompts and answers: ${cfg.capture.prompts ? "sent" : "not sent"}. Tool inputs and outputs: ${cfg.capture.tool_io ? "sent" : "not sent"}.`);
  for (const t of Object.values(TARGETS)) {
    let on = false;
    try { on = Object.values(readJsonFile(t.file()).hooks || {}).some((l) => Array.isArray(l) && l.some(isOurs)); } catch { /* unreadable */ }
    say(`- ${t.label}: ${on ? "connected" : "not connected"}`);
  }
  const outbox = join(dataDir(), "outbox");
  const waiting = existsSync(outbox) ? readdirSync(outbox).length : 0;
  if (waiting) say(`${waiting} turn(s) waiting to be sent.`);
}

/** Settings an administrator can roll out to every machine (managed settings), instead of each person installing. */
export function managedSnippet(harness, scriptPath = "/usr/local/lib/geo-trace/geo-trace.mjs") {
  const t = TARGETS[harness];
  if (!t) throw new Error("print-managed needs claude or codex");
  return JSON.stringify(mergeHooks({}, t.events, `node "${scriptPath}" hook ${harness}`), null, 2);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "hook") {
    // Never print, never fail: the session must not notice this ran.
    try {
      let raw = "";
      for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 8 * 1024 * 1024) break; }
      await runHook(rest[0], raw);
    } catch (err) { log(`hook error: ${err && err.message}`); }
    return 0;
  }
  const say = (m) => process.stdout.write(`${m}\n`);
  const a = args(rest);
  try {
    if (cmd === "install") await install(a, say);
    else if (cmd === "uninstall") uninstall(say);
    else if (cmd === "status") status(say);
    else if (cmd === "test") {
      const cfg = loadConfig();
      if (!cfg) throw new Error("Not installed. Run install first.");
      const s = await post(cfg, toOtlp(testTurn(cfg))).catch(() => 0);
      say(s >= 200 && s < 300 ? "A test turn was accepted. It appears under Traces." : `The test turn was not accepted (${s === 0 ? "server not reached" : `status ${s}`}).`);
      return s >= 200 && s < 300 ? 0 : 1;
    } else if (cmd === "import") return await importHistory(a, say);
    else if (cmd === "print-managed") say(managedSnippet(a._[0]));
    else {
      say("geo-trace: send Claude Code and Codex sessions to GEO Observability\n\n  install --endpoint <url> --key <ingest key> [--user <email>] [--tools claude,codex] [--no-content] [--tool-content]\n  status\n  test\n  import [--days 30] [--tools claude,codex] [--dry-run]   send sessions already on this machine\n  uninstall\n  print-managed <claude|codex>");
      return cmd ? 1 : 0;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
}

const invoked = () => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
};
if (invoked()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
