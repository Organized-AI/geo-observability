---
title: "Agencies: getting started"
nav: Getting started
section: Agencies
order: 1
description: How agencies run GEO Observability across many clients.
---

GEO Observability works well for agencies that track AI visibility for several clients. This page explains how clients are organised and what agency staff can see.

## Workspaces and projects

- A **workspace** holds one client's data, people, usage and API keys.
- A **project** inside it is one brand on one website. A client with two brands, or separate sites per country, can have several projects, within the workspace's [plan limits](/docs/agency-limits/).

Keeping each client in its own workspace means their people, their keys and their usage stay separate.

## What agency staff see

People marked as agency staff see **every client workspace** in the workspace switcher. Client contacts see only their own workspace.

## Setting up a new client

1. Open the client's workspace from the workspace switcher.
2. Create a project with the client's brand name and main domain.
3. Follow the [Quickstart](/docs/quickstart/): brand profile, topics, prompts, competitors, engines and countries.
4. Check that no engine is running on the **stub** channel. Stub answers are sample text and count in the metrics. See [Engines reference](/docs/engines-reference/#stub-engines).
5. Finish onboarding to start the first pass.

## Giving the client access

You have two options:

- **Sign-in access.** Add the client's people to Cloudflare Access and give them the **viewer** role, so they can explore but not change anything. See [Logins and roles](/docs/logins-and-roles/).
- **Share links.** Send a read-only link to a saved view. No sign-in needed, and it expires. See [Saved views, sharing and exports](/docs/saved-views-sharing-exports/).

## Next

- [Managing client projects](/docs/agency-client-projects/)
- [Limits](/docs/agency-limits/)
