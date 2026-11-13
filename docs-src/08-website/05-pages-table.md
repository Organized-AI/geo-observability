---
title: The Pages table
section: Your website and traffic
order: 5
description: One row per page of your site, from crawl to citation to conversion.
---

The Pages table is where the observability layer pays off. Each row is one path on your site, with everything we know about it for the date range.

## The columns

| Column | Meaning | From |
|---|---|---|
| Path | The URL path, such as `/guides/cold-brew` | |
| Bot hits | All AI crawler requests, split into training and search | Edge tap |
| Retrievals | Live fetches by user-type bots, such as ChatGPT-User | Edge tap |
| Citations | Times tracked answers cited this page | Answers |
| Cited answers | Tracked answers that cited it at least once | Answers |
| Citation rate | Cited answers ÷ all tracked answers in the range | Answers |
| Sessions | AI-referred visits that landed here | Edge tap or tap.js |
| Conversions | Conversions whose landing path is this page | Conversion events |
| Revenue | Value of those conversions | Conversion events |

Expand a row to see **the prompts whose answers cited this page** in the range, with how many times each did.

Totals for every numeric column sit at the top.

## Reading a row left to right

The columns follow the path from crawl to customer:

1. **Is it crawled?** No bot hits on an important page is worth checking: robots.txt, firewall rules, or the page isn't linked from anywhere.
2. **Is it fetched live?** Retrievals mean assistants read it to answer real questions right now.
3. **Is it cited?** Citations show it's credited as a source.
4. **Do people click through?** Sessions per citation shows whether the answer sends people on.
5. **Do they convert?** Conversions and revenue close the loop.

## Patterns to look for

- **Retrieved but rarely cited.** Assistants read the page but credit someone else. Make the key facts easier to quote.
- **Cited but no sessions.** The answer may cover everything people needed. Fine for awareness, less so for sales.
- **Sessions but no citations.** Visitors arrive from assistants on prompts you don't track. Consider adding some.
- **High converting, low cited.** Your best pages for AI visitors deserve to be cited more. Good candidates for a [refresh](/docs/actions/).

## About the prompt link

Visits are linked to prompts by **landing page and day**. If a tracked prompt's answers cited this page on a given day, and AI visitors landed here that day, the two are shown together. It's a useful approximation, but we can't see what any visitor actually asked.
