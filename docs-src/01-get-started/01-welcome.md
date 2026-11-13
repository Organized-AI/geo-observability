---
title: Welcome
section: Get started
order: 1
description: GEO Observability tracks how AI assistants talk about your brand, and what that does to your website.
---

GEO Observability by Organized AI shows you how AI assistants answer the questions your buyers ask, whether your brand shows up in those answers, and what happens on your website as a result.

It has two halves that share one project.

## Answer tracking

You give us a list of prompts: the questions real buyers type into ChatGPT, Claude, Gemini and Perplexity. Every day (or every week, if you prefer) we ask each engine every active prompt, store the full answer, and work out:

- whether your brand was named, and where in the answer it came,
- which competitors were named alongside you,
- how the answer described you,
- which web pages the engine cited or read to write it.

From that you get [visibility](/docs/metric-visibility/), [share of voice](/docs/metric-share-of-voice/), [position](/docs/metric-position/), [sentiment](/docs/metric-sentiment/), [win rate](/docs/metric-win-rate/) and [cited rate](/docs/metric-cited-rate/), broken down by engine, country, topic and tag.

## The observability layer

Answers are only half the story. The other half happens on your own site: AI crawlers fetching your pages, assistants fetching a page live while someone waits for an answer, and people clicking through from an assistant and then buying or signing up.

The [observability layer](/docs/observability-layer/) captures those events with a small Cloudflare Worker on your zone, a script tag, or server-side conversion events. The [Pages table](/docs/pages-table/) then lines everything up per URL: crawled, fetched, cited, visited, converted.

## What it won't tell you

We'd rather you know this up front:

- **API answers are not the consumer app.** We ask each engine through its developer API. A signed-in person using the app may see a different answer because of personalisation, memory, location and a different system prompt. Treat the numbers as a consistent sample, not a recording of what every user sees.
- **Alexa can't be tracked.** Amazon offers no public way to ask Alexa+ a question and read the answer, so it's listed as unavailable.
- **Linking a visit to a prompt is an estimate.** Nobody can see which question a visitor typed before clicking. We match by landing page and day, and say so wherever that join appears.

## Where to go next

- New here? Start with the [Quickstart](/docs/quickstart/).
- Setting up prompts? Read [Writing good prompts](/docs/writing-prompts/).
- Wiring up your site? See [How the observability layer works](/docs/observability-layer/).
- Building on the data? Jump to the [API](/docs/api-introduction/) or the [MCP server](/docs/mcp-introduction/).
