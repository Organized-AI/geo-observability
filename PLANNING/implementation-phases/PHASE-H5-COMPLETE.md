# Phase H5 complete: import existing sessions, tested on real data

- `geo-trace.mjs import [--days N] [--tools claude,codex] [--dry-run]`: reads Claude Code transcripts and Codex rollout files already on the machine and sends each turn as a trace, reusing the same turn builder as the hooks.
- Ids are derived from each step's own identity (tool call id, message id), so importing again cannot duplicate, and a turn that was still running gains its later steps.

## Tested on the owner's own sessions (this Mac mini, last 30 days)

| | Claude Code | Codex |
| --- | --- | --- |
| Session files | 7 with recent turns (9 read) | 16 |
| Turns | 22 | 77 |
| Steps stored | 485 | 2,484 |
| Tokens | 58,541,889 | 201,147,768 |

- Token totals were compared, per file, with totals taken independently from the files: all 9 Claude Code files and all 16 Codex files agree exactly. Tool-call counts agree as well.
- Stored rows equal what the importer reported, with no step missing its parent, and a second import added nothing.

## Bugs found by the real data and fixed

1. Codex subagent files replay their parent's earlier turns; these were being counted as 21 extra turns and merged into the wrong thread. Each thread now has its own identity and replays are skipped.
2. A tool result logged twice in a Claude Code transcript produced two tool steps.
3. Step ids depended on position, so re-importing a turn that had grown would have repeated its model calls.

## Not done

- Live hooks have not been installed into the owner's real Claude Code and Codex settings; that changes their configuration and was left for them to run.
- Claude Code subagent threads are not imported.
- The imported data sits in the local demo database only.
