---
title: "Agencies: limits"
nav: Limits
section: Agencies
order: 3
description: The limits that apply per workspace, per project and per API key.
---

## Plan limits

Each workspace's plan sets limits on:

| Limit | What it caps |
|---|---|
| Prompts | Active prompts |
| Projects | Projects in the workspace |
| Engines | Engines you can enable |
| Countries | Countries you can select |

The current limits for a workspace are shown under **Usage & API**.

## Spend cap

Each workspace has a monthly cap on estimated model spend. See [What counts as usage](/docs/usage/#the-monthly-spend-cap).

## Prompt length

Prompts can be up to 200 characters.

## API rate limit

The API allows **120 requests per minute per key**. If you pull data for many clients, give each integration its own key so one busy job can't slow another. See [API: authentication and rate limits](/docs/api-authentication/).

## Share links

Share links expire. The default is 30 days.

## Things that aren't limits, but matter

- **Engine availability.** Alexa can't be tracked, and any engine without an API key runs on the stub channel.
- **Billing.** Workspaces you create for clients aren't billed by card; card billing applies to workspaces people sign up for themselves. See [Card and invoices](/docs/card-and-invoices/).
