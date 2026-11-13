---
description: Self-review before a PR
---
# Self-review
1. `git diff main...HEAD`.
2. Check: every tenant query uses TenantDB with `tenant_id = ?1`; no unused binds; no secrets; untrusted text escaped in the portal; new migrations are additive.
3. Run /verify. Recommend Ready or Needs work.
