import { describe, expect, it } from "vitest";
import { decodeJson, decodeProtobuf, exportResponse, readExport } from "../src/tracing/otlp";
import { documents, messages, spanFacts, spanKind, tools, unflattenList } from "../src/tracing/openinference";
import { HttpError } from "../src/lib/util";
import { b64ToBytes, OTLP_JSON, OTLP_PROTOBUF_B64, OTLP_PROTOBUF_GZIP_B64 } from "./fixtures/otlp";

const TRACE = "0af7651916cd43dd8448eb211c80319c";

describe("OTLP decoding", () => {
  it("decodes a protobuf export written by the official encoder", () => {
    const spans = decodeProtobuf(b64ToBytes(OTLP_PROTOBUF_B64));
    expect(spans).toHaveLength(3);
    const [root, llm, tool] = spans;
    expect(root).toMatchObject({ traceId: TRACE, spanId: "b7ad6b7169203331", parentSpanId: null, name: "answer_question", startMs: 1763900000000, endMs: 1763900002500, statusCode: "OK" });
    expect(root!.resource).toEqual({ "service.name": "support-bot", "openinference.project.name": "support-bot-prod" });
    expect(root!.attributes["tag.tags"]).toEqual(["prod", "beta"]);
    expect(root!.attributes.nested).toEqual({ depth: -3, ok: true });
    expect(llm).toMatchObject({ spanId: "00f067aa0ba902b7", parentSpanId: "b7ad6b7169203331", name: "ChatCompletion", statusCode: "UNSET", statusMessage: null });
    expect(llm!.attributes["llm.token_count.prompt"]).toBe(812);
    expect(llm!.attributes["llm.cost.total"]).toBeCloseTo(0.001234, 9);
    expect(llm!.events).toEqual([{ name: "first_token", time_ms: 1763900000400, attributes: { n: 1 } }]);
    expect(tool).toMatchObject({ name: "search_docs", statusCode: "ERROR", statusMessage: "index timeout" });
  });

  it("gives the same spans from JSON as from protobuf", () => {
    expect(decodeJson(OTLP_JSON)).toEqual(decodeProtobuf(b64ToBytes(OTLP_PROTOBUF_B64)));
  });

  it("accepts hex ids, numeric status codes and string enums in JSON", () => {
    const spans = decodeJson({
      resourceSpans: [{ scopeSpans: [{ spans: [
        { traceId: TRACE.toUpperCase(), spanId: "00F067AA0BA902B7", name: "a", startTimeUnixNano: "1763900000000000000", endTimeUnixNano: 1763900001000000000, status: { code: 2, message: "boom" } },
        { traceId: TRACE, spanId: "00f067aa0ba902b8", name: "b", status: { code: "STATUS_CODE_OK" }, attributes: [{ key: "n", value: { intValue: "42" } }, { key: "f", value: { doubleValue: 1.5 } }] },
      ] }] }],
    });
    expect(spans[0]).toMatchObject({ traceId: TRACE, spanId: "00f067aa0ba902b7", startMs: 1763900000000, endMs: 1763900001000, statusCode: "ERROR", statusMessage: "boom" });
    expect(spans[1]).toMatchObject({ statusCode: "OK", attributes: { n: 42, f: 1.5 } });
  });

  it("reads gzip bodies and picks the decoder from the content type", async () => {
    const gz = await readExport(new Request("https://geo.test/x", { method: "POST", headers: { "content-type": "application/x-protobuf", "content-encoding": "gzip" }, body: b64ToBytes(OTLP_PROTOBUF_GZIP_B64) }));
    expect(gz.encoding).toBe("protobuf");
    expect(gz.spans).toHaveLength(3);
    const js = await readExport(new Request("https://geo.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OTLP_JSON) }));
    expect(js.encoding).toBe("json");
    expect(js.spans).toEqual(gz.spans);
  });

  it("answers bad input with a 4xx and a plain message", async () => {
    const attempt = async (headers: Record<string, string>, body: BodyInit) => {
      try {
        await readExport(new Request("https://geo.test/x", { method: "POST", headers, body }));
        return 200;
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).message).not.toMatch(/undefined|TypeError|RangeError/);
        return (err as HttpError).status;
      }
    };
    expect(await attempt({ "content-type": "text/plain" }, "hello")).toBe(415);
    expect(await attempt({ "content-type": "application/json" }, "{not json")).toBe(400);
    expect(await attempt({ "content-type": "application/json" }, "[1,2]")).toBe(400);
    expect(await attempt({ "content-type": "application/x-protobuf", "content-encoding": "gzip" }, "not gzip at all")).toBe(400);
    expect(await attempt({ "content-type": "application/x-protobuf", "content-encoding": "br" }, "x")).toBe(415);
    // Truncated protobuf: the first half of a valid message.
    const half = b64ToBytes(OTLP_PROTOBUF_B64).slice(0, 200);
    expect(await attempt({ "content-type": "application/x-protobuf" }, half)).toBe(400);
    // Random bytes must never throw anything but an HttpError.
    for (let seed = 1; seed <= 40; seed++) {
      const junk = Uint8Array.from({ length: 64 }, (_, i) => (seed * 131 + i * 73 + ((seed * i) % 7) * 29) % 256);
      expect([200, 400]).toContain(await attempt({ "content-type": "application/x-protobuf" }, junk));
    }
  });

  it("writes an OTLP response in the caller's encoding", async () => {
    expect(await exportResponse("json", 0, "").json()).toEqual({});
    expect(await exportResponse("json", 3, "too many").json()).toEqual({ partialSuccess: { rejectedSpans: "3", errorMessage: "too many" } });
    expect((await exportResponse("protobuf", 0, "").arrayBuffer()).byteLength).toBe(0);
    // partial_success { rejected_spans: 300, error_message: "x" } = 0a 06 08 ac 02 12 01 78
    expect([...new Uint8Array(await exportResponse("protobuf", 300, "x").arrayBuffer())]).toEqual([0x0a, 0x06, 0x08, 0xac, 0x02, 0x12, 0x01, 0x78]);
  });
});

