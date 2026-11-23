# Phase T5: docs and version

**Read first:** `docs-src/12-integrations/06-mcp-setup.md` (front matter and tone), `CHANGELOG.md`, `scripts/version.mjs`.

## Tasks

1. `docs-src/12-integrations/`: a page on sending traces (endpoint, key, exporter settings for Python and Node, which attributes are read, limits) and a page on reading them in the portal. Written fresh.
2. `ARCHITECTURE/overview.md`, `CLAUDE.md` project structure and `PLANNING/phases.md`: add the tracing module.
3. `CHANGELOG.md`: an entry under `[Unreleased]`, then `npm run release:prepare -- minor`.
4. `npm run check`.

## Success criteria

- [ ] Docs build and the new pages appear in the docs navigation and search.
- [ ] `npm run version:check` passes with the new version.
- [ ] `npm run check` passes.
