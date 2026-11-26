# Phase R1 complete: quarterly retention and export

- `src/tracing/retention.ts`: traces older than 92 days are deleted with their spans by the hourly cron, one workspace at a time through `TenantDB`, up to 2,000 traces per workspace per run. `TRACE_RETENTION_DAYS` overrides the window. `GET /api/tracing/retention` reports the window and how many traces go within 14 days.
- `src/tracing/export.ts`: `GET /api/tracing/export/traces.csv`, `traces.jsonl` (streamed, every span with attributes and events) and `people.csv`, all honouring the list's filters.
- Portal: Export menu on the Traces page, a line stating the retention window, and a warning when traces are within 14 days of deletion.
- `migrations/0008_trace_retention.sql`, docs, changelog.

## Checked

- Tests: export contents, filters, multi-page JSON Lines, tenant isolation; pruning removes only expired traces, one workspace without touching another, and the scheduled job across workspaces (19 tracing tests).
- On the owner's imported sessions: the CSV, the JSON Lines file and the people CSV agree with stored totals (102 turns, 2,984 steps, 263,347,628 tokens), and every exported trace has all of its spans.
- Browser: Export menu at 1440px and 375px (it ran off the left edge at 375px; fixed).

## Decisions and limits

- "Quarterly" is 92 days, the longest calendar quarter, counted from each trace's start.
- Deletion is permanent; nothing is archived on our side. Keeping data longer is the customer's export.
- A first run on a workspace with a large backlog clears 2,000 traces an hour until it catches up.
- Export caps: 50,000 traces per CSV, 10,000 per JSON Lines file. The CSV says so in an `x-export-truncated` header; the portal does not yet warn when a file was capped.
- No scheduled or automatic export.
