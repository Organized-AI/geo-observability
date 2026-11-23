# Phase T3: query API

**Read first:** `src/routes/portal.ts` (session middleware, `requireWrite`, `requireOwner`), `src/metrics/filters.ts` (`Binds`).

## Tasks

1. `src/tracing/query.ts`: list apps with counts; list traces with filters (app, date range, status, text search, session, model, minimum latency) and keyset paging; one trace with its spans and parsed detail; sessions grouped from traces.
2. `src/routes/tracing.ts`: `GET /api/tracing/apps`, `/traces`, `/traces/:traceId`, `/sessions`, `/setup`; `DELETE /api/tracing/apps/:id` for owners. Mount it in `portal.ts` after the session middleware.
3. Tests in `test/tracing.test.ts`: filters, paging without gaps or repeats, trace detail shape, read-only users cannot delete, cross-tenant requests return nothing.

## Success criteria

- [ ] Paging through a list returns every trace once.
- [ ] Trace detail returns spans in start order with messages, tools and documents parsed.
- [ ] Every query is tenant scoped through `TenantDB` with no unused binds.
- [ ] `npm run check` passes.
