/** The workspace's capture level for coding tools, enforced at ingest whatever a machine is set to send. */
import type { TenantDB } from "../lib/db";
import type { Attrs, OtlpSpan } from "./otlp";
import { redact } from "./redact";

export type Capture = "full" | "prompts" | "metadata";
export const CAPTURES: Capture[] = ["full", "prompts", "metadata"];

export async function getCapture(tdb: TenantDB): Promise<Capture> {
  const row = await tdb.first<{ capture: string }>("SELECT capture FROM trace_settings WHERE tenant_id = ?1");
  return CAPTURES.includes(row?.capture as Capture) ? (row!.capture as Capture) : "full";
}

export async function setCapture(tdb: TenantDB, capture: Capture, by: string): Promise<void> {
  await tdb.run(
    `INSERT INTO trace_settings (tenant_id, capture, updated_by) VALUES (?1, ?2, ?3)
     ON CONFLICT (tenant_id) DO UPDATE SET capture = excluded.capture, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    capture,
    by,
  );
}

const CONTENT = /^(input\.value|output\.value|input\.mime_type|output\.mime_type|llm\.(input|output)_messages\.|llm\.prompts?\.|tool\.parameters$|gen_ai\.(prompt|completion)|gen_ai\.(input|output)\.messages)/;
const TOOL_ARGS = /\.tool_call\.function\.arguments$/;

function strip(attrs: Attrs, all: boolean): Attrs {
  const out: Attrs = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (all ? CONTENT.test(k) || TOOL_ARGS.test(k) : false) continue;
    out[k] = v;
  }
  return out;
}

const redactAll = (attrs: Attrs): Attrs => Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, typeof v === "string" ? redact(v) : v]));

/**
 * Applies the capture level to coding-tool spans (those carrying harness.name) and redacts secrets in every span.
 * prompts: a tool step keeps its name and timing but loses its input and output. metadata: no text at all.
 */
export function applyPolicy(span: OtlpSpan, capture: Capture): OtlpSpan {
  let attrs = span.attributes;
  if (typeof attrs["harness.name"] === "string" && capture !== "full") {
    const isTool = attrs["openinference.span.kind"] === "TOOL";
    if (capture === "metadata" || isTool) attrs = strip(attrs, true);
  }
  const quiet = capture === "metadata" && typeof span.attributes["harness.name"] === "string";
  return {
    ...span,
    attributes: redactAll(attrs),
    statusMessage: span.statusMessage == null ? null : quiet ? "" : redact(span.statusMessage),
    events: span.events.map((e) => ({ ...e, attributes: quiet ? {} : redactAll(e.attributes) })),
  };
}
