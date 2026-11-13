import type { Env } from "../env";
import { TenantDB } from "../lib/db";
import { HttpError, parseJson } from "../lib/util";
import { resolveKey } from "../observability/ingest";
import { rateLimit, brandReport, filtersFrom } from "../routes/v1";
import { chats, domainReport, loadBrands } from "../metrics/report";
import { pagesReport } from "../observability/pages";

/**
 * A small MCP server over streamable HTTP (JSON responses, no SSE), so Claude, Cursor and other MCP
 * clients can read a client's visibility data. Read-only; auth is a bearer API key with scope "read".
 */
const PROTOCOL = "2025-06-18";

const dateProps = {
  start_date: { type: "string", description: "YYYY-MM-DD, default 14 days ago" },
  end_date: { type: "string", description: "YYYY-MM-DD, default today" },
};

export const TOOLS = [
  { name: "list_projects", description: "List the projects (brands being tracked) in this workspace.", inputSchema: { type: "object", properties: {} } },
  {
    name: "brand_report",
    description: "Visibility, share of voice, average position and sentiment per brand, optionally broken down by date, engine, country, topic or prompt.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" }, ...dateProps, dimensions: { type: "array", items: { type: "string", enum: ["date", "engine", "country", "topic", "prompt"] } }, engines: { type: "array", items: { type: "string" } } },
      required: ["project_id"],
    },
  },
  {
    name: "list_chats",
    description: "Recent AI answers to tracked prompts, with the brands each one named, newest first.",
    inputSchema: { type: "object", properties: { project_id: { type: "string" }, ...dateProps, mentioned: { type: "string", enum: ["own", "not_own"] }, limit: { type: "number" } }, required: ["project_id"] },
  },
  {
    name: "get_chat",
    description: "One AI answer in full, with its citations and the searches the engine ran.",
    inputSchema: { type: "object", properties: { project_id: { type: "string" }, run_id: { type: "string" } }, required: ["project_id", "run_id"] },
  },
  {
    name: "top_sources",
    description: "Domains AI answers cite most. Set gaps to true for domains that feed answers naming competitors but not the client.",
    inputSchema: { type: "object", properties: { project_id: { type: "string" }, ...dateProps, gaps: { type: "boolean" } }, required: ["project_id"] },
  },
  { name: "list_insights", description: "The latest plain-language insights about what changed.", inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] } },
  { name: "list_actions", description: "Open recommended actions, highest impact first.", inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] } },
  {
    name: "website_pages",
    description: "Per page on the client's site: citations in AI answers, AI crawler hits, AI-referred sessions, conversions and revenue.",
    inputSchema: { type: "object", properties: { project_id: { type: "string" }, ...dateProps }, required: ["project_id"] },
  },
];

type Args = Record<string, unknown>;

