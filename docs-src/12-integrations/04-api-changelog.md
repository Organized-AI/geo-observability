---
title: "API: changelog"
nav: "API: changelog"
section: Integrations
order: 4
description: Changes to the public API.
---

## v1

The first public version of the API.

- `GET /api/v1/projects`, `GET /api/v1/prompts` and `GET /api/v1/chats`.
- `POST /api/v1/reports/brands`, `/domains` and `/urls`, with dimensions (`date`, `engine`, `country`, `topic`, `prompt`), `in` / `not_in` filters, ordering, paging and previous-period comparison.
- `X-API-Key` authentication with `read` and `ingest` scopes.
- A rate limit of 120 requests per minute per key.
- An MCP server at `/mcp` for AI assistants, using a read key as a bearer token.

## Writing clients that last

- Ignore fields you don't recognise. New fields may be added to responses.
- Match on the `error` code, not the `message` text.
- Treat ids as opaque strings.
