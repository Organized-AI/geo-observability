---
title: Logins and roles
section: Reference
order: 3
description: How sign-in works, what each role can do, and what demo mode shows.
---

## Signing in

There's no password. Open **/login/**, enter your email, and we send you a sign-in link. The link works once and expires after 15 minutes. Opening it shows a **Sign in** button; press it on the device you want to use. You then stay signed in on that browser for 30 days, or until you press **Sign out** in the top bar.

If no email arrives, check spam, and make sure you used the address your workspace knows. For safety the sign-in page gives the same answer whether or not an address has an account.

When you create a workspace yourself at **/signup/**, you come back from Stripe already signed in to that workspace. We also email you a sign-in link: use it once to confirm your email, which you'll need before you can be added to other workspaces automatically.

Some agencies also put their own staff behind Cloudflare Access. If yours does, Access signs you in instead and you won't need a link.

## Roles

Within a workspace, each person has one role:

| Role | Can do |
|---|---|
| Owner | Everything an editor can, plus manage the workspace itself |
| Editor | Change prompts, topics, competitors, brand profile, engines, countries and schedule. Run passes, update actions, save views |
| Viewer | Read every report, open chats, use filters and export. Can't change anything |

If a viewer tries to change something, the portal says the workspace is read-only for them. Ask an owner if you need a different role.

Signing in decides who you are. Your role decides what you can do inside a workspace. People with an email on a workspace's company domain join it as viewers the first time they sign in with a confirmed email.

## Agency staff

Agency staff see every client workspace in the workspace switcher. See [Agencies: getting started](/docs/agency-getting-started/).

## Demo mode

An administrator can turn on demo mode (`DEMO_MODE`). Visitors who aren't signed in then see a **read-only demo project**, and nothing else. It's meant for showing the product to prospects. Demo visitors can't change anything, and they can't see any real workspace.

## Share links

[Share links](/docs/saved-views-sharing-exports/#share-links) let someone see a saved view without signing in. They're read-only and expire.

## API and MCP

The API and MCP server don't use sign-in links. They use API keys instead. See [API: authentication and rate limits](/docs/api-authentication/).
