## Before

## After

## How

## Checks
- [ ] `npm run check` passes locally
- [ ] Added a line under `[Unreleased]` in `CHANGELOG.md` if a user or operator would notice
- [ ] New bindings exist in production and staging with different names (`npm run infra:check`)
- [ ] Migrations are additive (new file in `migrations/`, never an edit to an applied one)
- [ ] Every new query goes through `TenantDB` with `tenant_id = ?1`
- [ ] Docs updated in `docs-src/` and rebuilt (`npm run build:docs`)
