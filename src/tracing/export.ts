/** Exports for keeping a local copy: a CSV summary, and full traces with every span as JSON Lines. */
import type { TenantDB } from "../lib/db";
import { parseJson, toCsv } from "../lib/util";
import { listPeople, listTraces, type TraceFilters } from "./query";

export const CSV_MAX_TRACES = 50_000;
export const JSONL_MAX_TRACES = 10_000;
const PAGE = 200;

const iso = (ms: unknown) => (typeof ms === "number" ? new Date(ms).toISOString() : "");
const usd = (micros: unknown) => (typeof micros === "number" && micros > 0 ? (micros / 1_000_000).toFixed(6) : "");

const TRACE_CSV = ["started_at", "app", "name", "kind", "status", "user", "session", "latency_ms", "spans", "model_calls", "errors", "prompt_tokens", "completion_tokens", "total_tokens", "cost_usd", "model", "trace_id", "input", "output"];

/** One row per trace for the same filters as the list, newest first. */
export async function tracesCsv(tdb: TenantDB, f: TraceFilters): Promise<{ csv: string; truncated: boolean }> {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  let more = true;
  while (more && rows.length < CSV_MAX_TRACES) {
    const page = await listTraces(tdb, { ...f, limit: PAGE, cursor });
    for (const t of page.items as Record<string, unknown>[]) {
      rows.push({
        started_at: iso(t.start_ms), app: t.app, name: t.name, kind: t.kind, status: t.status, user: t.user_id, session: t.session_id, latency_ms: t.latency_ms,
        spans: t.span_count, model_calls: t.llm_count, errors: t.error_count, prompt_tokens: t.prompt_tokens, completion_tokens: t.completion_tokens,
        total_tokens: t.total_tokens, cost_usd: usd(t.cost_micros), model: t.model, trace_id: t.trace_id, input: t.input_preview, output: t.output_preview,
      });
    }
    cursor = page.next_cursor ?? undefined;
    more = !!cursor;
  }
  return { csv: toCsv(rows.slice(0, CSV_MAX_TRACES), TRACE_CSV), truncated: more };
}

export async function peopleCsv(tdb: TenantDB, f: Pick<TraceFilters, "appId" | "fromMs" | "toMs">): Promise<string> {
  const rows = (await listPeople(tdb, { ...f, limit: 5000 })) as Record<string, unknown>[];
  return toCsv(
    rows.map((p) => ({ person: p.user_id, tools: String(p.apps ?? "").split(",").filter(Boolean).sort().join(" "), sessions: p.sessions, turns: p.traces, active_days: p.active_days, prompt_tokens: p.prompt_tokens, completion_tokens: p.completion_tokens, total_tokens: p.total_tokens, cost_usd: usd(p.cost_micros), errors: p.errors, last_active_at: iso(p.last_active_ms) })),
    ["person", "tools", "sessions", "turns", "active_days", "prompt_tokens", "completion_tokens", "total_tokens", "cost_usd", "errors", "last_active_at"],
  );
}

interface SpanRow {
  trace_id: string;
  attributes: string;
  events: string;
  truncated: number;
  [k: string]: unknown;
}

/**
 * Full traces as JSON Lines: one trace per line with all of its spans, attributes and events.
 * Streamed a page at a time so a large export never sits in memory.
 */
export function tracesJsonl(tdb: TenantDB, f: TraceFilters): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let cursor: string | undefined;
  let sent = 0;
  let done = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) {
        controller.close();
        return;
      }
      try {
        const page = await listTraces(tdb, { ...f, limit: 25, cursor });
        const traces = (page.items as unknown as { trace_id: string; start_ms: number; end_ms: number }[]).slice(0, JSONL_MAX_TRACES - sent);
        const spansByTrace = new Map<string, unknown[]>();
        if (traces.length) {
          const marks = traces.map((_, i) => `?${i + 2}`).join(", ");
          const spans = await tdb.all<SpanRow>(
            `SELECT trace_id, span_id, parent_span_id, name, kind, status_code, status_message, start_ms, end_ms, model, provider,
                    prompt_tokens, completion_tokens, total_tokens, cost_micros, session_id, user_id, attributes, events, truncated
             FROM llm_spans WHERE tenant_id = ?1 AND trace_id IN (${marks}) ORDER BY trace_id, start_ms, span_id`,
            ...traces.map((t) => t.trace_id),
          );
          for (const s of spans) {
            const { trace_id, attributes, events, truncated, ...rest } = s;
            const list = spansByTrace.get(trace_id) ?? [];
            list.push({ ...rest, truncated: truncated === 1, attributes: parseJson(attributes, {}), events: parseJson(events, []) });
            spansByTrace.set(trace_id, list);
          }
        }
        let out = "";
        for (const t of traces) out += `${JSON.stringify({ ...t, started_at: iso(t.start_ms), ended_at: iso(t.end_ms), spans: spansByTrace.get(t.trace_id) ?? [] })}\n`;
        sent += traces.length;
        cursor = page.next_cursor ?? undefined;
        if (!cursor || sent >= JSONL_MAX_TRACES) done = true;
        if (out) controller.enqueue(enc.encode(out));
        else if (done) controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
