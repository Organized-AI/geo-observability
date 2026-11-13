---
title: Where each number comes from
section: Run transparency
order: 1
description: Every metric traces back to stored answers you can open and check.
---

Every number in the portal can be traced back to answers you can read. This page shows the chain, so you can check any figure yourself.

## From pass to metric

```text
pass ─► answer ─► mention detection ─► judge ─► metrics
         │              │                 │
         │              │                 └─ sentiment, attributes, objections, claims, new brands
         │              └─ which tracked brands, in what order (rank)
         └─ full text, citations, used sources, model, cost, latency, gateway log id
```

1. **A pass** asks every active prompt on every enabled engine for every selected country.
2. **Each answer** is stored in full. The raw text is kept in object storage (R2), so you can always read exactly what the engine said.
3. **Mention detection** finds your brand and competitors by name, alias and pattern. It's plain text matching, case-insensitive and on word boundaries, so it gives the same result every time. Rank is the order of first appearance.
4. **The judge**, an LLM on Workers AI called through Cloudflare AI Gateway, scores sentiment, suggests unknown brands, and pulls out attributes, objections and claims. If the judge fails, a rules-based fallback scores sentiment from the wording and the answer is marked **rules**.
5. **Metrics** are counts and averages over the answers in your filter. The definitions are in the [Metrics glossary](/docs/metrics-glossary/).

## What each answer shows

Open any answer from [Chats](/docs/reading-chats/) to see:

| Field | What it tells you |
|---|---|
| Raw text | The full answer as returned |
| Model | The exact model the engine used |
| Channel | `api` for a real engine call, `stub` for a sample answer |
| Estimated cost | Worked out from tokens used and a price table |
| Latency | How long the engine took to answer |
| AI Gateway log id | The id of the request in Cloudflare AI Gateway, for checking against its logs |

## Deterministic and model-made numbers

It helps to know which numbers come from which step:

| From text matching (repeatable) | From the judge (model output) |
|---|---|
| Visibility, share of voice, position, win rate | Sentiment |
| Cited rate and all source counts | Attributes, objections |
| | Fact-check verdicts, suggested competitors |

If a judge-based number looks odd, read the chats behind it. If a matching-based number looks odd, check your [aliases and patterns](/docs/competitors-and-aliases/).

## Stub answers

Answers on the `stub` channel are sample text, produced when an engine has no API key. They're counted in metrics like any other answer. Make sure every engine you report on runs on the `api` channel.
