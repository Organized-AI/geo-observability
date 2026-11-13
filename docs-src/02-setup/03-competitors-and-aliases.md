---
title: Competitors and aliases
section: Set up your project
order: 3
description: How brands are matched in answers, and how to set up your brand and competitors.
---

Every metric depends on spotting brand names in answer text. This page explains how that works and how to set it up well.

## Your brand and competitors

Your project has one **own brand** (you) and any number of competitors. Each brand has:

| Field | What it's for |
|---|---|
| Name | The main name to look for. |
| Aliases | Other names people use: short forms, old names, product names. |
| Pattern | An optional regular expression for tricky cases. |
| Domains | Websites the brand owns. Used to label sources and work out [cited rate](/docs/metric-cited-rate/). |
| Socials | The brand's social profiles, for reference. |
| Colour | Used in charts. |

## How matching works

Matching is deterministic, so the same text always gives the same result:

- The name, every alias and the pattern are searched for in the answer text.
- Matching is **case-insensitive**: "fernhill" matches "Fernhill".
- Matching respects **word boundaries**: "Fern" won't match inside "Fernhill".
- **Rank** follows the order in which each brand *first* appears.

## Aliases

Add every name an assistant might use. For a brand called "Fernhill Coffee Roasters" you might add:

- `Fernhill`
- `Fernhill Coffee`
- `Fernhill Roasters`

Watch out for aliases that are ordinary words. An alias like `Bloom` will match every answer that explains coffee blooming. If a short name is ambiguous, leave it out or use a pattern instead.

## Patterns

A pattern is a regular expression, applied case-insensitively. Use it when aliases can't express what you need, for example a name with optional spacing:

```text
\bnorth\s?roast\b
```

This matches "Northroast", "North Roast" and "north roast". Test a new pattern by reading a few [chats](/docs/reading-chats/) afterwards. A pattern that's too loose will inflate every metric for that brand.

## Suggested competitors

The judge that reads each answer also notes brands it doesn't recognise from your list. They appear as **suggested** competitors. Accept the ones that matter, reject the rest. Rejected brands stay hidden from suggestions.

Only active competitors count in [share of voice](/docs/metric-share-of-voice/), [position](/docs/metric-position/) and [win rate](/docs/metric-win-rate/). Adding or removing one changes those numbers, so note the date when you compare periods.

## Domains

List every domain each brand owns. Domains decide whether a cited source is labelled *own* or *competitor* in [Sources](/docs/sources-domains/), and your own domains are what [cited rate](/docs/metric-cited-rate/) counts.
