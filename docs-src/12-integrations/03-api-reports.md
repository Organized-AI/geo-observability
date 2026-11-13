---
title: "API: reports, dimensions and filters"
nav: "API: reports"
section: Integrations
order: 3
description: Build brand, domain and URL reports with dimensions, filters, ordering and period comparison.
---

Three report endpoints share one request format:

| Endpoint | Rows describe |
|---|---|
| `POST /api/v1/reports/brands` | Brands: visibility, share of voice, position, sentiment, win rate, cited rate, answers |
| `POST /api/v1/reports/domains` | Cited domains: type, citations, answers, share |
| `POST /api/v1/reports/urls` | Cited URLs: citations, answers, cited and used counts |

## Request body

```json
{
  "project_id": "<project id>",
  "start_date": "2026-11-01",
  "end_date": "2026-11-13",
  "dimensions": ["engine"],
  "filters": [
    { "field": "country", "operator": "in", "values": ["US", "GB"] }
  ],
  "order_by": [{ "field": "visibility", "direction": "desc" }],
  "limit": 100,
  "offset": 0,
  "compare_previous": true
}
```

| Field | Required | Notes |
|---|---|---|
| `project_id` | Yes | From `GET /api/v1/projects` |
| `start_date`, `end_date` | Yes | `YYYY-MM-DD`, UTC, inclusive |
| `dimensions` | No | How to split rows. Any of `date`, `engine`, `country`, `topic`, `prompt` |
| `filters` | No | Narrow the answers included |
| `order_by` | No | Sort rows by a dimension or metric, `asc` or `desc` |
| `limit`, `offset` | No | Page through long results |
| `compare_previous` | No | Add values for the previous period of the same length |

## Dimensions

With no dimensions, you get totals for the whole range. Each dimension you add splits the rows further:

- `["date"]`: one row per day, for trend lines.
- `["engine"]`: one row per engine.
- `["engine", "country"]`: one row per engine and country pair.
- `["prompt"]`: one row per prompt, like the Prompt performance view.

## Filters

Each filter has a `field`, an `operator` (`in` or `not_in`) and a list of `values`. Filters are combined, so all must match.

```json
"filters": [
  { "field": "engine", "operator": "in", "values": ["chatgpt", "perplexity"] },
  { "field": "topic", "operator": "not_in", "values": ["<topic id>"] }
]
```

Engine values are `chatgpt`, `claude`, `gemini`, `perplexity` and `alexa`. Countries are two-letter ISO codes.

## Comparing periods

With `compare_previous: true`, each row also carries the values for the previous period of the same length, immediately before `start_date`. That's the same comparison the portal uses.

## Example: weekly visibility by engine

```bash
curl -X POST https://<your-host>/api/v1/reports/brands \
  -H "X-API-Key: <read key>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "<project id>",
    "start_date": "2026-11-07",
    "end_date": "2026-11-13",
    "dimensions": ["engine"],
    "compare_previous": true
  }'
```

## Units

Rates are between 0 and 1, so multiply by 100 for a percentage. Position is an average rank, lower is better. Sentiment is 0 to 100. Money is in micros (1 USD = 1,000,000).
