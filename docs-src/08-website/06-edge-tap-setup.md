---
title: Setting up the edge tap (Cloudflare zones)
nav: Setting up the edge tap
section: Your website and traffic
order: 6
description: Deploy the edge tap Worker on your Cloudflare zone to capture AI crawlers and referrals.
---

The edge tap is a small Cloudflare Worker that runs on your own zone. It's the best option if your site is on Cloudflare, because it sees AI crawlers as well as visitors.

## What it does

For every request on its route, the Worker:

1. passes the request to your site untouched and returns the response as normal,
2. **after** the response has gone out, checks whether the request was an AI crawler or an AI-referred arrival,
3. if so, sends a small event to `/ingest/edge` with your ingest key.

Each event holds the time, host, path, user agent, referrer, response status, country and utm_source. It doesn't change your pages, set cookies or add anything to the response. Because the event is sent after responding, your visitors don't wait for it.

## Before you start

- Your site's DNS is on Cloudflare, proxied (orange cloud).
- You can deploy Workers in the Cloudflare account that holds the zone.
- You have Node.js and Wrangler, Cloudflare's command-line tool.

## 1. Create an ingest key

Under **Usage & API**, create a key with scope **ingest**. The secret is shown once, so copy it now.

## 2. Get your values

Open the project's **Tracking** settings. It shows the ingest endpoint, your project id, and the variables the edge Worker needs, along with where its code lives in the repository.

## 3. Add a route

In the Worker's Wrangler config, add a route for your site. For example:

```jsonc
{
  "routes": [
    { "pattern": "www.fernhill.example/*", "zone_name": "fernhill.example" }
  ]
  "vars": {
    "INGEST_URL": "https://<your-host>/ingest/edge",
    "PROJECT_ID": "<project id>"
  }
}
```

Add a route for each hostname you want covered, such as the bare domain and `www`.

## 4. Store the key as a secret

Keep the ingest key out of your config file. The secret is called `INGEST_KEY`:

```bash
npx wrangler secret put INGEST_KEY --config edge/wrangler.jsonc
```

## 5. Deploy

```bash
npx wrangler deploy
```

## 6. Check it's working

Visit a page with a link that carries an AI utm_source, for example `https://www.fernhill.example/?utm_source=chatgpt.com`. A session should then appear under [AI referrals](/docs/ai-referrals/). Crawler hits appear under [AI crawler traffic](/docs/ai-crawler-traffic/) as real bots visit.

Your test visit is counted like any other, so use a page you don't mind seeing in the numbers.

## Things to know

- **One Worker per route.** Cloudflare runs only one Worker for a given request. If you already have a Worker on the same route, the tap won't run alongside it. You'll need to add the tap's logic to your existing Worker instead.
- **It counts as Workers usage.** Every request on the route invokes the Worker, so it counts toward your Cloudflare Workers request usage.
- **Blocked requests aren't seen.** Requests your security rules block before the Worker runs never reach it.
- **If our endpoint is down, your site isn't.** The event is sent after your response, so a failed send doesn't affect visitors.
