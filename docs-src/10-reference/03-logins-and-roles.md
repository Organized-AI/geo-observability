---
title: Logins and roles
section: Reference
order: 3
description: How sign-in works, what each role can do, and what demo mode shows.
---

## Signing in

The portal sits behind **Cloudflare Access**. When you open it, Access asks you to sign in with whatever your administrator has set up, such as a one-time code sent to your email or your company's single sign-on. Once Access lets you through, the portal knows who you are.

If Access turns you away, you're not on its allow list. Ask your administrator to add you.

## Roles

Within a workspace, each person has one role:

| Role | Can do |
|---|---|
| Owner | Everything an editor can, plus manage the workspace itself |
| Editor | Change prompts, topics, competitors, brand profile, engines, countries and schedule. Run passes, update actions, save views |
| Viewer | Read every report, open chats, use filters and export. Can't change anything |

If a viewer tries to change something, the portal says the workspace is read-only for them. Ask an owner if you need a different role.

Access decides whether you can reach the portal at all. Your role decides what you can do inside a workspace.

## Agency staff

Agency staff see every client workspace in the workspace switcher. See [Agencies: getting started](/docs/agency-getting-started/).

## Demo mode

An administrator can turn on demo mode (`DEMO_MODE`). Visitors who aren't signed in then see a **read-only demo project**, and nothing else. It's meant for showing the product to prospects. Demo visitors can't change anything, and they can't see any real workspace.

## Share links

[Share links](/docs/saved-views-sharing-exports/#share-links) let someone see a saved view without signing in. They're read-only and expire.

## API and MCP

The API and MCP server don't use Access. They use API keys instead. See [API: authentication and rate limits](/docs/api-authentication/).
