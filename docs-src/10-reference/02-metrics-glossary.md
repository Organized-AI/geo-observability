---
title: Metrics glossary
section: Reference
order: 2
description: Exact definitions of every metric and term used in the portal.
---

## Metrics

| Metric | Definition | Range |
|---|---|---|
| Visibility | Answers that name your brand ÷ answers in the filter | 0–100% |
| Share of voice | Your brand's mentions ÷ mentions of all tracked brands (yours plus competitors) in those answers | 0–100% |
| Position | Average rank in answers that name you. 1 = named first. Lower is better | 1 and up |
| Sentiment | Average of per-mention scores. 50 = neutral | 0–100 |
| Win rate | Of answers that name you and at least one tracked competitor, the share where you're named before every competitor | 0–100% |
| Cited rate | Answers that cite at least one of your domains ÷ answers in the filter | 0–100% |
| Answers | Number of answers the numbers are based on | count |

**Comparisons** always use the previous period of the same length, immediately before the selected range.

## Website metrics

| Metric | Definition |
|---|---|
| Bot hits | Requests from AI crawlers, by type: training, search or user |
| Retrievals | Live fetches by user-type bots, such as ChatGPT-User |
| Citations | Times tracked answers cited a page |
| Cited answers | Tracked answers that cited a page at least once |
| Citation rate | Cited answers ÷ all tracked answers in the range |
| Sessions | Visits that arrived from an AI assistant, by referrer or utm_source |
| Conversions | Server-side conversion events, deduplicated by event_id |
| Revenue | Sum of conversion values as sent |

## Terms

| Term | Meaning |
|---|---|
| Prompt | A question we ask the engines. Up to 200 characters |
| Answer (chat) | One prompt, asked once, on one engine, for one country |
| Pass | One run of every active prompt on every enabled engine for every selected country |
| Engine | An AI assistant we query through its API: ChatGPT, Claude, Gemini, Perplexity |
| Channel | `api` for a real call, `stub` for a sample answer when no key is set |
| Mention | A tracked brand found in answer text by name, alias or pattern |
| Rank | A brand's order of first appearance among tracked brands in an answer |
| Judge | The LLM on Workers AI that scores sentiment and extracts attributes, objections and claims |
| Rules | The fallback used when the judge fails. Scores sentiment from wording |
| Cited source | A source shown to the reader as a link |
| Used source | A source the engine retrieved but didn't show. Reported by Claude, Gemini and Perplexity |
| Domain type | Own, competitor, editorial, reference, UGC, institutional or other |
| Gap | A domain that appears in answers naming a competitor but not you |
| Insight | A daily sentence about what changed, linked to evidence |
| Action | A suggested next step: get listed, refresh page, new page, fix crawl, fix fact |
| Ingest key | An API key that can send events but not read data |
| Read key | An API key that can read data through the API and MCP server |
