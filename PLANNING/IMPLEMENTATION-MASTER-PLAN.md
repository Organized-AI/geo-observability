# LLM tracing: implementation master plan

**Created:** 2026-11-23
**Branch:** `feat/llm-tracing` (from `origin/main` at 1.4.1)
**Runtime:** Cloudflare Workers, Hono, D1, vanilla JS portal
**Background:** `SPECIFICATIONS/llm-tracing-design.md`

Clients send traces from their own LLM apps to their workspace and read them in the portal. This is stage 1 of the build order in the research notes. Later stages are listed at the bottom and get their own phase prompts when they start.

## Rules for every phase

- Our own code and copy. OpenInference attribute names are an open convention and may be used.
- Tenant data goes through `TenantDB`. Money is integer micros. No time estimates.
- A phase ends with `npm run check` passing, a `PHASE-T<n>-COMPLETE.md` note in `PLANNING/implementation-phases/`, and one commit.

## Pre-implementation checklist

| Item | Location | State |
| --- | --- | --- |
| Design and data contracts | `SPECIFICATIONS/llm-tracing-design.md` | Done |
| API keys with an `ingest` scope | `api_keys`, `resolveKey()` | Exists |
| Worker-first `/ingest/*` routing, base path handling | `wrangler.jsonc`, `src/lib/basepath.ts` | Exists |
| Portal shell, table, drawer, tabs | `public/app` | Exists |

## Phases

| Phase | Name | Files | Depends on |
| --- | --- | --- | --- |
| T0 | Setup | this plan, phase prompts, research notes | none |
| T1 | Data model and decoding | `migrations/0006_llm_tracing.sql`, `src/tracing/otlp.ts`, `src/tracing/openinference.ts`, `test/tracing-decode.test.ts` | T0 |
| T2 | Ingest endpoint | `src/tracing/store.ts`, `src/index.ts`, `test/tracing.test.ts` | T1 |
| T3 | Query API | `src/tracing/query.ts`, `src/routes/tracing.ts`, `src/routes/portal.ts` | T2 |
| T4 | Portal view | `public/app/js/views/traces.js`, `public/app/app.js`, `public/app/app.css`, `scripts/demo/generate.ts` | T3 |
| T5 | Docs and version | `docs-src/12-integrations/`, `ARCHITECTURE/overview.md`, `CLAUDE.md`, `CHANGELOG.md`, `PLANNING/phases.md` | T4 |

## Decisions

| Question | Decision |
| --- | --- |
| Where do traces hang? | On the workspace (tenant), grouped by a named app. They are not tied to a GEO project, because a client's LLM app is not a tracked brand. |
| App name | `x-project-name` header, else resource `openinference.project.name`, else `service.name`, else `default`. |
| Endpoint | `POST /ingest/otlp/v1/traces`. An exporter set to the base `…/ingest/otlp` appends `/v1/traces` itself. |
| Auth | Existing ingest keys, as `x-ingest-key` or `Authorization: Bearer`. |
| Encodings | OTLP protobuf and OTLP JSON, optionally gzip. |
| Storage | D1. Span attributes as a JSON blob with a few promoted columns. Long values are cut, with a flag. |
| Trace totals | Recomputed from stored spans after each write, so resends and out-of-order spans cannot double count. |
| Time | Integer epoch milliseconds on spans and traces. |

## Later stages (not in this plan yet)

| Stage | Scope |
| --- | --- |
| Cost and metrics | Model price table, cost at ingest when the sender gives none, time-bucketed charts |
| Our own runs as traces | `geo.run` and `chat <engine>` written to the tracing store with OpenInference attributes |
| Evaluations | Versioned evaluators, tasks with sampling and backfill, results on spans |
| Human review | Annotation configs and queues |
| Datasets and experiments | Examples from spans, versions, compare view |
| Prompts | Versions, labels, playground |
| Monitors and dashboards | Thresholds, alerts, widgets |
| Retention and quotas | Per-plan span limits, pruning, metering |

## Running a phase

Read `PLANNING/implementation-phases/PHASE-T<n>-PROMPT.md`, do every task, check the success criteria, write the completion note, commit.