describe("attribute reading", () => {
  const [root, llm] = decodeProtobuf(b64ToBytes(OTLP_PROTOBUF_B64));

  it("reads OpenInference facts", () => {
    expect(spanFacts(root!.attributes)).toMatchObject({ kind: "AGENT", sessionId: "sess-42", userId: "user-7", input: "How do I reset my password?", output: "Open Settings, then Security.", model: null, totalTokens: null });
    expect(spanFacts(llm!.attributes)).toMatchObject({ kind: "LLM", model: "gpt-5-mini", provider: "openai", promptTokens: 812, completionTokens: 96, totalTokens: 908, costMicros: 1234 });
  });

  it("falls back to messages for input and output", () => {
    const f = spanFacts(llm!.attributes);
    expect(f.input).toBe("How do I reset my password?");
    expect(f.output).toBe('search_docs({"q":"reset password"})');
  });

  it("rebuilds messages, tools and documents from flattened keys", () => {
    expect(messages(llm!.attributes, "input")).toEqual([
      { role: "system", content: "You are a support agent.", name: null, tool_call_id: null, tool_calls: [] },
      { role: "user", content: "How do I reset my password?", name: null, tool_call_id: null, tool_calls: [] },
    ]);
    expect(messages(llm!.attributes, "output")[0]!.tool_calls).toEqual([{ id: null, name: "search_docs", arguments: '{"q":"reset password"}' }]);
    const a = {
      "llm.tools.0.tool.json_schema": '{"type":"function","function":{"name":"lookup","description":"Find an order"}}',
      "retrieval.documents.1.document.content": "second",
      "retrieval.documents.0.document.content": "first",
      "retrieval.documents.0.document.score": 0.9,
      "retrieval.documents.10.document.id": "d10",
      "llm.input_messages.0.message.role": "user",
      "llm.input_messages.0.message.contents.0.message_content.type": "text",
      "llm.input_messages.0.message.contents.0.message_content.text": "What is this?",
      "llm.input_messages.0.message.contents.1.message_content.type": "image",
    };
    expect(tools(a)).toEqual([{ name: "lookup", description: "Find an order", schema: a["llm.tools.0.tool.json_schema"] }]);
    expect(documents(a).map((d) => d.content ?? d.id)).toEqual(["first", "second", "d10"]);
    expect(documents(a)[0]!.score).toBe(0.9);
    expect(messages(a, "input")[0]!.content).toBe("What is this?\n[image]");
    expect(unflattenList(a, "llm.output_messages")).toEqual([]);
  });

  it("reads gen_ai names when OpenInference ones are missing", () => {
    const a = {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-5-5",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": "20",
      "gen_ai.conversation.id": "conv-1",
      "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content: "Hi" }] }]),
      "gen_ai.output.messages": JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: "Hello" }] }]),
    };
    expect(spanFacts(a)).toMatchObject({ kind: "LLM", provider: "anthropic", model: "claude-sonnet-5-5", promptTokens: 100, completionTokens: 20, totalTokens: 120, sessionId: "conv-1", input: "Hi", output: "Hello", costMicros: null });
    expect(spanKind({ "gen_ai.operation.name": "execute_tool" })).toBe("TOOL");
    expect(spanKind({ "openinference.span.kind": "retriever" })).toBe("RETRIEVER");
    expect(spanKind({ "openinference.span.kind": "made-up" })).toBe("UNKNOWN");
    expect(spanKind({})).toBe("UNKNOWN");
  });
});
