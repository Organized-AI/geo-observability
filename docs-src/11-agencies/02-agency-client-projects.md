---
title: Managing client projects
section: Agencies
order: 2
description: Routines and habits that keep many client projects healthy.
---

Running many clients is mostly about consistency. These habits keep every project trustworthy.

## Use the same structure everywhere

Agree a standard set of tags and use it in every client project:

- `funnel:learn`, `funnel:compare`, `funnel:buy`
- `branded` for prompts that name the client
- `persona:<name>` for persona prompts

Saved views with the same names in each project, such as "Non-branded" and "Last 30 days", make it quick to move between clients.

## A weekly check per client

1. Read the [insights](/docs/overview/#insights) for the week.
2. Check the answer count and look for failed answers or stub answers in the [run log](/docs/cost-and-run-log/).
3. Review new suggested competitors and accept or reject them.
4. Work through open [actions](/docs/actions/) with the client's team, and mark them done or dismissed.
5. If the client has the [observability layer](/docs/observability-layer/), scan the [Pages table](/docs/pages-table/) for crawl drops on cited pages.

## Reporting

- **Monthly PDF**: print the Overview with the month as the date range.
- **Spreadsheet**: export the metrics and chats CSVs.
- **Live dashboard**: a share link to a saved view.
- **Automated**: pull numbers into your own reporting with the [API](/docs/api-reports/), or ask questions across clients from your assistant with the [MCP server](/docs/mcp-introduction/).

## Keep usage in check

Each client's usage is its own. Before adding prompts, engines or countries, check the effect on answers per pass:

```text
active prompts × enabled engines × selected countries
```

Switching a quieter client to a weekly schedule cuts its usage to about a seventh. See [What counts as usage](/docs/usage/).

## Pausing a client

Set the schedule to **paused** when an engagement ends. History stays available, and nothing new runs.
