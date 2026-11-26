# Phases H3 and H4 complete: people view, docs, end-to-end check

- `migrations/0007_trace_people.sql`, `src/tracing/query.ts`, `src/routes/tracing.ts`: `GET /api/tracing/people` (tools, sessions, turns, tokens, active days per person) and a `user` filter on traces.
- `public/app/js/views/traces.js`: People tab, person filter, and connect instructions for Claude Code and Codex at the top of the "Send traces" panel.
- `scripts/demo/traces.ts`: six people using Claude Code and Codex in the demo workspace.
- `docs-src/12-integrations/10-tracing-coding-tools.md`, changelog, structure notes.

## Checked

- People API: totals, app and date filters, tenant isolation (1 new test, 98 in all).
- Browser, demo data: People tab at 1440px dark and 375px light, person to traces filter, a coding-tool trace page, the connect panel.
- Real tool: a Claude Code 2.1.330 session with the hooks attached produced a stored trace with model calls, token counts and the tool call.
- Installer downloaded from the running server and run against temporary Claude and Codex folders: install, status, test turn, uninstall.

## Not checked

- Codex for real (needs a person to approve the hooks in `/hooks`).
- A long real session, subagents in a real session, Windows.
- Load: many people sending at once through one key share its 600 requests a minute.
