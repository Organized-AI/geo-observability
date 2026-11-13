---
title: "MCP server: introduction"
nav: "MCP server: introduction"
section: Integrations
order: 5
description: Ask questions about your AI visibility from Claude, Cursor and other MCP clients.
---

The MCP server lets an AI assistant read your GEO Observability data. Connect it once, then ask questions in plain language:

- "Which prompts did we lose on ChatGPT this week?"
- "What domains cite Brightbean but not us?"
- "Show me the latest answer from Perplexity for the cold brew prompt."
- "Which of our pages get cited most, and do they convert?"

The assistant picks the right tools, reads the data and answers, quoting real numbers from your projects.

## How it works

The server is at `https://<your-host>/mcp`. It speaks the Model Context Protocol over streamable HTTP. You authenticate with a **read** API key sent as a bearer token:

```text
Authorization: Bearer <read key>
```

The MCP server is **read-only**. It can't change prompts, settings or anything else.

## What it can see

The same data as the API: projects, brand metrics, answers, sources, insights, actions and the Pages table. See [MCP server: tools](/docs/mcp-tools/) for the full list.

## Before you connect

- Create a key with scope `read` under **Usage & API**. Use a separate key for each person or assistant, so you can revoke one without affecting the others.
- The assistant sends what it reads to its model provider, as with any tool it uses. Only connect assistants you'd trust with the same data.
- Answers from the assistant are its own summary of the data. When a number matters, check it in the portal.

Next: [set it up](/docs/mcp-setup/).
