# GEO Observability

See where AI assistants recommend a brand, and what it's worth.

- **Track** prompts daily across ChatGPT, Claude, Gemini and Perplexity through Cloudflare AI Gateway (Alexa is listed but not trackable: there is no public way to read Alexa+ answers).
- **Score** visibility, share of voice, position, sentiment, win rate and citations; see which sources feed answers that name competitors but not you.
- **Observe** what happens next: AI crawler hits and AI-referred visits at the edge, and server-side conversions, joined to the pages answers cite.
- **Act** on daily insights, ranked actions and content briefs.
- **Share** through a client portal behind Cloudflare Access, read-only share links, a REST API and an MCP server.

Stack: Cloudflare Workers, Worker Assets, D1, R2, KV, Queues, Workflows, Durable Objects, Analytics Engine, Workers AI, AI Gateway. Portal in vanilla JS with GSAP.

## Quick start (local, no accounts)

```bash
npm ci
npm run db:migrate:local && npm run seed:demo:local
npm run dev:offline     # http://localhost:8787  ·  /app/ (demo)  ·  /docs/
npm run check           # types, lint, tests, docs, bundle
```

Engines without a provider key run on a clearly labelled stub, so everything works end to end before any keys exist.

## Layout

| Path | What |
|---|---|
| `src/` | Worker: engines, judge, metrics, workflows, observability, insights, routes, MCP, billing hooks |
| `public/` | Landing page, portal (`/app`), generated docs (`/docs`), `tap.js` |
| `docs-src/` | Docs sources (Markdown) → `npm run build:docs` |
| `edge/` | Edge tap Worker for client zones |
| `migrations/` | D1 schema |
| `ARCHITECTURE/`, `PLANNING/`, `SPECIFICATIONS/`, `DOCUMENTATION/`, `AGENT-HANDOFF/`, `CONFIG/` | Organized Codebase docs |

Deploying: [DOCUMENTATION/deploy.md](DOCUMENTATION/deploy.md). Architecture: [ARCHITECTURE/overview.md](ARCHITECTURE/overview.md). API: [ARCHITECTURE/API.md](ARCHITECTURE/API.md). Phases: [PLANNING/phases.md](PLANNING/phases.md).

Billing is not wired yet: usage is logged per client and runs are gated on a billing status, ready for a provider ([SPECIFICATIONS/billing.md](SPECIFICATIONS/billing.md)).
