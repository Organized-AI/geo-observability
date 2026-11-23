/**
 * Reading meaning out of span attributes.
 *
 * The primary vocabulary is OpenInference (an open convention: `openinference.span.kind`, `llm.*`, `input.value`,
 * `retrieval.documents.*`, ...). OpenTelemetry's `gen_ai.*` names are read as a fallback so apps instrumented
 * either way show up with a model, token counts and messages.
 */
import type { Attrs, AttrValue } from "./otlp";

export const SPAN_KINDS = ["LLM", "CHAIN", "AGENT", "TOOL", "RETRIEVER", "EMBEDDING", "RERANKER", "GUARDRAIL", "EVALUATOR", "PROMPT", "DECISION", "UNKNOWN"] as const;
export type SpanKind = (typeof SPAN_KINDS)[number];

export interface SpanFacts {
  kind: SpanKind;
  model: string | null;
  provider: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costMicros: number | null;
  sessionId: string | null;
  userId: string | null;
  input: string | null;
  output: string | null;
}

const str = (v: AttrValue | undefined): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
};
const num = (v: AttrValue | undefined): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const first = <T>(...vals: (T | null)[]): T | null => {
  for (const v of vals) if (v !== null) return v;
  return null;
};
const count = (v: number | null) => (v === null || v < 0 ? null : Math.round(v));

const GEN_AI_KIND: Record<string, SpanKind> = {
  chat: "LLM",
  text_completion: "LLM",
  generate_content: "LLM",
  embeddings: "EMBEDDING",
  execute_tool: "TOOL",
  invoke_agent: "AGENT",
  create_agent: "AGENT",
};

export function spanKind(a: Attrs): SpanKind {
  const oi = str(a["openinference.span.kind"])?.toUpperCase();
  if (oi && (SPAN_KINDS as readonly string[]).includes(oi)) return oi as SpanKind;
  const op = str(a["gen_ai.operation.name"])?.toLowerCase();
  if (op && GEN_AI_KIND[op]) return GEN_AI_KIND[op];
  if (a["gen_ai.request.model"] !== undefined || a["gen_ai.response.model"] !== undefined) return "LLM";
  return "UNKNOWN";
}

/**
 * Flattened list attributes (`llm.input_messages.0.message.role`) back into nested objects.
 * Returns the items under `prefix`, in index order.
 */
export function unflattenList(a: Attrs, prefix: string): Record<string, AttrValue>[] {
  const head = `${prefix}.`;
  const items = new Map<number, Record<string, AttrValue>>();
  for (const [key, value] of Object.entries(a)) {
    if (!key.startsWith(head)) continue;
    const rest = key.slice(head.length);
    const dot = rest.indexOf(".");
    const index = Number(dot < 0 ? rest : rest.slice(0, dot));
    if (!Number.isInteger(index) || index < 0 || index > 999) continue;
    const item = items.get(index) ?? {};
    items.set(index, item);
    if (dot >= 0) item[rest.slice(dot + 1)] = value;
  }
  return [...items.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => v);
}

export interface ToolCall {
  id: string | null;
  name: string | null;
  arguments: string | null;
}
export interface Message {
  role: string;
  content: string | null;
  name: string | null;
  tool_call_id: string | null;
  tool_calls: ToolCall[];
}

function messageFrom(item: Record<string, AttrValue>): Message {
  let content = str(item["message.content"]);
  if (content === null) {
    // Multi-part content: join the text parts and name the others.
    const parts = unflattenList(item as Attrs, "message.contents");
    const texts = parts.map((p) => {
      const type = str(p["message_content.type"]) ?? "text";
      if (type === "text" || type === "reasoning") return str(p["message_content.text"]) ?? "";
      return `[${type}]`;
    });
    content = texts.filter(Boolean).join("\n") || null;
  }
  const tool_calls = unflattenList(item as Attrs, "message.tool_calls").map((t) => ({
    id: str(t["tool_call.id"]),
    name: str(t["tool_call.function.name"]),
    arguments: str(t["tool_call.function.arguments"]),
  }));
  return { role: str(item["message.role"]) ?? "unknown", content, name: str(item["message.name"]), tool_call_id: str(item["message.tool_call_id"]), tool_calls };
}

