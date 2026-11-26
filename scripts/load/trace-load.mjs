#!/usr/bin/env node
/**
 * Load test for trace ingest: P people each send T turns shaped like real coding-tool turns
 * (one agent span, model calls, tool calls with names only), C requests at a time.
 *
 *   node scripts/load/trace-load.mjs --endpoint http://localhost:8787/ingest/otlp --key <ingest key> \
 *     [--people 50] [--turns 100] [--concurrency 8] [--prompt-chars 600] [--keys-file keys.txt]
 *
 * --keys-file gives one ingest key per line; person i sends with key i (mod the count), as with personal keys.
 *
 * Prints requests per second, latency percentiles and failures. Use a throwaway workspace: it writes real traces.
 */
import { randomBytes } from "node:crypto";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const endpoint = arg("endpoint");
const keysFile = arg("keys-file");
const keys = keysFile ? (await import("node:fs")).readFileSync(keysFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [];
const key = arg("key") || process.env.GEO_TRACE_KEY || keys[0];
const people = Number(arg("people", 50));
const turns = Number(arg("turns", 100));
const concurrency = Number(arg("concurrency", 8));
const promptChars = Number(arg("prompt-chars", 600));
if (!endpoint || !key) {
  console.error("usage: trace-load.mjs --endpoint <url>/ingest/otlp --key <ingest key> [--people 50] [--turns 100] [--concurrency 8]");
  process.exit(2);
}
const url = /\/v1\/traces$/.test(endpoint) ? endpoint : `${endpoint.replace(/\/+$/, "")}/v1/traces`;

const hex = (n) => randomBytes(n).toString("hex");
const kv = (k, v) => ({ key: k, value: typeof v === "number" ? { intValue: String(v) } : { stringValue: String(v) } });
const TOOLS = ["Read", "Edit", "Bash", "Grep", "Write", "Skill", "mcp__github__get_issue"];

function turnBody(person, day, n) {
  const traceId = hex(16);
  const root = hex(8);
  const t0 = day + n * 120_000;
  const common = [kv("harness.name", "claude-code"), kv("user.id", `person${person}@load.test`), kv("session.id", `s-${person}-${Math.floor(n / 10)}`), kv("project.name", `repo-${person % 7}`)];
  const spans = [{ traceId, spanId: root, name: "turn", startTimeUnixNano: `${t0}000000`, endTimeUnixNano: `${t0 + 60_000}000000`,
    attributes: [kv("openinference.span.kind", "AGENT"), kv("input.value", "p".repeat(promptChars)), kv("output.value", "a".repeat(promptChars * 2)), ...common], status: { code: 1 } }];
  for (let i = 0; i < 5; i++) spans.push({ traceId, spanId: hex(8), parentSpanId: root, name: "model", startTimeUnixNano: `${t0 + i * 10_000}000000`, endTimeUnixNano: `${t0 + i * 10_000 + 4000}000000`,
    attributes: [kv("openinference.span.kind", "LLM"), kv("llm.model_name", "claude-opus-5-5"), kv("llm.token_count.prompt", 20_000), kv("llm.token_count.completion", 800), kv("llm.token_count.total", 20_800), ...common], status: { code: 1 } });
  for (let i = 0; i < 10; i++) spans.push({ traceId, spanId: hex(8), parentSpanId: root, name: TOOLS[i % TOOLS.length], startTimeUnixNano: `${t0 + i * 5000}000000`, endTimeUnixNano: `${t0 + i * 5000 + 900}000000`,
    attributes: [kv("openinference.span.kind", "TOOL"), kv("tool.name", TOOLS[i % TOOLS.length]), ...common], status: { code: 1 } });
  return JSON.stringify({ resourceSpans: [{ resource: { attributes: [kv("service.name", "claude-code")] }, scopeSpans: [{ spans }] }] });
}

const jobs = [];
const day = Date.now() - 86_400_000;
for (let p = 0; p < people; p++) for (let n = 0; n < turns; n++) jobs.push([p, n]);
const lat = [];
const fails = new Map();
let bytes = 0;
const started = performance.now();
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const [p, n] = jobs[next++];
    const body = turnBody(p, day, n);
    bytes += body.length;
    const t = performance.now();
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-ingest-key": keys.length ? keys[p % keys.length] : key }, body });
      await res.arrayBuffer();
      if (!res.ok) fails.set(res.status, (fails.get(res.status) || 0) + 1);
    } catch (err) {
      fails.set(String(err.cause?.code || err.name), (fails.get(String(err.cause?.code || err.name)) || 0) + 1);
    }
    lat.push(performance.now() - t);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
const secs = (performance.now() - started) / 1000;
lat.sort((a, b) => a - b);
const pct = (q) => Math.round(lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]);
const spans = jobs.length * 16;
console.log(JSON.stringify({
  people, turns_each: turns, requests: jobs.length, spans, seconds: Math.round(secs * 10) / 10,
  requests_per_second: Math.round(jobs.length / secs), spans_per_second: Math.round(spans / secs),
  latency_ms: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) }, request_mb: Math.round(bytes / 1e5) / 10,
  failures: Object.fromEntries(fails),
}, null, 2));
process.exit(fails.size ? 1 : 0);
