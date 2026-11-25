# Phase G2 complete: identity and access

- Migration `0011_personal_trace_keys.sql` adds `api_keys.person`. A personal key is an ingest key bound to one email.
- Ingest stamps the key's person on every span and trace, replacing any `user.id` the sender claims.
- `/api/tracing/keys` (GET, POST, DELETE): anyone signed in may make and revoke keys for themselves (viewers too); an owner may do so for anyone. Five active keys per person. Secrets are shown once. Personal keys are left out of the general Usage & API key list.
- Access: coding-tool traces, spans, sessions, exports, person pages and daily reports are limited to the person and owners. App traces sent with a workspace key stay visible to the workspace. People and Team usage numbers stay visible.
- Portal: Send traces has a Make my key button that fills the install command, plus a list of your keys with Revoke.
- Tests: `test/tracing-keys.test.ts` (7). `npm run check` passes.
