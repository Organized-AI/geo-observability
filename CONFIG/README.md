# Config

- `wrangler.jsonc` (repo root): bindings, vars, crons, routes, and the staging environment (its own resources, no routes).
- `infra/environments.json`: KV titles, public URLs and the secrets each environment needs (see infra/README.md).
- `edge/wrangler.jsonc`: the per-client edge tap Worker.
- KV `CONFIG` keys: `pricing` (token and search prices in micros per engine), `rl:*` (rate-limit counters, auto-expiring).
- Secrets: see DOCUMENTATION/deploy.md. Local: `.dev.vars` from `.dev.vars.example`.
- `CONFIG/github/`: GitHub environments and rulesets as code (`bash CONFIG/github/setup.sh`).
- `stripe-plan.json`: Stripe sandbox products and prices for `npm run stripe:setup`.

CI/CD is described in DOCUMENTATION/gitops.md. If the workflows are in `CONFIG/github-workflows/` rather than
`.github/workflows/` (an agent can't push workflow files), turn them on from your Mac:

```bash
git pull && git mv CONFIG/github-workflows .github/workflows && git commit -m "ci: enable workflows" && git push
```
