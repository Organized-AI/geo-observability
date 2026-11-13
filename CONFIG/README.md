# Config

- `wrangler.jsonc` (repo root): bindings, vars, crons, staging environment.
- `edge/wrangler.jsonc`: the per-client edge tap Worker.
- KV `CONFIG` keys: `pricing` (token and search prices in micros per engine), `rl:*` (rate-limit counters, auto-expiring).
- Secrets: see DOCUMENTATION/deploy.md. Local: `.dev.vars` from `.dev.vars.example`.

## GitHub Actions workflows
`CONFIG/github-workflows/ci.yml` (PR gate) and `deploy.yml` (main → staging, release → production) are parked here because the app that pushed this repo isn't allowed to write workflow files. Turn them on from your machine:

```bash
git mv CONFIG/github-workflows .github/workflows && git commit -m "ci: enable workflows" && git push
```
