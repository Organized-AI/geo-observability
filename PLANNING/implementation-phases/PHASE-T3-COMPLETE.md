# Phase T3 complete: query API

- `src/tracing/query.ts`: apps with counts, trace list with filters and keyset paging, totals for the same filters, trace with light span rows, one span with parsed messages, tools, documents and events, sessions, app delete.
- `src/routes/tracing.ts` mounted at `/api/tracing`: `GET /apps`, `/traces`, `/traces/:traceId`, `/traces/:traceId/spans/:spanId`, `/sessions`, `/setup`; `DELETE /apps/:id`.
- Tests added to `test/tracing.test.ts`.

## Decisions made here

- A trace returns light span rows; a span's attributes and messages load when it is opened. A 2,000-span trace would otherwise be one very large response.
- Search treats `%` and `_` as literal characters and also matches a full trace id.

## Success criteria

- [x] Paging through a list returns every trace once (25 traces, pages of 10).
- [x] Trace detail returns spans in start order; span detail has messages, tool calls and events parsed.
- [x] Every query is tenant scoped through `TenantDB`; cross-workspace reads and deletes return 404.
- [x] `npm run check` passes.
- [ ] Not covered by a test: a read-only user being refused on delete. The route calls `requireWrite` and `requireOwner`, which other tests cover, but no tracing test signs in as a viewer.
