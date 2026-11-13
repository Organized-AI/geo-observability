---
title: Sending conversions from sGTM
section: Your website and traffic
order: 8
description: Send conversion events from server-side Google Tag Manager to tie AI visits to revenue.
---

If you run server-side Google Tag Manager (sGTM), you're already processing your conversions on a server. Sending a copy here is one more tag.

## What you'll send

`POST https://<your-host>/ingest/conversion` with your ingest key in the `X-Ingest-Key` header and a JSON body:

```json
{
  "project_id": "<project id>",
  "events": [
    {
      "event_id": "order-10482",
      "event_name": "purchase",
      "ts": "2026-11-12T15:04:05Z",
      "landing_path": "/subscriptions/light-roast",
      "utm_source": "chatgpt.com",
      "referrer": "https://chatgpt.com/",
      "value": 54.0,
      "currency": "USD",
      "source": "sgtm"
    }
  ]
}
```

The exact endpoint and headers for your project are on the **Tracking** settings page.

## 1. Create an ingest key

Under **Usage & API**, create a key with scope **ingest**. Copy the secret, as it's shown only once.

## 2. Capture the landing page and referrer

A conversion usually happens pages after the visit started. To link it back, you need to know where the visit began. Record the **landing path**, **referrer** and **utm_source** when the session starts, for example in a first-party cookie set by your web or server container, and read them back when the conversion fires.

## 3. Add an HTTP request tag

In your server container, add a tag that sends a JSON POST request. You can use a JSON HTTP request tag template from the community gallery, or a custom template built on sGTM's `sendHttpRequest` API.

- **URL**: the ingest endpoint from the Tracking page.
- **Headers**: `Content-Type: application/json` and `X-Ingest-Key: <ingest key>`.
- **Body**: the JSON above, filled from your event data and the values you captured in step 2.
- **Trigger**: your conversion events, such as `purchase` or `generate_lead`.

## 4. Use a stable event_id

Set `event_id` to something unique and stable, such as the order number or the same event id you send to Meta or Google Ads. Duplicates with the same `event_id` are counted once, so retries and double-fires don't inflate your numbers.

## 5. Test it

Send a test event with curl:

```bash
curl -X POST "https://<your-host>/ingest/conversion" \
  -H "Content-Type: application/json" \
  -H "X-Ingest-Key: <ingest key>" \
  -d '{"project_id":"<project id>","events":[{"event_id":"test-001","event_name":"purchase","ts":"2026-11-12T15:04:05Z","landing_path":"/","utm_source":"chatgpt.com","value":1,"currency":"USD","source":"sgtm"}]}'
```

A test event is counted like a real one, so use a tiny value and a clearly named id.

## Other sources

The same endpoint takes events from other server-side setups. Set `source` to `ga4`, `google_ads`, `meta`, `tiktok` or `shopify` to say where each one came from. See [Conversions](/docs/conversions/).