/** `gen_ai.input.messages` style: a JSON array of { role, parts: [{ type, content }] } or { role, content }. */
function genAiMessages(v: AttrValue | undefined): Message[] {
  let list: unknown = v;
  if (typeof v === "string") {
    try {
      list = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: Message[] = [];
  for (const m of list.slice(0, 200)) {
    if (typeof m !== "object" || m === null) continue;
    const o = m as Record<string, unknown>;
    const parts = Array.isArray(o.parts) ? (o.parts as Record<string, unknown>[]) : [];
    const text = typeof o.content === "string" ? o.content : parts.filter((p) => p && p.type === "text" && typeof p.content === "string").map((p) => p.content as string).join("\n");
    const tool_calls = parts
      .filter((p) => p && p.type === "tool_call")
      .map((p) => ({ id: typeof p.id === "string" ? p.id : null, name: typeof p.name === "string" ? p.name : null, arguments: p.arguments === undefined ? null : typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments) }));
    out.push({ role: typeof o.role === "string" ? o.role : "unknown", content: text || null, name: null, tool_call_id: null, tool_calls });
  }
  return out;
}

export function messages(a: Attrs, side: "input" | "output"): Message[] {
  const oi = unflattenList(a, `llm.${side}_messages`).map(messageFrom);
  if (oi.length) return oi;
  return genAiMessages(a[`gen_ai.${side}.messages`]);
}

export interface ToolDef {
  name: string | null;
  description: string | null;
  schema: string | null;
}
export function tools(a: Attrs): ToolDef[] {
  return unflattenList(a, "llm.tools").map((t) => {
    const schema = str(t["tool.json_schema"]);
    let name = str(t["tool.name"]);
    let description = str(t["tool.description"]);
    if (schema && (!name || !description)) {
      try {
        const parsed = JSON.parse(schema) as { name?: string; description?: string; function?: { name?: string; description?: string } };
        name = name ?? parsed.function?.name ?? parsed.name ?? null;
        description = description ?? parsed.function?.description ?? parsed.description ?? null;
      } catch {
        /* keep what we have */
      }
    }
    return { name, description, schema };
  });
}

export interface RetrievedDocument {
  id: string | null;
  content: string | null;
  score: number | null;
  metadata: string | null;
}
export function documents(a: Attrs): RetrievedDocument[] {
  return unflattenList(a, "retrieval.documents").map((d) => ({
    id: str(d["document.id"]),
    content: str(d["document.content"]),
    score: num(d["document.score"]),
    metadata: str(d["document.metadata"]),
  }));
}

function lastContent(list: Message[], role?: string): string | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]!;
    if (role && m.role !== role) continue;
    if (m.content) return m.content;
    if (m.tool_calls.length) return m.tool_calls.map((t) => `${t.name ?? "tool"}(${t.arguments ?? ""})`).join("\n");
  }
  return null;
}

export function spanFacts(a: Attrs): SpanFacts {
  const kind = spanKind(a);
  const promptTokens = count(first(num(a["llm.token_count.prompt"]), num(a["gen_ai.usage.input_tokens"]), num(a["gen_ai.usage.prompt_tokens"])));
  const completionTokens = count(first(num(a["llm.token_count.completion"]), num(a["gen_ai.usage.output_tokens"]), num(a["gen_ai.usage.completion_tokens"])));
  const total = count(first(num(a["llm.token_count.total"]), num(a["gen_ai.usage.total_tokens"])));
  const totalTokens = total ?? (promptTokens !== null || completionTokens !== null ? (promptTokens ?? 0) + (completionTokens ?? 0) : null);
  const cost = num(a["llm.cost.total"]);

  let input = str(a["input.value"]);
  let output = str(a["output.value"]);
  if (input === null) {
    const msgs = messages(a, "input");
    input = lastContent(msgs, "user") ?? lastContent(msgs);
  }
  if (output === null) output = lastContent(messages(a, "output"));
  if (input === null && kind === "TOOL") input = str(a["tool.parameters"]);
  if (input === null && kind === "EMBEDDING") input = str(a["embedding.embeddings.0.embedding.text"]);

  return {
    kind,
    model: first(str(a["llm.model_name"]), str(a["gen_ai.response.model"]), str(a["gen_ai.request.model"]), str(a["embedding.model_name"]), str(a["reranker.model_name"])),
    provider: first(str(a["llm.provider"]), str(a["llm.system"]), str(a["gen_ai.provider.name"]), str(a["gen_ai.system"])),
    promptTokens,
    completionTokens,
    totalTokens,
    costMicros: cost === null || cost < 0 ? null : Math.round(cost * 1_000_000),
    sessionId: first(str(a["session.id"]), str(a["gen_ai.conversation.id"])),
    userId: str(a["user.id"]),
    input,
    output,
  };
}
