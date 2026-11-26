# Phase P1 complete: per-person drill-down and daily reports

- `public/trace/geo-trace.mjs`: every tool call now carries names that say what was used (tool kind, skill, plugin, MCP server, subagent type, the program a shell command starts with) and the turn carries its slash command. Names only; inputs still follow the content switches. The importer derives the same from session files.
- `src/tracing/people.ts`: `personSummary` (totals, by day, tools, skills, plugins, MCP servers, subagents, programs, commands, models, projects, sessions), `observe` (fixed rules), `buildReport`, hourly `generateDailyReports` into `trace_reports`.
- Routes: `GET /api/tracing/people/:user`, `/people/:user/reports`, `/people/:user/reports/:day` (stored, or built on the spot for a day not written yet).
- Portal: a page per person with the daily report, activity by day and the breakdown tables. The People tab links to it.
- `migrations/0009_trace_person_reports.sql`, demo data with skills, plugins, subagents and programs, docs, changelog.

## Checked

- Tests: breakdown numbers and report observations on a constructed day (21 tracing tests); the capture keeps names and drops inputs (13 script tests).
- On the owner's own 30 days (re-imported with the new detail): 104 turns, 1,453 tool calls, programs, 3 skills, 6 subagent calls, 2 plugins, 2 MCP servers, 6 models; today's report produced seven observations that match the numbers.
- Browser: the person page at 1440px dark (demo) and 375px light (real data), switching report days, People tab link.

## Decisions and limits

- Observations are rules over counts. No model writes or judges anything, and prompt text is never read for a report.
- "After the day's session" is implemented as after the UTC day ends, regenerated hourly for the previous day. There is no per-person time zone and no end-of-session trigger.
- Reports are not emailed or pushed anywhere; they are read in the portal.
- Reports are kept when traces are pruned.
- Skill, subagent and program names need the geo-trace script; traces from other senders still get tools, MCP servers and plugins from tool names.
- Codex's `exec` tool is counted as a built-in tool, so programs run through it are not broken out.
- The rule thresholds (25% failures, 150k tokens of context, 40 model calls, 50% cache reuse) are first guesses and have not been tuned on real teams.
