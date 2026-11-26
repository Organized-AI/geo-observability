# Phase P2 complete: trends, team view, and one copy per turn

- One copy per turn: live hooks now use the same ids an import would, and the server replaces a stored span when a copy that ends later arrives. A turn sent live and imported later is stored once; a turn imported mid-way is completed by its finished copy.
- `GET /api/tracing/people/:user` returns `previous` (the period of the same length just before); the person page shows the change on each headline number.
- `GET /api/tracing/team`: adoption counts, every skill, plugin, MCP server, subagent and slash command with who uses it, and team observations (fixed rules).
- `migrations/0010_trace_app_kind.sql`: apps are `app` or `coding_tool` (set when spans carry `harness.name`). People, team and daily reports count coding-tool users by default.

## Checked

- Tests: live and imported ids match; a finished span replaces a partial one and an older copy does not undo it; previous-period comparison; team summary, adoption and observations; end users excluded by default (23 tracing tests, 13 script tests).
- Browser, on demo plus the owner's data: People tab shows 7 people (the demo support app's end users no longer counted), the team section at 1440px and 375px, change arrows on a person page.

## Found on real data

- The owner's own last turn was stored twice (live hook plus an import run while it was in progress). That is what the first item fixes. The two existing copies in the local database predate the fix and were left as they are.

## Not done

- Codex live hooks: still waiting for approval in `/hooks`.
- Claude Code subagent threads are still left out of imports.
- No delivery of reports outside the portal.
