# Phase T1: data model and decoding

**Read first:** `SPECIFICATIONS/llm-tracing-design.md` (data contracts), `src/lib/db.ts`, `migrations/0001_init.sql` (style).

## Tasks

1. `migrations/0006_llm_tracing.sql`: `trace_apps`, `llm_traces`, `llm_spans`, with indexes for listing by app and time, by session, and spans by trace.
2. `src/tracing/otlp.ts`: decode an OTLP trace export from JSON and from protobuf into one span shape. Handle gzip. Reject malformed bodies with `HttpError(400)`.
3. `src/tracing/openinference.ts`: from a span's attributes, read kind, model, provider, token counts, cost, session, user, input and output. Fall back to `gen_ai.*` names. Rebuild messages, tools and retrieved documents from flattened keys.
4. `test/tracing-decode.test.ts`: JSON and protobuf decode the same payload to the same spans; a protobuf fixture produced by the official `opentelemetry-proto` Python package decodes correctly; attribute extraction covers both naming schemes.

## Success criteria

- [ ] A protobuf payload from a real OpenTelemetry encoder decodes to the expected ids, times, attributes, events and status.
- [ ] JSON and protobuf forms of one payload give equal results.
- [ ] Bad input returns a 400 with a plain message, never a 500.
- [ ] `npm run check` passes.
