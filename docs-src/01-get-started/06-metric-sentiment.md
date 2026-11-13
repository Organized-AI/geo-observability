---
title: "Metrics: Sentiment"
nav: Sentiment
section: Get started
order: 6
description: Sentiment scores each mention of your brand from 0 to 100, where 50 is neutral.
---

Sentiment tells you how warmly answers talk about you.

## Definition

Each mention of a brand gets a score from **0 to 100**. 50 is neutral, higher is more positive, lower is more negative. **Sentiment is the average of those scores** across the answers in your filter.

## How it's scored

An LLM judge (Workers AI, called through the same Cloudflare AI Gateway as the engines) reads the answer and scores how each tracked brand is described.

If the judge call fails, a rules-based fallback scores sentiment from the wording instead, and the answer is marked **rules**. The fallback is cruder: it picks up obvious praise and complaints but misses nuance and sarcasm. If a sentiment swing coincides with lots of answers marked rules, treat it with caution.

## Example

Three answers mention you. The judge scores them 72, 55 and 41. Sentiment is (72 + 55 + 41) ÷ 3 = **56**.

## Reading it

- Most answers are fairly neutral, so the average tends to sit between 50 and 70. Small moves of a point or two are usually noise.
- A low score is a prompt to read the chat. The [Objections](/docs/objections/) and [Fact-checking](/docs/fact-checking/) views usually explain why.

## Related

- [Attributes](/docs/attributes/) lists the words assistants use about you.
