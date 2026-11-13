---
description: Deploy to staging or production
---
# Deploy
Prerequisites: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID set; resource ids filled in wrangler.jsonc (see DOCUMENTATION/deploy.md).
1. /verify.
2. Staging: `npm run deploy:staging`. Production: publish a GitHub release (CI deploys) or `npm run deploy:production` after explicit approval.
3. `curl -fsS <url>/healthz`.
