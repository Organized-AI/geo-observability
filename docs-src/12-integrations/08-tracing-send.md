---
title: "LLM tracing: send traces"
nav: "LLM tracing: send traces"
section: Integrations
order: 8
description: Send traces from your own LLM app over OpenTelemetry and see each run in the portal.
---

If you run your own LLM app (a support assistant, a search feature, an agent), you can send its traces to your workspace. Each run then shows up under **Traces** with the model calls, tool calls and retrievals behind the answer.

Traces arrive over OpenTelemetry's standard protocol (OTLP over HTTP). Any app that already exports OpenTelemetry traces can send them here by changing three settings.

You'll need:

- your endpoint: `https://<your-host>/ingest/otlp`
- an **ingest** API key from **Usage & API**

The **Send traces** button on the Traces page shows the exact endpoint for your workspace.

## Point your exporter here

Most OpenTelemetry SDKs read these environment variables:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://<your-host>/ingest/otlp
OTEL_EXPORTER_OTLP_HEADERS=x-ingest-key=<ingest key>
OTEL_SERVICE_NAME=my-app
```

The exporter adds `/v1/traces` to the endpoint itself. If your SDK asks for the full traces URL, use `https://<your-host>/ingest/otlp/v1/traces`.

The key can also travel as `Authorization: Bearer <ingest key>`.

## Python

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(
    endpoint="https://<your-host>/ingest/otlp/v1/traces",
    headers={"x-ingest-key": "<ingest key>"},
)))
trace.set_tracer_provider(provider)
```

Then add an instrumentation library for the model SDK or framework you use, so each call becomes a span with its messages and token counts. The open-source OpenInference instrumentors cover the common ones, for example:

```python
from openinference.instrumentation.openai import OpenAIInstrumentor
OpenAIInstrumentor().instrument()
```

## Node

```js
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

const provider = new NodeTracerProvider({
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({
    url: "https://<your-host>/ingest/otlp/v1/traces",
    headers: { "x-ingest-key": "<ingest key>" },
  }))],
});
provider.register();
```

This is the form for version 2 of the OpenTelemetry JavaScript SDK. On version 1, create the provider without options and call `provider.addSpanProcessor(...)`.

## Apps

Traces are grouped by app. The app name comes from, in order:

1. an `x-project-name` request header
2. the `openinference.project.name` resource attribute
3. the `service.name` resource attribute
4. otherwise `default`

## What is read from each span

Any span is stored. These attributes make a span show more:

| What you see | Attributes read |
| --- | --- |
| Kind (LLM, tool, retriever, agent…) | `openinference.span.kind`, or `gen_ai.operation.name` |
| Model and provider | `llm.model_name`, `llm.provider`, or `gen_ai.request.model`, `gen_ai.provider.name` |
| Tokens | `llm.token_count.prompt`, `.completion`, `.total`, or `gen_ai.usage.input_tokens`, `.output_tokens` |
| Cost | `llm.cost.total` (US dollars) |
| Input and output | `input.value`, `output.value` |
| Messages and tool calls | `llm.input_messages.*`, `llm.output_messages.*`, or `gen_ai.input.messages`, `gen_ai.output.messages` |
| Retrieved documents | `retrieval.documents.*` |
| Conversation | `session.id`, or `gen_ai.conversation.id` |
| User | `user.id` |

Cost is shown only when your app sends it. We don't work it out from token counts yet.

## Limits

- 4 MB per request (16 MB after decompression) and 2,000 spans per request. Extra spans are reported back as rejected.
- 600 requests a minute per key.
- 50 apps per workspace. Names past that go to `default`.
- A text value longer than 32,000 characters is cut, and the span is marked so you can tell.
- Protobuf and JSON bodies are accepted, with gzip or deflate compression.

Sending the same span twice is safe: the second copy is ignored.

Traces are kept for 92 days, then deleted. Export them from the Traces page to keep a copy.

## What you're storing

Traces usually contain what your users typed and what your app answered. Send only what you're allowed to keep. OpenInference instrumentors can hide inputs and outputs with settings such as `OPENINFERENCE_HIDE_INPUTS` and `OPENINFERENCE_HIDE_OUTPUTS`.
