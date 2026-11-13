---
title: How the observability layer works
section: Your website and traffic
order: 1
description: Three ways to capture what AI does on your site, and how they come together per page.
---

Answer tracking tells you what assistants say. The observability layer tells you what they, and the people using them, do on your website.

## What it captures

| Event | Example | Captured by |
|---|---|---|
| AI crawler hits | GPTBot fetching your pricing page | Edge tap |
| Live fetches | ChatGPT-User fetching a page while someone waits for an answer | Edge tap |
| AI-referred arrivals | A person clicks a link in a Perplexity answer and lands on your site | Edge tap or tap.js |
| Conversions | That person later buys or signs up | Server-side conversion events |

## The three inputs

**1. The edge tap.** A small Cloudflare Worker that you deploy on your own zone's route. It passes every request through untouched, and after the response has gone out, it sends AI crawler hits and AI-referred arrivals to us. This is the most complete option, because it sees crawlers that never run JavaScript. [Set up the edge tap](/docs/edge-tap-setup/).

**2. tap.js.** A script tag for sites that aren't on Cloudflare. It sends one small beacon per page view, only when the visitor arrived from an AI assistant. It can't see crawlers. [Set up tap.js](/docs/tap-js-setup/).

**3. Server-side conversions.** You send conversion events from server-side Google Tag Manager or your own server, tagged with where they came from: sGTM, GA4, Google Ads, Meta, TikTok or Shopify. [Send conversions](/docs/sgtm-conversions/).

All three authenticate with an **ingest key**, an API key that can send events but can't read anything. Create one under **Usage & API**.

## How it comes together

```text
  your site's traffic                       answers we collect
  ───────────────────                       ──────────────────
  crawler hits    ─┐                        ┌─ citations of your URLs
  live fetches    ─┼──►  per path, per day ◄┼─ prompts that cited them
  AI referrals    ─┤                        │
  conversions     ─┘                        │
                         ▼
                   the Pages table
```

The [Pages table](/docs/pages-table/) joins all of it per URL path and day. For each page you see how often it was crawled, fetched, cited, visited from an assistant, and converted.

## What it can't do

- **It can't see the question.** Assistants don't pass the user's prompt to your site. We link visits to prompts by landing page and day: if answers to a tracked prompt cited a page, and someone arrived on that page from an assistant that day, we show them side by side. That's a reasonable guess, not a fact. The visitor may have asked something you don't track.
- **Referrers go missing.** Many app-based assistants open links without a referrer. Those visits look like direct traffic and we can't count them. Treat AI referral numbers as a floor.
- **User agents can be faked.** Crawlers are classified by user agent. A scraper that calls itself GPTBot is counted as GPTBot.

## Next

- [AI crawler traffic](/docs/ai-crawler-traffic/)
- [AI referrals](/docs/ai-referrals/)
- [Conversions](/docs/conversions/)
