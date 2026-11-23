/**
 * Decoding an OTLP trace export (the body an OpenTelemetry exporter posts to /v1/traces) into plain spans.
 *
 * Two encodings arrive in practice: protobuf (the default for most SDK exporters) and JSON. Both are decoded
 * to the same shape. Attribute values keep their type; nested lists and maps become JSON-compatible values.
 */
import { HttpError } from "../lib/util";

export type AttrValue = string | number | boolean | null | AttrValue[] | { [key: string]: AttrValue };
export type Attrs = Record<string, AttrValue>;

export interface OtlpEvent {
  name: string;
  time_ms: number;
  attributes: Attrs;
}

export interface OtlpSpan {
  traceId: string; // 32 lower-case hex characters
  spanId: string; // 16 lower-case hex characters
  parentSpanId: string | null;
  name: string;
  startMs: number;
  endMs: number;
  attributes: Attrs;
  events: OtlpEvent[];
  statusCode: "UNSET" | "OK" | "ERROR";
  statusMessage: string | null;
  resource: Attrs;
}

const STATUS = ["UNSET", "OK", "ERROR"] as const;
const bad = (why: string) => new HttpError(400, "bad_otlp", `Could not read the trace export: ${why}`);

// ------------------------------------------------------------------ protobuf

const utf8 = new TextDecoder();

class Reader {
  pos = 0;
  private view: DataView;
  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw bad("the protobuf body ends in the middle of a number");
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
    throw bad("a protobuf number is too long");
  }
  tag(): { field: number; wire: number } {
    const t = Number(this.varint());
    return { field: t >>> 3, wire: t & 7 };
  }
  bytes(): Uint8Array {
    const len = Number(this.varint());
    if (len < 0 || this.pos + len > this.buf.length) throw bad("a protobuf field runs past the end of the body");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  string(): string {
    return utf8.decode(this.bytes());
  }
  fixed64(): bigint {
    if (this.pos + 8 > this.buf.length) throw bad("a protobuf field runs past the end of the body");
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }
  double(): number {
    if (this.pos + 8 > this.buf.length) throw bad("a protobuf field runs past the end of the body");
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw bad("the body is not an OTLP protobuf message");
    if (this.pos > this.buf.length) throw bad("a protobuf field runs past the end of the body");
  }
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const nsToMs = (ns: bigint) => Number(ns / 1_000_000n);
const b64 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};

function pbAnyValue(buf: Uint8Array, depth = 0): AttrValue {
  if (depth > 8) return null;
  const r = new Reader(buf);
  let value: AttrValue = null;
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) value = r.string();
    else if (field === 2 && wire === 0) value = r.varint() !== 0n;
    else if (field === 3 && wire === 0) value = Number(BigInt.asIntN(64, r.varint()));
    else if (field === 4 && wire === 1) value = r.double();
    else if (field === 5 && wire === 2) {
      const list: AttrValue[] = [];
      const a = new Reader(r.bytes());
      while (!a.done) {
        const t = a.tag();
        if (t.field === 1 && t.wire === 2) list.push(pbAnyValue(a.bytes(), depth + 1));
        else a.skip(t.wire);
      }
      value = list;
    } else if (field === 6 && wire === 2) {
      const map: Attrs = {};
      const m = new Reader(r.bytes());
      while (!m.done) {
        const t = m.tag();
        if (t.field === 1 && t.wire === 2) pbKeyValue(m.bytes(), map, depth + 1);
        else m.skip(t.wire);
      }
      value = map;
    } else if (field === 7 && wire === 2) value = b64(r.bytes());
    else r.skip(wire);
  }
  return value;
}

function pbKeyValue(buf: Uint8Array, into: Attrs, depth = 0): void {
  const r = new Reader(buf);
  let key = "";
  let value: AttrValue = null;
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) key = r.string();
    else if (field === 2 && wire === 2) value = pbAnyValue(r.bytes(), depth);
    else r.skip(wire);
  }
  if (key) into[key] = value;
}

function pbEvent(buf: Uint8Array): OtlpEvent {
  const r = new Reader(buf);
  const ev: OtlpEvent = { name: "", time_ms: 0, attributes: {} };
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 1) ev.time_ms = nsToMs(r.fixed64());
    else if (field === 2 && wire === 2) ev.name = r.string();
    else if (field === 3 && wire === 2) pbKeyValue(r.bytes(), ev.attributes);
    else r.skip(wire);
  }
  return ev;
}