async function callTool(env: Env, tdb: TenantDB, name: string, a: Args): Promise<unknown> {
  const range = { start_date: a.start_date as string | undefined, end_date: a.end_date as string | undefined };
  if (name === "list_projects") return tdb.all("SELECT id, name, domain FROM projects WHERE tenant_id = ?1 ORDER BY created_at");
  const project = await tdb.project(String(a.project_id ?? ""));
  switch (name) {
    case "brand_report":
      return brandReport(tdb, {
        project_id: project.id,
        ...range,
        dimensions: Array.isArray(a.dimensions) ? (a.dimensions as string[]) : [],
        filters: Array.isArray(a.engines) && a.engines.length ? [{ field: "engine", operator: "in", values: a.engines as string[] }] : [],
      });
    case "list_chats": {
      const own = (await loadBrands(tdb, project.id)).find((b) => b.isOwn);
      const res = await chats(tdb, project.id, filtersFrom(range), {
        ownBrandId: own?.id ?? null,
        mentioned: a.mentioned === "own" || a.mentioned === "not_own" ? a.mentioned : undefined,
        limit: Math.min(Number(a.limit ?? 20), 50),
      });
      return res.items;
    }
    case "get_chat": {
      const run = await tdb.first<{ r2_key: string | null }>(
        "SELECT id, engine, model, country, run_date, channel, r2_key FROM runs WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3",
        project.id,
        String(a.run_id ?? ""),
      );
      if (!run) throw new HttpError(404, "not_found", "Chat not found");
      const obj = run.r2_key ? await env.ANSWERS.get(run.r2_key) : null;
      const stored = obj ? parseJson<{ text?: string; prompt?: string; citations?: unknown; fanout?: unknown }>(await obj.text(), {}) : {};
      const { r2_key: _k, ...rest } = run;
      return { ...rest, prompt: stored.prompt, answer: stored.text, citations: stored.citations, searches: stored.fanout };
    }
    case "top_sources":
      return domainReport(tdb, project.id, filtersFrom(range), await loadBrands(tdb, project.id), { gap: a.gaps === true, limit: 50 });
    case "list_insights":
      return tdb.all(
        "SELECT day, kind, severity, text FROM insights WHERE tenant_id = ?1 AND project_id = ?2 ORDER BY day DESC, severity DESC LIMIT 15",
        project.id,
      );
    case "list_actions":
      return tdb.all(
        "SELECT id, kind, title, detail, impact, status FROM actions WHERE tenant_id = ?1 AND project_id = ?2 AND status IN ('open','in_progress') ORDER BY impact DESC LIMIT 20",
        project.id,
      );
    case "website_pages": {
      const f = filtersFrom(range);
      const own = (await loadBrands(tdb, project.id)).find((b) => b.isOwn);
      return (await pagesReport(tdb, project.id, f.from, f.to, own)).items.slice(0, 100);
    }
    default:
      throw new HttpError(400, "unknown_tool", `Unknown tool ${name}`);
  }
}

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: RpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: RpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export async function handleMcp(req: Request, env: Env): Promise<Response> {
  if (req.method === "GET") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  let tdb: TenantDB;
  try {
    const key = await resolveKey(env, bearer || null, ["read"]);
    await rateLimit(env, key.keyId);
    tdb = new TenantDB(env.DB, key.tenantId);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 401;
    return Response.json(rpcError(null, -32001, (e as Error).message), { status, headers: { "www-authenticate": 'Bearer realm="geo-observability"' } });
  }
  let payload: RpcRequest | RpcRequest[];
  try {
    payload = (await req.json()) as RpcRequest | RpcRequest[];
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  const batch = Array.isArray(payload) ? payload : [payload];
  const out: unknown[] = [];
  for (const msg of batch) {
    if (msg.id === undefined) continue; // notifications (e.g. notifications/initialized) get no response
    try {
      switch (msg.method) {
        case "initialize":
          out.push(
            rpcResult(msg.id, {
              protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "geo-observability", version: "1.0.0" },
              instructions: "Read-only access to AI search visibility data for this workspace. Call list_projects first to get a project_id.",
            }),
          );
          break;
        case "ping":
          out.push(rpcResult(msg.id, {}));
          break;
        case "tools/list":
          out.push(rpcResult(msg.id, { tools: TOOLS }));
          break;
        case "tools/call": {
          const name = String(msg.params?.name ?? "");
          const args = (msg.params?.arguments ?? {}) as Args;
          try {
            const data = await callTool(env, tdb, name, args);
            out.push(rpcResult(msg.id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: { data } }));
          } catch (e) {
            out.push(rpcResult(msg.id, { content: [{ type: "text", text: (e as Error).message }], isError: true }));
          }
          break;
        }
        default:
          out.push(rpcError(msg.id, -32601, `Method not found: ${msg.method}`));
      }
    } catch (e) {
      out.push(rpcError(msg.id, -32603, (e as Error).message));
    }
  }
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(payload) ? out : out[0], { headers: { "mcp-protocol-version": PROTOCOL } });
}
