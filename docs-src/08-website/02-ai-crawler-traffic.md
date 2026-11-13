---
title: AI crawler traffic
section: Your website and traffic
order: 2
description: Which AI bots fetch your site, why, and how often.
---

The Crawlers view shows which AI bots fetch your pages, grouped by bot and by what the bot is for. It needs the [edge tap](/docs/edge-tap-setup/), because crawlers don't run JavaScript and tap.js can't see them.

## Three kinds of bot

| Type | What it does | Examples |
|---|---|---|
| Training | Collects pages to train future models | GPTBot, ClaudeBot |
| Search | Builds the index an assistant searches when it answers | OAI-SearchBot, Claude-SearchBot, PerplexityBot |
| User | Fetches a page live, because a person asked something just now | ChatGPT-User, Claude-User, Perplexity-User |

Google's crawlers and other operators' bots are classified the same way. The view lists every bot by name with its operator, so you can see exactly who visited.

Note that Google-Extended is a robots.txt setting, not a separate crawler, so it never appears as a bot here.

## Why the difference matters

- **Training hits** shape what models know in the long run. They don't affect today's answers.
- **Search hits** decide whether your pages are in the index an assistant searches. If a search bot can't reach a page, that assistant can't cite it.
- **User hits** are the closest thing to a live signal. Each one means an assistant read your page to answer someone's question. In the [Pages table](/docs/pages-table/) these are called **retrievals**.

If you block bots in robots.txt or with firewall rules, block by type deliberately. Blocking a training bot doesn't stop the matching search bot, and blocking a search bot can keep you out of that assistant's citations.

## The views

- **By bot**: hits per bot, with operator and type.
- **Trend**: hits per day, split by type.

The daily [insights](/docs/overview/#insights) flag cited pages that bots stopped fetching, and those can become **fix crawl** [actions](/docs/actions/).

## Limits

- Classification is by **user agent only**. A request that fakes a known bot's user agent is counted as that bot.
- Requests your Cloudflare security settings block before the Worker runs never reach the tap, so they aren't counted.
