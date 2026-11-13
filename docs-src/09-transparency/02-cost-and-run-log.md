---
title: Cost and run log
section: Run transparency
order: 2
description: See every pass, every answer's cost and latency, and what failed.
---

The run log lists every pass and the answers in it, with what each one cost and how long it took.

## Passes

Each pass shows:

- **Total**: answers planned for the pass.
- **Done**: answers completed.
- **Running**: answers still in progress.
- **Failed**: answers that couldn't be collected, for example because the engine returned an error.

The same counts drive the live progress bar you see after onboarding or a manual run.

A failed answer has no text, so it isn't included in any metric. A pass with many failures gives you fewer answers to go on. Check the answer count on the [Overview](/docs/overview/) before reading too much into a change.

## Answers

Each answer records its engine, model, country, channel (`api` or `stub`), estimated cost, latency and AI Gateway log id.

## About the cost figures

Costs are **estimates**. We work them out from the tokens each answer used and a price table for each model. They can differ from what your provider bills because:

- providers change prices, and the table may lag,
- some providers charge for web searches separately from tokens, which a token-based estimate may not capture,
- cached or discounted tokens may be billed differently.

Every engine call goes through Cloudflare AI Gateway, which logs the request with its own cost figure. Use the AI Gateway log id on each answer to look it up, and treat your provider's invoice as the final number.

## Using it

- **Compare engines.** The cost per answer differs a lot between engines and models. If one engine adds little to your insight, turning it off cuts spend.
- **Spot slow engines.** High latency doesn't affect your numbers, but a sudden jump can come before failures.
- **Watch the spend cap.** Monthly totals and your cap are on the Usage page. See [What counts as usage](/docs/usage/).
