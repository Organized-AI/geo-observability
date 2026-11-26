# Phases H1 and H2 complete: hook script and installer

- `public/trace/geo-trace.mjs`: one dependency-free Node script for Claude Code and Codex. `hook` stores each hook event, and at the end of a turn sends one trace (turn, model calls, tool calls, subagents). `install`, `uninstall`, `status`, `test`, `print-managed`.
- `test-scripts/geo-trace.test.mjs`: 11 tests, including a local HTTP server, the real command run through a shell, and installs into temporary Claude and Codex folders.

## Checked against the real tool

One small real Claude Code 2.1.330 session was run with the hooks loaded from a temporary settings file (`claude -p --settings`), sending to the local dev server. The stored trace had the turn, the Bash tool call with its input and output, and two model calls with model name and token counts.

That run found a bug the unit tests had missed: the model's transcript lines do not carry the prompt id, only the person's lines do. The parser and the test fixtures now follow the real shape.

## Not checked

- Codex has not been run for real. Its handling follows the hook schema in the `openai/codex` repo at CLI 0.171.0. A person has to approve new hooks in Codex with `/hooks`, so this needs a manual run.
- Subagent transcripts and long sessions have only been exercised with made-up events.
- Windows.

## Known limits

- Claude Code's transcript format is internal and can change. If it does, traces still arrive but without model calls and tokens.
- `user.id` is whatever the installer was given. One shared ingest key cannot prove who sent a trace.
- Hooks are registered as async. If a tool exits right after a turn (for example `claude -p`), the last turn is sent when the hook process finishes, or on the next prompt.
