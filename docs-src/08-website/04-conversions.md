---
title: Conversions
section: Your website and traffic
order: 4
description: Tie purchases and sign-ups back to AI-referred visits, using server-side events.
---

Conversions answer the question that matters most: do AI-referred visitors buy, sign up or get in touch?

## Server-side only

Conversions come in as server-side events, sent to `POST /ingest/conversion` with an ingest key. Each event says where it came from:

| Source | Typical setup |
|---|---|
| `sgtm` | Server-side Google Tag Manager, firing on your conversion events |
| `ga4` | Conversions you also send to GA4, forwarded from your server |
| `google_ads` | Conversions you also upload to Google Ads |
| `meta` | Events you also send to Meta's Conversions API |
| `tiktok` | Events you also send to TikTok's Events API |
| `shopify` | Orders from your Shopify store, sent from a server-side hook |

If you already send server-side events to an ad platform, you already have the data. Send a copy here as well. [Sending conversions from sGTM](/docs/sgtm-conversions/) walks through the most common setup.

## What an event needs

- `event_id`: a unique id for the conversion, such as the order number. Used to **deduplicate**: if the same id arrives twice, it's counted once. Use the same id you send to ad platforms.
- `event_name`: such as `purchase` or `generate_lead`.
- `ts`: when it happened.
- `landing_path`: the page the visit started on.
- `source`: one of the values above.
- Optional: `assistant`, `referrer`, `utm_source`, `value`, `currency`.

Send `assistant`, `referrer` or `utm_source` whenever you have them. They're how a conversion is credited to the right assistant.

## How conversions are joined

Conversions are lined up with AI referrals and citations **by landing path and day**. The [Pages table](/docs/pages-table/) shows conversions and revenue next to each page's citations.

This join is an approximation. A conversion is linked to the prompts whose answers cited its landing page that day, but we can't know what the visitor actually asked.

## Events without an AI signal

Only AI-attributed conversions are kept. An event needs an `assistant`, or a `referrer` or `utm_source` that points to an AI assistant. Events with none of these are counted as unattributed in the response and not stored.

## Duplicates

The same `event_id` is only counted once per workspace, so you can send a purchase from both sGTM and Shopify without double counting.

## Revenue

Revenue adds up the `value` of each conversion as sent, in the currency you send. Amounts aren't converted, so keep one currency per project so totals mean something.
