/** Full span bodies kept in R2 when they are too large for the row (see store.ts). */
import type { Env } from "../env";
import type { TenantDB } from "../lib/db";
import { chunk } from "../lib/util";
import type { Attrs } from "./otlp";
import { tracePrefix } from "./store";

export interface SpanBody {
  input: string | null;
  output: string | null;
  attributes: Attrs;
  events: unknown[];
}

export async function readBody(env: Pick<Env, "ANSWERS">, key: string | null | undefined, tenantId: string): Promise<SpanBody | null> {
  // A key always starts with this workspace's prefix; anything else is never read.
  if (!key || !key.startsWith(`traces/${tenantId}/`) || !env.ANSWERS) return null;
  const obj = await env.ANSWERS.get(key);
  if (!obj) return null;
  try {
    return (await obj.json()) as SpanBody;
  } catch {
    return null;
  }
}

/** Deletes the R2 bodies of these traces (every version under each trace's prefix). */
export async function deleteBodies(env: Pick<Env, "ANSWERS">, tdb: TenantDB, traceIds: string[]): Promise<void> {
  if (!env.ANSWERS || !traceIds.length) return;
  for (const ids of chunk(traceIds, 40)) {
    const marks = ids.map((_, i) => `?${i + 2}`).join(", ");
    const withBodies = await tdb.all<{ trace_id: string }>(`SELECT DISTINCT trace_id FROM llm_spans WHERE tenant_id = ?1 AND body_key IS NOT NULL AND trace_id IN (${marks})`, ...ids);
    for (const { trace_id } of withBodies) {
      let cursor: string | undefined;
      do {
        const list = await env.ANSWERS.list({ prefix: tracePrefix(tdb.tenantId, trace_id), cursor });
        if (list.objects.length) await env.ANSWERS.delete(list.objects.map((o) => o.key));
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
    }
  }
}
