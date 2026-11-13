---
name: verify-build
description: Validate the Worker builds and tests pass from a clean install
---
# Build validation
1. `npm ci`
2. `npm run check`
3. `node scripts/seed-demo.mjs > /dev/null`
Report status and warnings.
