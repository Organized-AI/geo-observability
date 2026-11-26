# Phase G4 complete: capacity and quotas

## Built

- Migration `0013_trace_capacity.sql`: `llm_spans.body_key`, `trace_usage` (spans and request bytes per workspace per month), `tenants.trace_span_limit` (default 2,000,000 spans a month).
- A span whose body (text, attributes, events) is over 8 KB is written whole to R2 (`ANSWERS` bucket, `traces/<tenant>/<trace>/<span>-<end>.json`). The row keeps 2,000 characters of input and output and every attribute except content (prompts, messages, documents), so people views and reports still read from D1. The span view and JSON Lines export read the body back. Retention and app delete remove the bodies.
- Ingest counts spans per month and refuses with 429 `quota_exceeded` past the limit (a request that crosses it is stored up to the limit). The Traces footer shows the month's use, with a warning at 80% and 100%. `GET /api/tracing/usage`.
- `scripts/load/trace-load.mjs`: an ingest load test shaped like real coding-tool turns (16 spans each), one key per person.

## Measured (local dev on the Mac mini, wrangler dev with local D1)

| Run | Result |
| --- | --- |
| 50 people × 100 turns, one key each, 8 at a time | 5,000 requests, 80,000 spans in 72 s; 69 requests/s; p50 112 ms, p95 179 ms, p99 234 ms; no failures |
| Same through one shared key | 2,600 of 5,000 refused with 429 by the 600/minute per-key limit, as designed |
| Stored size | 627 bytes per span in the row (about 10 KB per turn); 56 MB for the 5,000 turns, before indexes |
| Hourly job (reports and prune) | 50 daily reports written in one run, well inside the cron's time |

## What the numbers mean

At 50 people × 100 turns a day kept for 92 days, rows reach about 5 GB before indexes, close to D1's 10 GB database limit. That is fine for teams up to a few dozen heavy users. Before larger workspaces: drop the context attributes repeated on every child span (user, session, project, harness), which are about half of each row, or give large workspaces a shorter window or their own database. Recorded as a later step, not done here.

Tests: R2 body round trip and deletion, quota counting and refusal. `npm run check` passes.
