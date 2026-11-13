---
title: "MCP server: tools"
nav: "MCP server: tools"
section: Integrations
order: 7
description: The tools the MCP server offers, and what each one returns.
---

The MCP server offers eight read-only tools. Your assistant chooses between them, so you rarely need to name one, but knowing what's there helps you ask good questions.

| Tool | What it returns | Ask things like |
|---|---|---|
| `list_projects` | Projects you can see | "Which projects do we track?" |
| `brand_report` | Brand metrics: visibility, share of voice, position, sentiment, win rate, cited rate | "How did our visibility change by engine this month?" |
| `list_chats` | Answers, with brands named and ranks | "Show recent ChatGPT answers that didn't mention us." |
| `get_chat` | One answer in full: text, mentions, citations, claims | "Read me that answer and its sources." |
| `top_sources` | The domains cited most often | "Which sites do assistants cite most for our topics?" |
| `list_insights` | The daily insight sentences | "What changed this week?" |
| `list_actions` | Suggested actions and their status | "What should we work on next?" |
| `website_pages` | The Pages table: crawls, retrievals, citations, sessions, conversions | "Which pages get cited but never visited?" |

## Tips

- **Name the project** if you have more than one, or ask the assistant to list projects first.
- **Give a date range.** "Last 30 days" or "1 to 13 November" keeps answers focused.
- **Ask for the evidence.** "Show me the chats behind that" makes the assistant pull the actual answers, so you can check its summary.
- **Combine tools.** "Find prompts where we lost visibility, then show the sources cited in those answers" uses several tools in one go.

## Limits

- Every tool is read-only.
- The same [rate limit](/docs/api-authentication/#rate-limit) applies as for the API: 120 requests per minute per key. A long, multi-step question can make many calls.
- Numbers follow the same definitions as the portal. See the [Metrics glossary](/docs/metrics-glossary/).
