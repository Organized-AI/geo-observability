---
title: "LLM tracing: read traces"
nav: "LLM tracing: read traces"
section: Integrations
order: 9
description: Find a run, see where the time and tokens went, and follow a conversation.
---

Open **Traces** in the portal. Traces belong to the workspace, not to one project, so the project picker doesn't change what you see.

## The list

Each row is one run of your app, newest first. The numbers above the table cover everything that matches your filters, not only the rows loaded so far.

- **Date range** uses when the run started, in UTC.
- **App** narrows to one app.
- **Errors** shows runs where any step failed. Failed runs have a red edge.
- **Search** looks in the run's name, the start of its input and the start of its output. Paste a full trace ID to jump to that run.

Tokens and cost count model calls only. A parent step that repeats its children's totals isn't counted twice.

## One trace

Select a run to open it.

- On the left, every step (span) in the order it started, indented under the step that called it. The bar shows when it ran and for how long within the whole run.
- On the right, the selected step. A failed run opens on its first failed step.

A step's **Overview** shows what went in and what came out. For a model call that's the messages, the tools it was offered and any tool it asked for. For a retrieval it's the documents that came back, with scores. **Attributes** lists everything your app sent with the step. **Events** lists things that happened during it, such as an exception.

A step marked **No parent** arrived without the step that called it. That usually means part of the run wasn't sent.

The link to a trace includes the selected step, so you can share exactly what you're looking at with a teammate in the same workspace.

## Conversations

The **Sessions** tab groups runs that share a `session.id`. Select one to see its turns. If the tab is empty, your app isn't setting a session on its spans yet.

## How long traces are kept

Traces are kept for **92 days** (one quarter). After that they're deleted with all of their steps, and can't be brought back.

When traces are within 14 days of being deleted, the Traces page says how many and from before which date.

## Save a copy on your computer

Use **Export** at the top of the Traces page. It saves what's on screen: the date range, app, person, search and Errors filter all apply.

| File | What's in it | Good for |
| --- | --- | --- |
| Traces (CSV) | One row per trace: when, app, person, session, latency, steps, tokens, cost, model, and the start of the input and output | Spreadsheets, quarterly reporting |
| Full traces (JSON Lines) | One trace per line with every step, its attributes and events | A complete archive, or loading into another tool |
| People (CSV) | One row per person: tools, sessions, turns, tokens, last active | Usage by person for the period |

To keep everything, export the full traces once a quarter with the date range set to that quarter. A CSV holds up to 50,000 traces and a JSON Lines file up to 10,000; for more, export a shorter date range at a time.

The files contain whatever your apps and tools sent, including prompts and answers. Store them as carefully as the originals.

## Removing traces sooner

An owner can delete an app with all of its traces through the API (`DELETE /api/tracing/apps/<app id>`). There's no button for this in the portal yet.

## Monthly allowance

Each workspace can store 2,000,000 spans a month (a coding-tool turn is usually 10 to 30 spans). The footer under **Traces** shows this month's use; a notice appears at 80%. Past the allowance, new traces are refused until the next month and senders keep them to retry. Ask for a higher allowance if you need one.

