#!/usr/bin/env node
/**
 * geo-trace: sends Claude Code and Codex sessions to a GEO Observability workspace as traces.
 *
 *   node geo-trace.mjs install --endpoint <url> --key <ingest key> [--user you@company.com] [--tools claude,codex]
 *                              [--no-content] [--tool-content]
 *   node geo-trace.mjs status | test | uninstall | print-managed <claude|codex>
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
import { randomBytes } from "node:crypto";
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

export function loadConfig() {
  try {
    const c = JSON.parse(readFileSync(join(dataDir(), "config.json"), "utf8"));
    return { ...c, capture: { prompts: true, responses: true, tool_io: false, ...(c.capture || {}) } };
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
const hex = (bytes) => randomBytes(bytes).toString("hex");

// ------------------------------------------------------------------ capture (one hook event -> one stored line)

/** The fields kept from a hook event. Content the config switches off never reaches the disk. */
export function slimEvent(harness, d, cfg, now = Date.now()) {
  const name = d.hook_event_name || d.event || d.kind || "";
  const cap = cfg.capture;
  const e = { t: now, e: name, sid: d.session_id || d.thread_id || "" };
  for (const [from, to] of [["cwd", "cwd"], ["prompt_id", "pid"], ["turn_id", "pid"], ["transcript_path", "tp"], ["model", "model"], ["permission_mode", "pm"], ["agent_id", "aid"], ["agent_type", "atype"], ["tool_use_id", "tid"], ["tool_name", "tool"], ["request_id", "rid"]]) {
    if (typeof d[from] === "string" && d[from] && e[to] === undefined) e[to] = d[from];
  }
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
  return [...calls.values()].filter((c) => Number.isFinite(c.first)).sort((a, b) => a.first - b.first);
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
  const traceId = hex(16);
  const rootId = hex(8);
  const spans = [];
  const common = { "session.id": `${h.service}:${sid}`, "user.id": cfg.user || "unknown", "harness.name": h.service };

  const root = {
    id: rootId, parent: null, name: "turn", start: start.t, end: Math.max(stop ? stop.t : lastT, start.t), error: null,
    attrs: { "openinference.span.kind": "AGENT", "agent.name": h.service, ...common, ...(cwd ? { "project.name": basename(cwd) } : {}), ...(start.pid ? { "turn.id": start.pid } : {}), ...(start.pm ? { "permission.mode": start.pm } : {}), ...(model ? { "harness.model": model } : {}), ...(stop ? {} : { "turn.incomplete": true }) },
  };
  if (start.prompt !== undefined) root.attrs["input.value"] = start.prompt;
  if (stop && stop.answer !== undefined) root.attrs["output.value"] = stop.answer;
  spans.push(root);

  // Subagents: a span each, parent of everything that happened inside them.
  const agents = new Map();
  for (const e of events) {
    if (!e.aid) continue;
    let a = agents.get(e.aid);
    if (!a) { a = { id: hex(8), start: e.t, end: e.t, type: e.atype || "subagent", answer: undefined, atp: null }; agents.set(e.aid, a); }
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

  // Tool calls: a Pre and a Post event share a tool_use_id.
  const pre = new Map();
  for (const e of events) if (e.e === "PreToolUse" && e.tid) pre.set(e.tid, e);
  const done = new Set();
  for (const e of events) {
    if (e.e !== "PostToolUse" && e.e !== "PostToolUseFailure") continue;
    const p = e.tid ? pre.get(e.tid) : null;
    if (e.tid) done.add(e.tid);
    const s = p ? p.t : typeof e.dur === "number" ? e.t - e.dur : e.t;
    spans.push({ id: hex(8), parent: parentOf(e), name: e.tool || p?.tool || "tool", start: Math.min(s, e.t), end: e.t, error: e.e === "PostToolUseFailure" ? e.err || "The tool call failed." : null,
      attrs: { "openinference.span.kind": "TOOL", "tool.name": e.tool || p?.tool || "tool", ...common, ...(p && p.input !== undefined ? { "input.value": p.input, "input.mime_type": "application/json" } : {}), ...(e.output !== undefined ? { "output.value": e.output } : {}) } });
  }
  for (const [tid, p] of pre) {
    if (done.has(tid)) continue; // started but never reported back: interrupted or denied
    spans.push({ id: hex(8), parent: parentOf(p), name: p.tool || "tool", start: p.t, end: p.t, error: null,
      attrs: { "openinference.span.kind": "TOOL", "tool.name": p.tool || "tool", "tool.unfinished": true, ...common, ...(p.input !== undefined ? { "input.value": p.input } : {}) } });
  }

  // Model calls. Codex reports each request with its token counts; for Claude Code they come from the transcript.
  const llm = (parent, name, s, e2, mdl, usage, more = {}, error = null) => {
    const attrs = { "openinference.span.kind": "LLM", "llm.provider": h.provider, ...common, ...(mdl ? { "llm.model_name": mdl } : {}), ...more };
    if (usage) {
      attrs["llm.token_count.prompt"] = usage.prompt;
      attrs["llm.token_count.completion"] = usage.completion;
      attrs["llm.token_count.total"] = usage.prompt + usage.completion;
      if (usage.cacheRead) attrs["llm.token_count.prompt_details.cache_read"] = usage.cacheRead;
      if (usage.cacheWrite) attrs["llm.token_count.prompt_details.cache_write"] = usage.cacheWrite;
      if (usage.reasoning) attrs["llm.token_count.completion_details.reasoning"] = usage.reasoning;
    }
    spans.push({ id: hex(8), parent, name, start: Math.min(s, e2), end: e2, error, attrs });
  };
  const preReq = new Map();
  let prevT = start.t;
  for (const e of events) {
    if (e.e === "PreModelRequest" && e.rid) preReq.set(e.rid, e.t);
    if (e.e === "PostModelRequest") {
      const u = e.usage || null;
      const n = (x) => (typeof x === "number" && x >= 0 ? x : 0);
      const usage = u ? { prompt: n(u.input_tokens), completion: n(u.output_tokens), cacheRead: n(u.cached_input_tokens), cacheWrite: n(u.cache_write_input_tokens), reasoning: n(u.reasoning_output_tokens) } : null;
      llm(parentOf(e), "model request", (e.rid && preReq.get(e.rid)) || prevT, e.t, e.model || model, usage, {}, e.status === "failed" ? e.err || "The model request failed." : null);
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
      llm(parent, "model response", Math.min(prev, c.first), Math.max(c.last, prev), c.model || model, usage, more);
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
const kvs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([key, v]) => ({ key, value: anyValue(v) }));

/** OTLP/JSON body for one turn. */
export function toOtlp(turn) {
  return {
    resourceSpans: [{
      resource: { attributes: kvs({ "service.name": turn.service, "telemetry.sdk.name": "geo-trace", "telemetry.sdk.version": VERSION }) },
      scopeSpans: [{ scope: { name: "geo-trace", version: VERSION }, spans: turn.spans.map((s) => ({
        traceId: turn.traceId, spanId: s.id, ...(s.parent ? { parentSpanId: s.parent } : {}), name: s.name, kind: 1,
        startTimeUnixNano: `${Math.round(s.start)}000000`, endTimeUnixNano: `${Math.round(s.end)}000000`,
        attributes: kvs(s.attrs), status: s.error ? { code: 2, message: String(s.error) } : { code: 1 },
      })) }],
    }],
  };
}

// ------------------------------------------------------------------ sending

export const tracesUrl = (endpoint) => (/\/v1\/traces\/?$/.test(endpoint) ? endpoint : `${endpoint.replace(/\/+$/, "")}/v1/traces`);

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

async function flush(harness, cfg, _path, events) {
  if (!events.length) return;
  const start = events.find((e) => e.e === "UserPromptSubmit") || events[0];
  const extra = {};
  if (harness === "claude") {
    const tp = events.find((e) => e.tp)?.tp;
    extra.calls = readTranscript(tp, { promptId: start.pid, sinceMs: start.t });
    extra.agentCalls = {};
    for (const e of events) if (e.e === "SubagentStop" && e.aid && e.atp) extra.agentCalls[e.aid] = readTranscript(e.atp, {});
  }
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
  writePrivate(join(dataDir(), "config.json"), `${JSON.stringify(cfg, null, 2)}\n`);

  const want = String(a.tools || "claude,codex").split(",").map((s) => s.trim()).filter((s) => TARGETS[s]);
  const done = [];
  for (const name of want) {
    const t = TARGETS[name];
    if (!t.present() && !a.force) { say(`- ${t.label}: not found on this machine, skipped (use --force to set it up anyway)`); continue; }
    updateJsonFile(t.file(), (s) => mergeHooks(s, t.events, hookCommand(dest, name)));
    done.push(name);
    say(`- ${t.label}: connected (${t.file()})`);
  }
  say(`Sending as ${cfg.user} to ${tracesUrl(cfg.endpoint)}`);
  say(`Prompts and answers: ${cfg.capture.prompts ? "sent" : "not sent"}. Tool inputs and outputs: ${cfg.capture.tool_io ? "sent" : "not sent"}.`);
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
    } else if (cmd === "print-managed") say(managedSnippet(a._[0]));
    else {
      say("geo-trace: send Claude Code and Codex sessions to GEO Observability\n\n  install --endpoint <url> --key <ingest key> [--user <email>] [--tools claude,codex] [--no-content] [--tool-content]\n  status\n  test\n  uninstall\n  print-managed <claude|codex>");
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
