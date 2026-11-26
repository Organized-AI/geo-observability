# Phase G6 complete: reports people read

- Migration `0014_trace_report_delivery.sql`: `trace_settings.email_reports` (owner switch, off by default), `trace_reports.emailed_at`, and `trace_people` (time zone and the person's own email choice).
- Time zones: `geo-trace.mjs` sends `user.timezone` on each turn; ingest records it per person (`src/tracing/localday.ts` does the date arithmetic, including clock changes). The hourly job writes each person's yesterday in their own time zone (`generatePeopleReports`); stored reports name the zone.
- Email: `src/tracing/report-mail.ts` sends each person their own report from 7am their time the morning after, once (`emailed_at`), retrying failed sends for up to three days. Plain text, a link to the report, and a signed stop link (a page with one button; the POST records the choice).
- Import: `withClaudeSubagents` reads `<session>/subagents/agent-*.jsonl` and attaches each subagent's tools and model calls to the turn with the same promptId. On the owner's own data (dry run): 6 of 6 subagent files matched, no new turns, +278 steps.
- Tests: local days and clock changes, report day by zone, email timing and once-only, stop link, the email text, the subagent import. `npm run check` passes.
