---
title: Writing good prompts
section: Set up your project
order: 1
description: How to write, generate and import the prompts we run every day.
---

Your prompts decide what every number in the portal means. A good set reads like the questions your buyers actually type into an assistant.

## What makes a good prompt

- **Write it the way a buyer would.** "What's the best coffee subscription for someone who likes light roasts?" beats "coffee subscription light roast".
- **One question per prompt.** Two questions in one prompt get two half-answers.
- **Leave your brand out of most of them.** Unbranded prompts show whether you're found by people who don't know you yet. Keep branded ones ("Is Fernhill Coffee worth it?") to a minority. The generator defaults to 20%.
- **Cover the whole journey.** Mix learning questions, comparison questions and ready-to-buy questions (see intent below).
- **Keep it under 200 characters.** That's the limit, and shorter prompts give steadier answers.

Aim for **at least 10 active prompts** to start, then grow the list as you learn which questions matter.

## Intent

Each prompt carries an intent:

| Intent | What the asker wants | Example |
|---|---|---|
| Informational | To understand something | "How fresh should coffee beans be?" |
| Commercial | To compare options | "Fernhill vs Brightbean for espresso beans" |
| Transactional | To buy or act now | "Where can I order decaf beans delivered weekly?" |

When generating, the default mix is 25% informational, 50% commercial, 25% transactional. Change it if your market leans one way.

## Generating prompts

The generator uses your [brand profile](/docs/brand-profile/) and [topics](/docs/topics-tags-personas/). You choose how many, the branded share, the intent mix, the country and language, and optionally which topics to cover. New prompts arrive as **suggested**, so nothing runs until you've read them.

## Importing a CSV

Upload a CSV with these columns, in this order:

```text
prompt,country,topic,tag1,tag2,...
```

- `prompt`: the question, up to 200 characters.
- `country`: a two-letter ISO code such as `US` or `GB`.
- `topic`: the topic name. It's matched to an existing topic.
- Any further columns are tags. Add as many as you like.

```csv
prompt,country,topic,tag,tag
best coffee subscription for light roast fans,US,Subscriptions,persona:home-brewer,funnel:compare
is fernhill coffee worth the price,US,Subscriptions,branded
how long do roasted beans stay fresh,GB,Brewing,funnel:learn
```

The import reports how many rows came in and lists any errors by line number, so you can fix those rows and upload them again.

## Status

| Status | Meaning |
|---|---|
| Suggested | Proposed by us. Not run. |
| Active | Run on every pass. |
| Archived | No longer run. Past answers stay in your reports for the dates they ran. |

Archive rather than delete when a prompt has history you might want to compare against.

## Editing a prompt

Changing a prompt's wording changes the question, so answers before and after the edit aren't strictly comparable. For a big change, archive the old prompt and add a new one.
