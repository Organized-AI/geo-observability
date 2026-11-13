---
title: Reading chats
section: Read your results
order: 2
description: Every answer we collect is stored in full. Here's how to read one.
---

A "chat" is one answer: one prompt, asked once, on one engine, for one country, on one day. The Chats page lists them all, and every number in the portal can be traced back to them.

## The list

Each row shows the prompt, engine, model, country and date, which tracked brands were named and at what rank, how many sources were cited, and a short excerpt. You can filter to answers that **name you** or answers that **don't**. The second filter is often the more useful one.

## One chat, in full

Open a chat to see:

- **The full answer text**, exactly as the engine returned it.
- **Mentions.** Every tracked brand found, with its rank and a sentiment score.
- **Citations.** Each source shown to the reader, in the order shown, with its domain type.
- **Search queries.** When the engine reports them, the searches it ran to write the answer. These show how the engine reworded the question, which is useful when deciding what content to write.
- **Claims.** Statements about your brand that the judge pulled out, with a verdict from [fact-checking](/docs/fact-checking/).
- **Run details.** Model, channel, estimated cost, latency and the AI Gateway log id. See [Where each number comes from](/docs/where-numbers-come-from/).

## Things to look for

- **Why weren't we named?** Look at which brands were, and which sources the engine cited. If it leaned on a review site that doesn't list you, that's a [get listed](/docs/actions/) opportunity.
- **Is the description right?** Wrong prices, discontinued products and old names show up here first.
- **Is this a stub answer?** Stub answers are sample text for demos. If you see the stub channel, an engine key is missing.
- **Was sentiment scored by rules?** Answers marked *rules* were scored by the fallback, not the judge.

## A reminder about the consumer apps

These are API answers. Someone signed in to the consumer app may get a different answer, shaped by their history, memory, location and a different system prompt. Chats are a consistent, repeatable sample, which is what makes trends meaningful, but they aren't a screenshot of any one person's experience.
