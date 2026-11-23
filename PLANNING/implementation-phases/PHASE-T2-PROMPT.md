# Phase T2: ingest endpoint

**Read first:** `src/observability/ingest.ts` (`resolveKey`), `src/index.ts` (ingest routes and CORS), `src/routes/v1.ts` (`rateLimit`).

## Tasks

1. `src/tracing/store.ts`: write decoded spans through `TenantDB`. Get or create the app by name. Insert spans and ignore ones already stored. Recompute each touched trace's totals from its stored spans.
2. Limits: request size, spans per request, apps per workspace, length of stored strings and attribute blobs. Over-long values are cut and flagged.
3. `POST /ingest/otlp/v1/traces` in `src/index.ts`: ingest key from `x-ingest-key` or `Authorization: Bearer`, per-key rate limit, OTLP-shaped success response in the encoding the client used.
4. `test/tracing.test.ts`: accepted with an ingest key, refused with a read key or none; a resend changes nothing; a child arriving before its parent ends with correct totals; one workspace never sees another's spans.

## Success criteria

- [ ] An OpenTelemetry exporter pointed at `…/ingest/otlp` with an ingest key is accepted.
- [ ] Sending the same batch twice leaves span and token totals unchanged.
- [ ] Totals are correct whatever order spans arrive in.
- [ ] Tenant isolation test passes.
- [ ] `npm run check` passes.
