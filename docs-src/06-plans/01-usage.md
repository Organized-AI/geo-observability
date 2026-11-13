---
title: What counts as usage
section: Plans and usage
order: 1
description: How answers and model spend are counted, and how the monthly spend cap works.
---

Usage comes down to two numbers: how many answers we run, and what those answers cost in model fees. You'll find both under **Usage & API**.

## Answers run

One answer is one prompt, asked once, on one engine, for one country. Each pass runs:

```text
answers per pass = active prompts × enabled engines × selected countries
```

| Setup | Per pass | Daily, 30 days |
|---|---|---|
| 10 prompts × 4 engines × 1 country | 40 | 1,200 |
| 50 prompts × 4 engines × 2 countries | 400 | 12,000 |
| 100 prompts × 3 engines × 3 countries | 900 | 27,000 |

Suggested and archived prompts don't run, so they don't count. Manual passes count the same as scheduled ones.

## Model spend

Each answer costs money at the engine's provider: tokens in, tokens out, and the search the engine does. For every answer we record an **estimated cost** worked out from the tokens it used and a price table for its model. The Usage page adds these up for the month, overall and by engine.

These are estimates. Your provider's bill is the final word, and the AI Gateway logs are what to reconcile against. See [Cost and run log](/docs/cost-and-run-log/).

The judge that scores sentiment and extracts attributes runs on Workers AI. It's a separate, small cost on your Cloudflare account.

## The monthly spend cap

The spend cap is a ceiling on estimated model spend for the month. Once estimated spend reaches it, further runs that month are skipped (they show as skipped with the reason "monthly model spend cap reached") until the month rolls over or the cap is raised. Stub runs cost nothing and aren't counted. The Usage page shows spend so far against the cap, so you can see how close you are before a pass starts. If you're running near the cap, trim answers per pass by archiving weak prompts, dropping an engine or country, or switching to a weekly schedule.

## Plan limits

Your plan sets limits on the number of prompts, projects, engines and countries. You can see them on the Usage page.

## Billing

Card billing and invoices are not switched on yet. The Usage page shows your usage and estimated spend, but nothing is charged to a card through the portal today.
