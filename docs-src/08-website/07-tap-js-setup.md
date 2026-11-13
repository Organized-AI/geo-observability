---
title: Setting up tap.js (any site)
nav: Setting up tap.js
section: Your website and traffic
order: 7
description: Add one script tag to count AI-referred visits on sites that aren't on Cloudflare.
---

tap.js is a small script for sites that can't run the [edge tap](/docs/edge-tap-setup/). It counts visitors who arrive from an AI assistant.

## What it does

On each page view, tap.js checks whether the visitor came from an AI assistant, using the referrer or the `utm_source` in the URL. If they did, it sends **one** small beacon with the page URL, the referrer and the utm_source. If they didn't, it sends nothing.

## What it can't do

- **It can't see crawlers.** AI crawlers fetch your HTML without running scripts, so tap.js never runs for them. For crawler data you need the edge tap.
- **It can be blocked.** Content blockers and strict browser settings may stop the beacon.
- **It only sees what the browser sees.** If an assistant app opens your link without a referrer or utm_source, the visit can't be recognised.

## 1. Create an ingest key

Under **Usage & API**, create a key with scope **ingest**. The secret is shown once.

## 2. Copy the snippet

Open the project's **Tracking** settings and copy the tap.js snippet. It already includes your project; paste your ingest key into data-key. It looks something like this:

```html
<script async src="https://<your-host>/tap.js" data-project="<project id>" data-key="<ingest key>"></script>
```

Always copy the exact snippet from the Tracking page rather than typing it by hand.

## 3. Add it to every page

Paste it before the closing `</head>` tag in your site template, or add it as a Custom HTML tag in your tag manager, firing on all pages.

## 4. Check it's working

Open `https://your-site.example/?utm_source=chatgpt.com` in a browser. A session should then appear under [AI referrals](/docs/ai-referrals/).

## About the key in your page

The ingest key is visible to anyone who views your page source. That's expected: an ingest key can only send events, it can't read any of your data. If you ever see junk events, create a new ingest key, update the snippet, and delete the old key.

## Privacy

The beacon carries the page URL, the referrer and the utm_source, and only for AI-referred visits. Check with your own privacy advisers whether your consent setup needs to cover it.
