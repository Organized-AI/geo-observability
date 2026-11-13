---
title: Engines reference
section: Reference
order: 4
description: How we query each engine, what sources it reports, and its limits.
---

All engine calls go through **Cloudflare AI Gateway**, which logs each request with its cost and latency. The model used is recorded on every answer.

## ChatGPT

- **How we ask:** OpenAI Responses API with web search turned on.
- **Sources:** cited sources, the links shown to the reader. Used-but-not-shown sources aren't reported.
- **Country:** sent to the web search tool as an approximate user location.

## Claude

- **How we ask:** Anthropic Messages API with the web search tool.
- **Sources:** cited sources and used sources.
- **Country:** sent to the web search tool as an approximate user location.

## Gemini

- **How we ask:** Gemini API with Google Search grounding.
- **Sources:** cited sources and used sources.
- **Country:** not sent: the Gemini API's search grounding has no location setting, so results reflect Google's defaults.

## Perplexity

- **How we ask:** Perplexity's Sonar API.
- **Sources:** cited sources and used sources.
- **Country:** sent as an approximate user location in the web search options.

## Alexa

Listed, but **not trackable**. Amazon offers no public way to send Alexa+ a question and read its answer, so Alexa always shows as unavailable and produces no answers.

## Stub engines

If an engine has no API key configured, it runs on a **stub** engine instead. The stub produces sample answers for demos and testing, and its answers are clearly labelled with the `stub` channel.

Stub answers aren't filtered out of anything automatically. They count in every metric like real answers. **Administrators should add API keys for every engine before reporting results to a client.**

## API answers versus the apps

We ask each engine through its developer API. A signed-in person in the consumer app can get a different answer because of:

- **personalisation and memory**, from their past conversations,
- **location and language**, taken from their device and account,
- **a different system prompt** and sometimes a different model or search setup in the app.

API answers are a consistent, repeatable sample of what each engine says. That's what makes trends meaningful. They aren't a copy of any one person's screen.
