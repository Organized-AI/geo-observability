# Infrastructure

Two environments, each a complete copy: **production** (`geo-observability`, served at
https://app.organizedai.vip/geo-observability) and **staging** (`geo-observability-staging`, workers.dev only).

| Resource | Production | Staging | Declared in | Created by |
|---|---|---|---|---|
| Worker + static assets | geo-observability | geo-observability-staging | wrangler.jsonc | deploy |
| Routes | app.organizedai.vip/geo-observability(/*) | none | wrangler.jsonc | deploy |
| D1 `DB` | geo-observability | geo-observability-staging | wrangler.jsonc + migrations/ | infra:apply, migrations on deploy |
| KV `CONFIG` | geo-observability-config | geo-observability-config-staging | wrangler.jsonc + environments.json | infra:apply |
| R2 `ANSWERS` | geo-observability-answers | geo-observability-answers-staging | wrangler.jsonc | infra:apply |
| Queue `RUNS` + dead letters | geo-observability-runs(-dlq) | geo-observability-runs-staging(-dlq) | wrangler.jsonc | infra:apply |
| Workflows | geo-run-prompt, geo-insights | geo-run-prompt-staging, geo-insights-staging | wrangler.jsonc | deploy |
| Durable Object `PROGRESS` | RunProgress | RunProgress | wrangler.jsonc | deploy |
| Analytics Engine | geo_visibility_events, geo_traffic_events | ..._staging | wrangler.jsonc | first write |
| AI Gateway | geo-observability | geo-observability-staging | vars.AI_GATEWAY_ID | infra:apply |
| Email Service sender | organizedai.vip | organizedai.vip | secret EMAIL_FROM | dashboard (domain onboarding) |
| Cron triggers | 06:00, :20 hourly, 09:00 UTC | same | wrangler.jsonc | deploy |
| Secrets | see environments.json | see environments.json | Cloudflare only | `wrangler secret put [--env staging]` |

```bash
npm run infra:check                          # offline; CI runs it on every pull request
npm run infra:plan  -- --env staging         # what exists, what is missing, which required secrets are unset
npm run infra:apply -- --env staging         # create what is missing; new ids are written into wrangler.jsonc
```

`plan` and `apply` use `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (token permissions:
DOCUMENTATION/gitops.md, step 2). `apply` only creates; it never deletes, never overwrites an id that points somewhere
else (it reports it), never touches secrets, and needs `--confirm-production` for production. Commit `wrangler.jsonc`
after it writes ids.

Adding a binding: add it to production and staging in `wrangler.jsonc` with different names (and a KV title in
`environments.json`), run `npm run infra:check`, then `infra:apply` for each environment.
