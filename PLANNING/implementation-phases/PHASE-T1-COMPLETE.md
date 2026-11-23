# Phase T1 complete: data model and decoding

- `migrations/0006_llm_tracing.sql`: `trace_apps`, `llm_spans`, `llm_traces`.
- `src/tracing/otlp.ts`: protobuf and JSON decoders, gzip and deflate, size caps, OTLP response writer.
- `src/tracing/openinference.ts`: kind, model, tokens, cost, session, input and output, with `gen_ai.*` fallbacks; messages, tools and documents rebuilt from flattened keys.
- `test/tracing-decode.test.ts`, `test/fixtures/otlp.ts`: the protobuf fixture was produced by the official `opentelemetry-proto` Python package.

## Success criteria

- [x] A protobuf payload from a real OpenTelemetry encoder decodes to the expected ids, times, attributes, events and status.
- [x] JSON and protobuf forms of one payload give equal results.
- [x] Bad input returns a 4xx with a plain message (truncated and random bodies included).
- [x] `npm run check` passes (81 tests).
