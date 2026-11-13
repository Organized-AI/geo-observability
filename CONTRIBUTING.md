# Contributing

1. Branch from `main`, keep a pull request to one concern, and fill in the template (Before, After, How, Checks).
2. `npm run check` must pass locally: types, lint, Workers-runtime tests, script tests, version and infra checks, docs
   build, and production, staging and edge bundles. CI runs the same and more (DOCUMENTATION/gitops.md).
3. Add a line under `## [Unreleased]` in `CHANGELOG.md` for anything a user or operator would notice.
4. Pull requests are squash-merged once the PR Gate and security checks are green. Titles are short and imperative.
5. Commits are authored by Jordan Hill, with no AI co-author trailers.

`main` is protected by a repository ruleset (`CONFIG/github/ruleset-main.json`): no force pushes or deletion, and
changes land through squash-merged pull requests whose required checks pass. Every merge deploys staging.

## Releases

Versions are `X.Y.Z` (semantic versioning) and tags are `vX.Y.Z`:

1. `npm run release:prepare -- patch|minor|major` moves `[Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD` and bumps
   `package.json` and `package-lock.json`. Open a pull request with it and merge it.
2. Tag `main`: `git switch main && git pull && git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`. A tag ruleset
   stops `v*` tags from being moved or deleted.
3. The release workflow checks the tag, runs every check, waits for your approval on the `production` environment,
   migrates and deploys production, checks `/healthz`, and publishes the GitHub Release from the changelog section.

Major: a breaking change to the public API (`/api/v1`), MCP tools, ingest formats or tracking snippets. Minor: new
features. Patch: fixes.

## Migrations

New numbered file in `migrations/`, never an edit to an applied one (the PR Gate checks). Migrations run before the new
code and rollbacks don't undo them, so keep each one compatible with the version already running.
