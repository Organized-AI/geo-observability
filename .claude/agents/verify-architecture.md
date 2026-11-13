---
name: verify-architecture
description: Verify code follows this repo's tenancy and layering rules
---
# Architecture verification
Checks:
1. No `env.DB.prepare` on tenant tables outside src/lib/auth.ts, src/billing/hooks.ts, src/workflows/scheduler.ts, src/metrics/rollup.ts and src/observability/ingest.ts (cross-tenant jobs) — everything else uses TenantDB.
2. Routes don't import from each other except shared helpers.
3. Engines only call providers through src/engines/gateway.ts.
4. Billing code calls no payment provider.
Output: passed checks, warnings, violations with file:line.
