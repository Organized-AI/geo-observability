# Agent handoff

## Project: GEO Observability (AEO/GEO tracker + Cloudflare observability)

### Quick context
Multi-tenant Cloudflare Worker: prompt tracking across AI engines, scoring, client portal, docs, observability layer, MCP + REST API. Billing is deliberately hooks-only.

### Read first
1. `CLAUDE.md` — conventions and DO NOTs
2. `ARCHITECTURE/overview.md` and `ARCHITECTURE/API.md`
3. `PLANNING/phases.md` — what's built and what's next
4. `DOCUMENTATION/deploy.md` — resources, secrets, commands
5. `SPECIFICATIONS/billing.md` — the unbuilt phase

### Current state
- Backend, portal, docs, edge tap, tests (unit + integration in Workers runtime): ✅
- Deployed: ⏳ needs Cloudflare token + resource ids
- Real engines: ⏳ need provider keys (stub engines run until then)
- Billing: ⏳ waits on Stripe sandbox
- Visual QA of the portal in a real browser: ⏳ not done yet
