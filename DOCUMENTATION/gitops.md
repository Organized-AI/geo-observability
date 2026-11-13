# GitOps

Git is the only way a change reaches Cloudflare. The shape follows Organized-AI/podcast-agent, with Cloudflare Workers
in place of images and Argo CD: every pull request runs the PR Gate and security scans, `main` deploys **staging**, and a
`vX.Y.Z` tag on `main` deploys **production** and publishes a GitHub Release from `CHANGELOG.md`.

```
 pull request ─► ci (PR Gate) + security ─► squash-merge to main
 push to main ─► deploy-staging: checks → staging D1 migrations → wrangler deploy --env staging → /healthz = this commit
 tag vX.Y.Z   ─► release: tag on main? version = package.json = CHANGELOG? npm run check, staging ran this commit?
                  └─► production environment (waits for your approval) → production D1 migrations
                      → wrangler deploy --tag vX.Y.Z → /healthz = vX.Y.Z → GitHub Release from CHANGELOG.md
 something wrong ─► rollback workflow (or: npx wrangler rollback) → previous Worker version, D1 untouched
```

Every deploy, from CI or a laptop, runs the same script, `scripts/deploy.mjs`. It refuses placeholder resource ids,
checks the version, applies D1 migrations, deploys with the Worker version tagged (`v1.4.0` from a release tag,
`v1.4.0+abc1234` otherwise) and `APP_VERSION` / `GIT_COMMIT` set, then waits for `/healthz` to report them.
`npx wrangler deployments list` shows which release each production deploy was.

## The pieces

| Path | What it is |
|---|---|
| `.github/workflows/ci.yml` | PR Gate: types, lint, Workers-runtime tests, script tests, version check, infra check, append-only migrations, docs build and drift, production/staging/edge bundles, `npm audit`; the final **PR Gate** job is the one the ruleset requires |
| `.github/workflows/security.yml` | gitleaks (full history), zizmor (workflows), Trivy (dependencies, secrets, config); CodeQL and dependency review when the repository variable `ADVANCED_SECURITY` is `true` (they need GitHub Advanced Security on a private repository) |
| `.github/workflows/deploy-staging.yml` | Push to `main` → staging. Skips with a note until the Cloudflare secrets exist and staging has real resource ids |
| `.github/workflows/release.yml` | Tag `vX.Y.Z` → checks → production (environment `production`) → GitHub Release |
| `.github/workflows/rollback.yml` | Manual: roll staging or production back to the previous or a named Worker version |
| `wrangler.jsonc` | Every binding, per environment. Staging has its own Worker and its own copy of every resource, and no routes |
| `infra/environments.json` | What wrangler.jsonc can't say: KV titles, the public URL, which Worker secrets each environment needs |
| `scripts/infra.mjs` | `infra:check` (offline, in CI), `infra:plan` and `infra:apply` (Cloudflare API). See [infra/README.md](../infra/README.md) |
| `scripts/version.mjs` | `version:check`, `release:prepare`, release notes from the changelog |
| `CONFIG/github/setup.sh` | Creates the `staging` and `production` environments and the `main` and `v*` tag rulesets with `gh` |
| `migrations/` | D1 schema, append-only. Applied before the new code on every deploy |

Dependabot (npm and Actions, weekly, 7-day cooldown) and CODEOWNERS are in `.github/`.

## Set up (once)

1. **Turn the workflows on.** If the files sit in `CONFIG/github-workflows/` (an agent couldn't push workflow files), from
   your Mac: `git mv CONFIG/github-workflows .github/workflows && git commit -m "ci: enable workflows" && git push`.
2. **Cloudflare API token** (dashboard → My Profile → API Tokens → Create Token → Custom token), scoped to your account
   and the `organizedai.vip` zone:
   - Account: Workers Scripts **Edit**, Workers KV Storage **Edit**, Workers R2 Storage **Edit**, D1 **Edit**,
     Queues **Edit**, AI Gateway **Edit**, Email Sending **Edit**, Account Settings **Read**
   - Zone `organizedai.vip`: Workers Routes **Edit**
3. **GitHub secrets** (repository → Settings → Secrets and variables → Actions → Secrets): `CLOUDFLARE_API_TOKEN` (the
   token above) and `CLOUDFLARE_ACCOUNT_ID`. Repository secrets serve both environments; put them on the `staging` and
   `production` environments instead if you want separate tokens.
4. **GitHub variables** (same page → Variables): `STAGING_URL` = the staging workers.dev address (for the smoke test and
   the environment link), and later `REQUIRE_STAGING` = `true` so a release refuses a commit staging hasn't run.
   `ADVANCED_SECURITY` = `true` only if the repository has GitHub Advanced Security.
5. **Environments and rulesets:** `bash CONFIG/github/setup.sh`. `production` deploys only from `v*.*.*` tags (and
   rollbacks from `main`) and waits for your approval; `main` takes squash-merged pull requests whose PR Gate, gitleaks,
   zizmor and Trivy checks pass (repository admins can bypass); `v*` tags can't be moved or deleted. Reviewers and
   rulesets on a private repository need a paid GitHub plan; the script says if they were skipped.
6. **Staging resources:** with the token exported (`read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN`,
   then `export CLOUDFLARE_ACCOUNT_ID=…`): `npm run infra:plan -- --env staging`, then
   `npm run infra:apply -- --env staging`. Commit the ids it writes into `wrangler.jsonc`. Set staging's secrets with
   `npx wrangler secret put <NAME> --env staging` (at least `SHARE_LINK_SECRET` and `EMAIL_FROM`; a Stripe sandbox key
   if you want billing there).
7. `npm run infra:plan -- --env production` lists anything production is missing, including required secrets.

## Day to day

- Branch from `main`, open a pull request, add a line under `## [Unreleased]` in `CHANGELOG.md` for anything a user or
  operator would notice. Squash-merge when the PR Gate is green. Staging deploys itself.
- **Release:** `npm run release:prepare -- minor` (or `patch`, `major`, `X.Y.Z`) moves `[Unreleased]` into a dated
  section and bumps `package.json`. Merge that pull request, then tag main:
  ```bash
  git switch main && git pull && git tag -a v1.4.0 -m v1.4.0 && git push origin v1.4.0
  ```
  Approve the `production` deployment in the Actions run. The GitHub Release appears when production is healthy.
- **Roll back:** Actions → rollback → Run workflow (production or staging, optional version id, reason). Or from a
  laptop: `npx wrangler deployments list` then `npx wrangler rollback <version-id> --message "<why>"`.
- **Emergency deploy from a laptop** still works (`npm run deploy:production`); it is labelled as an untagged build
  (`v1.4.0+abc1234`) and refuses uncommitted changes. Follow it with a tagged release.

## Rules that keep this safe

- Staging never shares a production resource (Worker, route, D1, KV, R2, queue, Workflow, dataset, AI Gateway).
  `npm run infra:check` fails the PR Gate if it does. Staging sets `"routes": []` because wrangler copies top-level routes
  into every environment.
- Migrations are append-only (the PR Gate fails if an applied one changes) and must work with the running code, because
  they run first and a rollback doesn't undo them: add columns and tables in one release, remove old ones in a later one.
- Secrets live only in Cloudflare (`wrangler secret put`) and GitHub secrets. `infra:plan` reads secret names, never values.
- Every action is pinned to a commit SHA; deploy jobs use no dependency cache.
