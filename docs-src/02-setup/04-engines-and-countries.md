---
title: Engines and countries
section: Set up your project
order: 4
description: Choose which AI engines to ask and which countries to ask from.
---

Each project runs on the engines and countries you choose. Together with your active prompts, they decide how many answers each pass produces.

## Engines

| Engine | How we ask it |
|---|---|
| ChatGPT | OpenAI Responses API with web search |
| Claude | Anthropic Messages API with the web search tool |
| Gemini | Gemini API with Google Search grounding |
| Perplexity | Sonar API |
| Alexa | Not trackable (see below) |

Every call goes through Cloudflare AI Gateway, which logs the request with its cost and latency. See [Engines reference](/docs/engines-reference/) for details on each.

**Alexa** appears in the list but shows as unavailable. Amazon offers no public way to send Alexa+ a question and read its answer, so there's nothing for us to call.

**Stub engines.** If an engine has no API key configured, it runs on a clearly labelled *stub* that produces sample answers for demos and testing. Stub answers count in your metrics like real ones. Add keys for every engine you report on before you share numbers.

## Countries

Pick the countries you sell in, using their two-letter codes. For each country, we pass an approximate user location to the engine where its API supports one. That nudges search results toward local sources, much as a person in that country would see.

It's an approximation. The engine decides how much weight to give it, and some engines' APIs don't take a location at all. Writing the prompt in the local language and mentioning local context ("in the UK") is the most reliable way to get a local answer.

## How they multiply

Each active prompt runs once per pass on **every enabled engine** for **every selected country**:

```text
answers per pass = active prompts × enabled engines × selected countries
```

25 prompts × 4 engines × 2 countries = 200 answers per pass. With daily passes that's about 6,000 answers a month. See [What counts as usage](/docs/usage/).

## Turning things off

Disabling an engine or country stops new answers for it. Past answers stay, so your reports still show history for the dates it ran. Turn it back on and new answers pick up from the next pass.