function pbSpan(buf: Uint8Array, resource: Attrs): OtlpSpan {
  const r = new Reader(buf);
  const s: OtlpSpan = { traceId: "", spanId: "", parentSpanId: null, name: "", startMs: 0, endMs: 0, attributes: {}, events: [], statusCode: "UNSET", statusMessage: null, resource };
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) s.traceId = hex(r.bytes());
    else if (field === 2 && wire === 2) s.spanId = hex(r.bytes());
    else if (field === 4 && wire === 2) s.parentSpanId = hex(r.bytes()) || null;
    else if (field === 5 && wire === 2) s.name = r.string();
    else if (field === 7 && wire === 1) s.startMs = nsToMs(r.fixed64());
    else if (field === 8 && wire === 1) s.endMs = nsToMs(r.fixed64());
    else if (field === 9 && wire === 2) pbKeyValue(r.bytes(), s.attributes);
    else if (field === 11 && wire === 2) s.events.push(pbEvent(r.bytes()));
    else if (field === 15 && wire === 2) {
      const st = new Reader(r.bytes());
      while (!st.done) {
        const t = st.tag();
        if (t.field === 2 && t.wire === 2) s.statusMessage = st.string() || null;
        else if (t.field === 3 && t.wire === 0) s.statusCode = STATUS[Number(st.varint())] ?? "UNSET";
        else st.skip(t.wire);
      }
    } else r.skip(wire);
  }
  return s;
}

export function decodeProtobuf(body: Uint8Array): OtlpSpan[] {
  const spans: OtlpSpan[] = [];
  const req = new Reader(body);
  while (!req.done) {
    const top = req.tag();
    if (top.field !== 1 || top.wire !== 2) {
      req.skip(top.wire);
      continue;
    }
    // ResourceSpans: the resource may come after the spans on the wire, so collect first.
    const rs = new Reader(req.bytes());
    const resource: Attrs = {};
    const scopeBlocks: Uint8Array[] = [];
    while (!rs.done) {
      const t = rs.tag();
      if (t.field === 1 && t.wire === 2) {
        const res = new Reader(rs.bytes());
        while (!res.done) {
          const rt = res.tag();
          if (rt.field === 1 && rt.wire === 2) pbKeyValue(res.bytes(), resource);
          else res.skip(rt.wire);
        }
      } else if (t.field === 2 && t.wire === 2) scopeBlocks.push(rs.bytes());
      else rs.skip(t.wire);
    }
    for (const block of scopeBlocks) {
      const ss = new Reader(block);
      while (!ss.done) {
        const t = ss.tag();
        if (t.field === 2 && t.wire === 2) spans.push(pbSpan(ss.bytes(), resource));
        else ss.skip(t.wire);
      }
    }
  }
  return spans;
}

// ------------------------------------------------------------------ JSON

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function jsonAnyValue(v: unknown, depth = 0): AttrValue {
  if (!isObj(v) || depth > 8) return null;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (v.intValue !== undefined) {
    const n = Number(v.intValue);
    return Number.isFinite(n) ? n : null;
  }
  if (v.doubleValue !== undefined) {
    const n = Number(v.doubleValue);
    return Number.isFinite(n) ? n : null;
  }
  if (isObj(v.arrayValue)) return arr(v.arrayValue.values).map((x) => jsonAnyValue(x, depth + 1));
  if (isObj(v.kvlistValue)) return jsonAttrs(v.kvlistValue.values, depth + 1);
  if (typeof v.bytesValue === "string") return v.bytesValue;
  return null;
}

function jsonAttrs(list: unknown, depth = 0): Attrs {
  const out: Attrs = {};
  for (const kv of arr(list)) {
    if (isObj(kv) && typeof kv.key === "string" && kv.key) out[kv.key] = jsonAnyValue(kv.value, depth);
  }
  return out;
}

/** OTLP JSON writes ids as hex. Some senders use base64 as plain protobuf JSON would; accept both. */
function jsonId(v: unknown, bytes: number): string {
  if (typeof v !== "string" || !v) return "";
  if (new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(v)) return v.toLowerCase();
  try {
    const raw = atob(v);
    if (raw.length === bytes) return [...raw].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  } catch {
    /* not base64 either */
  }
  return "";
}

function jsonNs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v / 1e6);
  if (typeof v === "string" && /^\d+$/.test(v)) return nsToMs(BigInt(v));
  return 0;
}

function jsonStatus(code: unknown): OtlpSpan["statusCode"] {
  if (typeof code === "number") return STATUS[code] ?? "UNSET";
  if (typeof code === "string") {
    if (/ERROR/i.test(code)) return "ERROR";
    if (/OK/i.test(code)) return "OK";
  }
  return "UNSET";
}

