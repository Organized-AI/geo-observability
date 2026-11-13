---
title: AI referrals
section: Your website and traffic
order: 3
description: Visitors who arrive on your site from an AI assistant.
---

An AI referral is a visit that starts with a click in an assistant's answer. The Referrals view counts them by assistant and by day.

## How we spot them

A visit counts as AI-referred when either:

- the **referrer** is an AI assistant's site, or
- the landing URL has a **utm_source** naming one. ChatGPT, for example, adds `utm_source=chatgpt.com` to many of its links.

The [edge tap](/docs/edge-tap-setup/) and [tap.js](/docs/tap-js-setup/) both report these. You only need one of them.

## The views

- **By assistant**: sessions, conversions and revenue for each assistant.
- **Trend**: sessions per day per assistant.

Conversions and revenue need [server-side conversion events](/docs/sgtm-conversions/).

## Reading the numbers

- **They're a floor.** Many assistant apps open links without a referrer, so some AI visits look like direct traffic and can't be counted.
- **Compare with citations.** In the [Pages table](/docs/pages-table/), a page that's cited often but gets few visits may be giving the answer away completely. A page with many visits per citation is one people want to read in full.
- **Small numbers swing.** AI referral volume is still small for most sites. Look at weeks rather than days.
