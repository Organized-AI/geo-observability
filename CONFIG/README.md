# Config

- `wrangler.jsonc` (repo root): bindings, vars, crons, staging environment.
- `edge/wrangler.jsonc`: the per-client edge tap Worker.
- KV `CONFIG` keys: `pricing` (token and search prices in micros per engine), `rl:*` (rate-limit counters, auto-expiring).
- Secrets: see DOCUMENTATION/deploy.md. Local: `.dev.vars` from `.dev.vars.example`.
