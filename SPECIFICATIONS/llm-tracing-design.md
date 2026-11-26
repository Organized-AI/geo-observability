# LLM tracing: design and data contracts

What we build and the shapes it accepts. Written for this repo; the plan is in `PLANNING/IMPLEMENTATION-MASTER-PLAN.md`.

## Ground rules

- Our own code, docs and UI copy.
- OpenInference (Apache-2.0) is an open attribute convention. We accept and emit its names, and fall back to OpenTelemetry `gen_ai.*` names.
- Evaluator prompt templates, when they come, are written fresh.

## The four loops

1. **Trace**: apps and coding tools send OTLP spans. Spans group into traces, traces into sessions.
2. **Evaluate**: an evaluator attaches a label, score and explanation to a span, trace or session, on sampled live data or as a backfill.
3. **Improve**: failing spans become dataset examples; experiments rerun a task over a dataset and score it; prompts are versioned.
4. **Watch**: monitors and dashboards over spans and evaluation results, with alerts.

Tracing is built. The others are later stages.

## Ingest

- OTLP/HTTP `POST /ingest/otlp/v1/traces`, protobuf or JSON, optionally gzip, with an ingest key in `x-ingest-key` or a Bearer header.
- App routing: the `x-project-name` header, else resource attribute `openinference.project.name`, else `service.name`.
- Span kind from `openinference.span.kind`: `LLM`, `CHAIN`, `AGENT`, `TOOL`, `RETRIEVER`, `EMBEDDING`, `RERANKER`, `GUARDRAIL`, `EVALUATOR`, `PROMPT`, `DECISION`, else `UNKNOWN`.

## Span attributes read first

| Area | Keys |
| --- | --- |
| Input and output | `input.value`, `input.mime_type`, `output.value`, `output.mime_type` |
| Model | `llm.model_name`, `llm.provider`, `llm.system`, `llm.invocation_parameters` (JSON string) |
| Messages | `llm.input_messages.{i}.message.role` / `.content`, `llm.output_messages.{i}...`, `...message.tool_calls.{j}.tool_call.function.name` / `.arguments` |
| Tokens | `llm.token_count.prompt` / `.completion` / `.total`, cache read and write details, reasoning details |
| Cost | `llm.cost.prompt` / `.completion` / `.total` (USD), stored as integer micros |
| Retrieval | `retrieval.documents.{i}.document.id` / `.content` / `.score` / `.metadata` |
| Tools | `tool.name`, `tool.description`, `tool.parameters` |
| Context | `session.id`, `user.id`, `metadata` (JSON string), `tag.tags` |
| Coding tools | `harness.name` and the other names written by `public/trace/geo-trace.mjs` |

Lists of objects arrive flattened, one attribute per leaf: `<prefix>.<index>.<item>.<field>`.

## Storage decisions

- `trace_apps`, `llm_spans` (key `tenant_id, trace_id, span_id`), `llm_traces` (a summary recomputed from stored spans), `trace_reports` (one per person per day).
- Parent ids are plain strings with no foreign key, so spans may arrive in any order and orphans are kept.
- Ingest is idempotent: a resent span replaces the stored one only when its `end_ms` is later.
- Tokens count only on `LLM`, `EMBEDDING` and `DECISION` spans, so nested spans are not counted twice.
- An app is `app` or `coding_tool`; people views count coding tools unless an app is chosen.
- Retention is 92 days (`TRACE_RETENTION_DAYS`), pruned hourly, with CSV and JSON Lines export.

## Evaluation result (later stage)

One shape everywhere: `name`, `label`, `score`, `explanation`, `annotator_kind` (`LLM`, `CODE`, `HUMAN`), optional `identifier` and metadata. Upsert key is (name, target, identifier).

## How it maps onto what GEO Observability already has

| Tracing concept | Existing piece |
| --- | --- |
| LLM span | `chat <engine>` span from `src/lib/otel.ts` |
| Trace | `geo.run`, one per prompt × engine × country × day |
| Evaluator | `src/judge/` (mention matching as code, the Workers AI judge as LLM) |
| Dataset | The tracked prompt set per client |
| Experiment | A pass |
| Tenancy | `TenantDB` |
