---
title: "API: introduction"
nav: "API: introduction"
section: Integrations
order: 1
description: Read your projects, prompts, answers and reports over a simple HTTP API.
---

The API lets you pull GEO Observability data into your own dashboards, spreadsheets and scripts.

## Base URL

```text
https://<your-host>/api/v1
```

Every request needs an API key in the `X-API-Key` header. See [authentication and rate limits](/docs/api-authentication/).

## Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/projects` | Your projects |
| GET | `/prompts?project_id=` | A project's prompts |
| GET | `/chats?project_id=&from=&to=` | Answers in a date range |
| POST | `/reports/brands` | Brand metrics, split by the dimensions you choose |
| POST | `/reports/domains` | Cited domains |
| POST | `/reports/urls` | Cited URLs |

Reports are covered in [reports, dimensions and filters](/docs/api-reports/).

## Conventions

- Bodies are JSON.
- Dates are `YYYY-MM-DD`, in UTC.
- Rates are between 0 and 1. Position is an average rank, lower is better. Sentiment is 0 to 100.
- Money is in **micros**: 1 USD = 1,000,000 micros.
- Errors return a 4xx or 5xx status with a body like:

```json
{ "error": "<code>", "message": "<human-readable text>" }
```

Use `error` in your code and show `message` to people.

## Your first call

```bash
curl https://<your-host>/api/v1/projects \
  -H "X-API-Key: <read key>"
```

## Prefer to ask in plain language?

The [MCP server](/docs/mcp-introduction/) gives the same data to AI assistants such as Claude, so you can ask "How did our visibility on Perplexity change this month?" instead of writing code.
