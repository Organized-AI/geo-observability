# Phase G3 complete: privacy and notice

- Migration `0012_trace_settings.sql`: one capture level per workspace (`full`, `prompts`, `metadata`). Owners change it with `PUT /api/tracing/settings` (audited); everyone can read it.
- `src/tracing/policy.ts` enforces it at ingest on coding-tool spans: `prompts` drops tool inputs and outputs, `metadata` drops all text. App traces are unaffected.
- `src/tracing/redact.ts` replaces secrets in every span's text, attributes, events and status. `geo-trace.mjs` runs the same rules before sending; a test keeps the lists equal.
- `GET /ingest/otlp/policy` tells a key its level and person. The hook reads it at install and once a day, and narrows what it records.
- The installer prints what it sends, under which name, the workspace level, who can read it, and how to stop.
- Tests: 4 server, 3 hook. `npm run check` passes.
