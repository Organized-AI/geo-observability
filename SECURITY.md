# Security

Report vulnerabilities privately to the repository owner rather than in an issue.

## Design rules this codebase keeps
- **Tenant isolation:** every client row carries `tenant_id`; all request-time queries go through `src/lib/db.ts` (`TenantDB`), which refuses SQL without `tenant_id` and `?1`. Tests prove one tenant can't read another's rows.
- **Secrets:** provider keys, the AI Gateway token, Access audience and the share-link secret are Worker secrets, never committed. API keys are stored as SHA-256 hashes and shown once.
- **Untrusted text:** AI answers, prompts and fetched pages are data. The judge prompt tells the model to ignore instructions inside answers; the portal escapes every string before it reaches the DOM; CSV exports neutralise formula injection.
- **Auth:** the portal sits behind Cloudflare Access (JWT verified against the team's JWKS and audience). `DEMO_MODE` serves only the demo tenant, read-only.
- **Ingest keys** can write events but read nothing, so they may appear in page source (tap.js).
