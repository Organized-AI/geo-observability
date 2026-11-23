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

## Removing traces

An owner can delete an app with all of its traces through the API (`DELETE /api/tracing/apps/<app id>`). There's no button for this in the portal yet, and traces aren't removed automatically after a set time.
