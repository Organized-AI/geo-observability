---
title: Card and invoices
section: Plans and usage
order: 2
description: How signup saves your card, what each invoice contains, and where to change your card or cancel.
---

When you create a workspace yourself, you add a card before anything runs. Stripe handles the card: we never see or store the number.

## Signing up

1. Open **/signup/**, name your workspace and, if you like, add your website.
2. Stripe Checkout opens. Enter your card and confirm. This starts a 14-day free trial and saves the card; the first invoice comes when the trial ends.
3. You land back in the portal. It waits a moment for Stripe to confirm, then opens Setup so you can add your brand, prompts and competitors. Your first answers run as soon as setup is done.

If you close Checkout without finishing, nothing is charged and no card is saved. Going back to **/signup/** picks up the same workspace instead of making a second one.

## What you pay

Each invoice has two parts:

| Line | How it's worked out |
|---|---|
| Plan fee | $150 a month, charged at the start of each period after the trial. |
| Token usage | What the AI model calls behind your answers cost, passed through at cost. |

Usage lines are billed at the end of each period for what actually ran. Usage is counted in our database as each answer finishes, totalled per hour, and sent to Stripe about 20 minutes after the hour ends. Each hourly total carries its own reference, so a retry can never count the same hour twice. The Usage page shows this month's totals and whether each hour has been sent.

Sales tax isn't added automatically today. If that changes, Checkout will ask for your billing address and invoices will show the tax as its own line.

## Changing your card, seeing invoices, cancelling

Owners see **Manage billing** on the **Usage & API** page. It opens Stripe's billing page for your workspace, where you can:

- change the card or add a new one,
- download past invoices and receipts,
- update the billing email and address,
- cancel. Cancelling takes effect at the end of the current period; until then everything keeps working.

Only workspace owners can open billing. Editors and viewers see the status but not the button.

## After you cancel

When the period ends, daily runs stop and the workspace becomes read-only. Your reports, answers and settings are kept, so you can read and export them. Add a card again from the Usage page to restart.
