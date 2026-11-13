---
title: "MCP server: setup"
nav: "MCP server: setup"
section: Integrations
order: 6
description: Connect Claude Code, Claude Desktop or Cursor to the MCP server.
---

You'll need:

- your server URL: `https://<your-host>/mcp`
- a **read** API key from **Usage & API**

Replace `<your-host>` and `<read key>` in the examples below.

## Claude Code

Add the server from your terminal:

```bash
claude mcp add --transport http geo-observability https://<your-host>/mcp \
  --header "Authorization: Bearer <read key>"
```

Run `claude mcp list` to check it's connected, then ask a question in a Claude Code session.

## Claude Desktop

Claude Desktop's config file starts local servers, so use the `mcp-remote` bridge to reach an HTTP server with a header. Open **Settings → Developer → Edit Config** and add:

```json
{
  "mcpServers": {
    "geo-observability": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://<your-host>/mcp",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer <read key>"
      }
    }
  }
}
```

The header is passed through an environment variable to avoid problems with spaces in arguments on some systems. You need Node.js installed for `npx`. Restart Claude Desktop after saving.

## Cursor

Add the server to `.cursor/mcp.json` in your project, or to `~/.cursor/mcp.json` to use it everywhere:

```json
{
  "mcpServers": {
    "geo-observability": {
      "url": "https://<your-host>/mcp",
      "headers": {
        "Authorization": "Bearer <read key>"
      }
    }
  }
}
```

Open Cursor's MCP settings to check the server shows as connected.

## Other clients

Any MCP client that supports streamable HTTP and custom headers will work. Point it at `https://<your-host>/mcp` and send `Authorization: Bearer <read key>`.

## Keep the key out of shared files

Project-level config files are easy to commit by accident. If you use `.cursor/mcp.json` in a shared repository, add it to `.gitignore` or use your user-level config instead.

## Troubleshooting

| Symptom | Check |
|---|---|
| Unauthorised | The key is a `read` key, copied in full, with `Bearer ` before it |
| No tools listed | The URL ends in `/mcp` and uses `https` |
| Requests refused after heavy use | The key is over 120 requests per minute. Wait and try again |