export function decodeJson(body: unknown): OtlpSpan[] {
  if (!isObj(body)) throw bad("the JSON body must be an object with resourceSpans");
  const spans: OtlpSpan[] = [];
  for (const rs of arr(body.resourceSpans)) {
    if (!isObj(rs)) continue;
    const resource = isObj(rs.resource) ? jsonAttrs(rs.resource.attributes) : {};
    for (const ss of arr(rs.scopeSpans)) {
      if (!isObj(ss)) continue;
      for (const sp of arr(ss.spans)) {
        if (!isObj(sp)) continue;
        const status = isObj(sp.status) ? sp.status : {};
        spans.push({
          traceId: jsonId(sp.traceId, 16),
          spanId: jsonId(sp.spanId, 8),
          parentSpanId: jsonId(sp.parentSpanId, 8) || null,
          name: typeof sp.name === "string" ? sp.name : "",
          startMs: jsonNs(sp.startTimeUnixNano),
          endMs: jsonNs(sp.endTimeUnixNano),
          attributes: jsonAttrs(sp.attributes),
          events: arr(sp.events)
            .filter(isObj)
            .map((e) => ({ name: typeof e.name === "string" ? e.name : "", time_ms: jsonNs(e.timeUnixNano), attributes: jsonAttrs(e.attributes) })),
          statusCode: jsonStatus(status.code),
          statusMessage: typeof status.message === "string" && status.message ? status.message : null,
          resource,
        });
      }
    }
  }
  return spans;
}

// ------------------------------------------------------------------ request body

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024;

async function readCapped(stream: ReadableStream<Uint8Array>, cap: number, what: string): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "too_large", `${what} is larger than ${Math.round(cap / 1024 / 1024)} MB. Send smaller batches.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export type OtlpEncoding = "protobuf" | "json";

/** Reads an export request: size caps, optional gzip, then protobuf or JSON by content type. */
export async function readExport(req: Request): Promise<{ spans: OtlpSpan[]; encoding: OtlpEncoding }> {
  if (!req.body) throw bad("the request has no body");
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  const encoding: OtlpEncoding | null = type.includes("json") ? "json" : type.includes("protobuf") ? "protobuf" : null;
  if (!encoding) throw new HttpError(415, "unsupported_type", "Send application/x-protobuf or application/json");

  let bytes = await readCapped(req.body, MAX_BODY_BYTES, "The request body");
  const enc = (req.headers.get("content-encoding") ?? "").toLowerCase().trim();
  if (enc === "gzip" || enc === "deflate") {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(enc));
      bytes = await readCapped(stream as ReadableStream<Uint8Array>, MAX_DECOMPRESSED_BYTES, "The uncompressed body");
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw bad(`the body is not valid ${enc}`);
    }
  } else if (enc && enc !== "identity") {
    throw new HttpError(415, "unsupported_encoding", "Content-Encoding must be gzip, deflate or absent");
  }

  if (encoding === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(utf8.decode(bytes));
    } catch {
      throw bad("the body is not valid JSON");
    }
    return { spans: decodeJson(parsed), encoding };
  }
  try {
    return { spans: decodeProtobuf(bytes), encoding };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw bad("the body is not an OTLP protobuf message");
  }
}

/** Minimal successful ExportTraceServiceResponse in the caller's encoding, with a rejected count when spans were dropped. */
export function exportResponse(encoding: OtlpEncoding, rejected: number, message: string): Response {
  if (encoding === "json") {
    const body = rejected ? { partialSuccess: { rejectedSpans: String(rejected), errorMessage: message } } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (!rejected) return new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "application/x-protobuf" } });
  // ExportTraceServiceResponse { partial_success = 1 { rejected_spans = 1 (varint), error_message = 2 (string) } }
  const msg = new TextEncoder().encode(message.slice(0, 100));
  const inner = [0x08, ...varintBytes(rejected), 0x12, ...varintBytes(msg.length), ...msg];
  return new Response(new Uint8Array([0x0a, ...varintBytes(inner.length), ...inner]), { status: 200, headers: { "content-type": "application/x-protobuf" } });
}

function varintBytes(n: number): number[] {
  const out: number[] = [];
  let v = Math.max(0, Math.floor(n));
  do {
    const b = v % 128;
    v = Math.floor(v / 128);
    out.push(v ? b | 0x80 : b);
  } while (v);
  return out;
}
