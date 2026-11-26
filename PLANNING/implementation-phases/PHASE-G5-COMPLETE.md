# Phase G5 complete: rollout for teams

- `POST /api/tracing/keys/bulk` (owners): one personal key per listed email, returned once as a CSV download (`person,key,note`); people already at five keys are listed without a key. Audited.
- Portal: **Keys for your team** on the Send traces panel (owners only).
- `geo-trace.mjs configure --endpoint --key-file`: writes only the person's config for machines whose hooks come from managed settings. `--key-file` also works for `install`, so keys stay out of command lines.
- `geo-trace.mjs set-key <key> | --key-file`: replaces the key, re-reads the workspace level and sends a test turn.
- User guide: a step-by-step managed rollout, key replacement, leavers and removal.
- Tests: 2 server (bulk keys, key limit), 1 hook (configure, set-key). `npm run check` passes.
