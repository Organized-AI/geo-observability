# Phase T2 complete: ingest endpoint

- `src/tracing/store.ts`: app resolution, insert-once spans, trace summaries recomputed from stored spans, size limits with a `truncated` flag.
- `src/index.ts`: `POST /ingest/otlp/v1/traces` with an ingest key (`x-ingest-key` or `Authorization: Bearer`), 600 requests a minute per key, OTLP response in the caller's encoding with a rejected-span count.
- `test/tracing.test.ts`: auth, protobuf, gzip and JSON, resends, out-of-order arrival, app naming, bad ids, oversized values, tenant isolation.

## Decisions made here

- Token and cost totals on a trace count model-calling spans only (`LLM`, `EMBEDDING`, `DECISION`), so a parent that repeats its children's usage is not counted twice.
- A workspace can have 50 named apps; names past that go to `default`.
- A span that is resent is ignored, including when its content changed.

## Success criteria

- [x] A protobuf export with an ingest key is accepted.
- [x] Sending the same batch again, in three encodings, leaves totals unchanged.
- [x] Totals are correct when children arrive before the root.
- [x] Tenant isolation test passes.
- [x] `npm run check` passes.
