# Phases (in order, no dates)

| Phase | Scope | State |
|---|---|---|
| 0 Foundation | Organized Codebase layout, wrangler config, CI gate, deploy workflow (main → staging, release → production) | Built |
| 1 Teardown checklist | Feature checklist from the plan page's public-source teardown | Built (ARCHITECTURE/overview.md, docs outline) |
| 2 Tenancy and data model | D1 schema, TenantDB guard, Access identity → tenant/role, isolation tests | Built |
| 3 Prompt runner | Cron → Queue → Workflow per prompt × engine × country × day; AI Gateway metadata; R2 raw answers | Built |
| 4 Parse and score | Deterministic mentions/rank, Workers AI judge, rollups | Built |
| 5 Onboarding | Profile draft → topics → prompt generation (branded share, intent mix) → CSV import → competitors → engines/countries → first pass now with live progress | Built |
| 6 Billing and metering | Usage logging + gating hooks only | **Waiting on Stripe sandbox** (SPECIFICATIONS/billing.md) |
| 7 Client portal | Overview, chats, sources + gaps, prompts, competitors, saved views, share links, CSV, print-to-PDF, GSAP | Built |
| 8 Observability layer | Edge tap Worker, tap.js, conversion ingest with dedupe, Pages table, crawler and referral reports | Built |
| 9 Insights and recommendations | Daily insights with evidence, ranked actions, content briefs | Built (weekly email/Slack brief not built) |
| 10 API, MCP, spend controls | v1 report API, MCP server, per-tenant spend cap, OTel export | Built |
| 11 Extras | Brand perception and fact-checking built; shopping visibility, drafted content, Browser Run samples not built | Partly built |
| 12 LLM tracing | Clients send traces from their own LLM apps over OTLP; portal Traces view with span tree, sessions and filters. Plan: `IMPLEMENTATION-MASTER-PLAN.md` | Stage 1 built (T0 to T5). Stage 2, Claude Code and Codex as sources with a People view, built (H1 to H4). Cost, evaluations, datasets, prompts and monitors not built |

## Next, in order
1. Cloudflare resources + secrets, deploy staging, seed demo.
2. Provider keys → replace stub engines; verify one real pass end to end.
3. Cloudflare Access application for the portal; first client workspace.
4. Billing (Phase 6) once the Stripe sandbox exists.
5. Weekly email/Slack brief; GA4 / Google Ads / Meta pulls via organized-google-wiring and organized-meta-wiring; shopping visibility.
