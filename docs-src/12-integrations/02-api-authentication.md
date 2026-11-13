---
title: "API: authentication and rate limits"
nav: "API: auth and rate limits"
section: Integrations
order: 2
description: Create API keys, choose a scope, and stay within the rate limit.
---

## Creating a key

Go to **Usage & API** and create a key. Give it a name that says what it's for, such as "Looker sync" or "sGTM conversions", and choose a scope:

| Scope | Can do |
|---|---|
| `read` | Read data through the API and the MCP server |
| `ingest` | Send events to the ingest endpoints: edge tap, tap.js and conversions |

The secret is **shown once**, when you create the key. Copy it somewhere safe straight away. Afterwards the portal only shows the key's prefix, scope, when it was created and when it was last used.

## Using a key

Send it in the `X-API-Key` header:

```bash
curl https://<your-host>/api/v1/prompts?project_id=<project id> \
  -H "X-API-Key: <read key>"
```

For the MCP server, send a read key as a bearer token instead. See [MCP server: setup](/docs/mcp-setup/).

## Keeping keys safe

- Use one key per integration. The "last used" date then tells you which integrations are alive.
- Use the smallest scope that works. A dashboard needs `read`. A tracking tag needs `ingest`.
- Never put a `read` key in a web page or app that runs in a browser. Ingest keys in tap.js are fine, because they can't read anything.
- If a key leaks, create a replacement, switch your integration over, then delete the old key.

## Rate limit

Each key can make **120 requests per minute**. Past that, requests are refused with status `429` until the limit refills.

To stay well inside it:

- Ask for what you need in one report call, using dimensions, rather than one call per engine or per day.
- Cache results. For daily projects, answer data changes once a day, after the 06:00 UTC pass.
- When you get a 429, wait and retry with backoff rather than retrying immediately.

## Errors

| Status | Usually means |
|---|---|
| 400 | The request body or parameters are invalid |
| 401 | The key is missing or wrong |
| 403 | The key's scope doesn't allow this |
| 404 | The project or item doesn't exist, or the key can't see it |
| 429 | Rate limit reached |

Every error body has an `error` code and a human-readable `message`.
