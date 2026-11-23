---
title: "LLM tracing: Claude Code and Codex"
nav: "LLM tracing: Claude Code and Codex"
section: Integrations
order: 10
description: Connect each person's Claude Code and Codex so their sessions show up as traces, by person and tool.
---

You can see how your whole team uses Claude Code and Codex: who is using which tool, how many sessions and turns, how many tokens, which tools the assistant ran and where it failed.

Each person connects their own machine once. It works whether they sign in with a subscription or an API key, because the script runs on their machine and doesn't sit between them and the model provider.

You'll need:

- your endpoint: `https://<your-host>/ingest/otlp`
- an **ingest** API key from **Usage & API**
- Node.js 18 or later on each machine

The **Send traces** button on the Traces page shows these commands with your endpoint filled in.

## Connect a machine

```bash
curl -fsSL https://<your-host>/trace/geo-trace.mjs -o geo-trace.mjs
node geo-trace.mjs install \
  --endpoint https://<your-host>/ingest/otlp \
  --key <ingest key> \
  --user you@company.com
```

The installer:

1. copies itself to `~/.geo-observability/` and saves the endpoint, key and name there (readable only by that person)
2. adds its hook to Claude Code (`~/.claude/settings.json`) and Codex (`~/.codex/hooks.json`), leaving every other setting and hook as it was, and keeping a backup of each file it changes
3. sends one test turn, so you can see it under **Traces** straight away

If `--user` is left out, it uses the person's git email, then their login name.

**Codex asks for approval.** Codex doesn't run a new hook until the person approves it: open Codex, run `/hooks`, and approve geo-trace. Until then Codex sends nothing. Claude Code needs no approval; new sessions pick the hook up.

## What is sent

One trace per turn (one prompt and everything the assistant did to answer it):

| Step | What it carries |
| --- | --- |
| The turn | Who, which tool, the session, the project folder's name, how long it took |
| Each model call | Model, tokens in and out, cached tokens |
| Each tool call | Tool name, how long it took, whether it failed |
| Each subagent | Its type, with its own model and tool calls underneath |

Names that say what was used are always sent, because they are what makes usage readable:

| Name | Example |
| --- | --- |
| Tool | `Read`, `Bash`, `Edit` |
| Skill | `code-review` |
| Plugin | `stripe` |
| MCP server | `linear` |
| Subagent type | `Explore` |
| Program a shell command starts with | `git`, `npm` (never its arguments) |
| Slash command | `review` (never what follows it) |

And, depending on the switches below:

| Content | Default | Switch |
| --- | --- | --- |
| Prompts and the assistant's answers | Sent | `--no-content` turns them off |
| Tool inputs and outputs (file contents, commands and their output) | Not sent | `--tool-content` turns them on |

Content that is switched off is never written to disk on the person's machine, and never sent. Long values are cut.

Tell people what you collect before you roll this out. Prompts can contain anything a person types, including secrets pasted by mistake.

## Bring in sessions from before you connected

Both tools keep past sessions on the machine. After installing, this sends the last 30 days of them:

```bash
node ~/.geo-observability/geo-trace.mjs import --days 30
node ~/.geo-observability/geo-trace.mjs import --dry-run    # count what would be sent, send nothing
```

Traces are kept for 92 days, so importing further back than that only brings in turns that are deleted again within the hour.

It uses the same content switches as the installer. Running it again is safe: a turn that was already sent isn't added twice, and a turn that was still running picks up its later steps. A turn sent live by the hooks and imported later is stored once.

## Check, pause, remove

```bash
node ~/.geo-observability/geo-trace.mjs status      # what is connected, and anything waiting to send
node ~/.geo-observability/geo-trace.mjs test        # send a test turn
node ~/.geo-observability/geo-trace.mjs uninstall   # remove the hooks and the saved settings
```

Run `install` again to change the key, the name or the content switches. Setting `GEO_TRACE_DISABLED=1` in the environment pauses sending for that shell.

## It can't slow or break a session

- The hook runs in the background, prints nothing and always reports success, so the tool never waits on it or reads anything from it.
- If your workspace can't be reached, the turn waits on the person's machine and is sent with the next one. Up to 50 turns wait; older ones are dropped.
- If the key is refused, the turn is dropped and the reason is written to `~/.geo-observability/geo-trace.log`.

## Roll it out to everyone

An administrator can set the hooks for every machine, so nobody has to run the installer and nobody can switch it off:

- **Claude Code**: put the hooks in managed settings (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `/etc/claude-code/managed-settings.json` on Linux).
- **Codex**: put the hooks in `/etc/codex/hooks.json` or in `requirements.toml`. Managed hooks don't need each person's approval.

`node geo-trace.mjs print-managed claude` and `print-managed codex` print the hooks block to paste in. The script and its `config.json` still have to be placed on each machine, for example with your device management tool.

## Reading the results

Open **Traces** and choose the **People** tab: one row per person with their tools, sessions, turns and tokens for the date range. Select a person to open their page.

People here means people using coding tools. Users of your own LLM apps are your customers, so they're left out unless you pick that app in the app filter.

### Across the team

Below the list, **Across the team** shows how many people use skills, subagents, plugins, MCP servers and slash commands, every one of those in use with who uses it, and what stands out: something only one person uses, a tool that fails for several people, something everyone relies on. It's the quickest way to find a habit worth sharing.

### A person's page

- **Headline numbers**: turns, tokens, how much input was reused from cache, tool calls, tool failures, and turns that were cut short. Arrows show the change from the period of the same length just before.
- **Tools**: every tool they used, how often, how often it failed and how long it took on average.
- **Skills, plugins, MCP servers, subagents, slash commands, shell programs**: what they reach for, and what they never use.
- **Models and projects**: where the tokens went.
- **Recent sessions**: open one to read its turns.

Tokens include cached input, which is most of a coding session, so the numbers are large. Cost isn't shown: a subscription seat has no price per request.

### Daily reports

Each person gets a report for every day they were active. It's written after the day ends (UTC), and rewritten each hour that day if late turns arrive. Today's report is shown as a preview.

A report has the day's numbers, how they compare with that person's own active days in the week before, and a short list of observations:

| Label | Meaning | Examples |
| --- | --- | --- |
| Watch | Something cost time | A tool failing a quarter of the time; turns cut short; a very large context |
| Try | Something worth trying | No skills or subagents used; a very long single turn; a program approved by hand many times |
| Good | Something worth keeping | No tool failures; skills and subagents in use; high cache reuse |

Every observation comes from a number on the page, by fixed rules. Nothing is judged by a model, and nothing reads what was typed. The reports describe how the tools were used. They don't measure the quality of anyone's work, and they're a poor basis for comparing people: someone doing harder work will show more failures and longer turns.

Reports are kept after the traces they were built from are deleted, since they hold counts and names only.

## Limits

- Model calls and tokens for Claude Code are read from its session file, because Claude Code doesn't hand them to hooks. That file's format belongs to Claude Code and can change. If it does, turns still arrive, without model calls and tokens, until the script is updated.
- A person is whoever the installer was told they are. With one shared key, the workspace can't prove who sent a trace.
- The chat apps (Claude and ChatGPT in the browser or desktop app) have no hooks and aren't covered.
- Import reads each tool's own session files. Their formats belong to the tools and can change.
- Import leaves out Claude Code subagent threads. Codex subagent threads are included, in the same conversation as their parent.
- Windows hasn't been tested.
