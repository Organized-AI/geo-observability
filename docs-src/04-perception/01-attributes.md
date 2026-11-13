---
title: Attributes
section: Brand perception
order: 1
description: The words and qualities assistants attach to your brand.
---

Attributes are the qualities assistants associate with you: "good value", "fast shipping", "great for beginners", "limited range".

## Where they come from

When an answer names your brand, the judge (an LLM on Workers AI, called through Cloudflare AI Gateway) pulls out the short phrases the answer uses to describe you. Similar phrases are grouped, and the Attributes view lists them with **how many answers** used each one.

## Reading the list

- **The top five are your reputation in AI answers**, whether or not you like them. Compare them with how you describe yourself in your [brand profile](/docs/brand-profile/).
- **Look for missing strengths.** If you lead on something buyers care about and it isn't on the list, assistants aren't finding the evidence. That's usually a content problem: the claim isn't stated plainly anywhere they read.
- **Filter by engine.** Different engines rely on different sources, so they often describe you differently.

## Limits

Attributes are extracted by a model, so the wording is the model's summary, not a quote. Read the [chats](/docs/reading-chats/) that name you when you want the exact wording. If the judge failed on an answer and the rules fallback was used, no attributes are extracted from that answer.

## Related

- [Objections](/docs/objections/), the negative side of the same picture.
