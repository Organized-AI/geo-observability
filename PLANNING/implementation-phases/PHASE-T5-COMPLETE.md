# Phase T5 complete: docs and version

- User guide: `docs-src/12-integrations/08-tracing-send.md` and `09-tracing-read.md`, built into `public/docs`.
- `ARCHITECTURE/overview.md`, `CLAUDE.md` and `PLANNING/phases.md` name the tracing module.
- `CHANGELOG.md` and `package.json` at 1.5.0 (`npm run release:prepare -- minor`).

## Success criteria

- [x] Docs build; `tracing-send` and `tracing-read` pages exist.
- [x] `npm run version:check` passes at 1.5.0.
- [x] `npm run check` passes (97 tests).

## Not done here

- No tag and no push. Tagging `v1.5.0` on `main` deploys production; that is the owner's step after the branch is merged.
- Migration `0006_llm_tracing.sql` has only been applied to local databases.
