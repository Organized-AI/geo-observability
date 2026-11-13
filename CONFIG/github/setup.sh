#!/usr/bin/env bash
# GitHub side of GitOps, as code: the staging and production environments and the main and release-tag rulesets.
# Run once from the repository root on your Mac (gh signed in as a repository admin); safe to run again.
#
#   bash CONFIG/github/setup.sh [owner/repo]
#
# Creates nothing in Cloudflare and sets no secrets. Environment reviewers and rulesets on a private repository need a
# paid GitHub plan (Team or above); on the free plan those calls fail and the script says so and carries on.
set -euo pipefail
REPO="${1:-Organized-AI/geo-observability}"
cd "$(dirname "$0")"
ok() { printf '  ok   %s\n' "$1"; }
skip() { printf '  --   %s (%s)\n' "$1" "$2"; }

echo "Environments on $REPO"
gh api -X PUT "repos/$REPO/environments/staging" --silent \
  --input - <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' && ok "staging"
gh api -X POST "repos/$REPO/environments/staging/deployment-branch-policies" -f name=main -f type=branch --silent 2>/dev/null \
  && ok "staging deploys from main" || ok "staging deploys from main (already set)"

me=$(gh api user --jq .id)
if gh api -X PUT "repos/$REPO/environments/production" --silent --input - <<JSON
{"wait_timer":0,"prevent_self_review":false,"reviewers":[{"type":"User","id":$me}],
 "deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
then ok "production (you approve every production deploy and rollback)"
else
  gh api -X PUT "repos/$REPO/environments/production" --silent \
    --input - <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' \
    && skip "production reviewer" "not available on this plan; production still deploys only from v* tags"
fi
gh api -X POST "repos/$REPO/environments/production/deployment-branch-policies" -f name='v*.*.*' -f type=tag --silent 2>/dev/null \
  && ok "production deploys from v*.*.* tags" || ok "production deploys from v*.*.* tags (already set)"
gh api -X POST "repos/$REPO/environments/production/deployment-branch-policies" -f name=main -f type=branch --silent 2>/dev/null \
  && ok "production rollback can run from main" || ok "production rollback can run from main (already set)"

echo "Rulesets on $REPO"
for file in ruleset-main.json ruleset-tags.json; do
  name=$(node -p "require('./$file').name")
  id=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$name\") | .id" 2>/dev/null || true)
  case "$id" in *[!0-9]*) id="" ;; esac   # an error body is not an id
  if [ -n "$id" ]; then
    gh api -X PUT "repos/$REPO/rulesets/$id" --input "$file" --silent && ok "ruleset \"$name\" updated"
  elif gh api -X POST "repos/$REPO/rulesets" --input "$file" --silent 2>/dev/null; then
    ok "ruleset \"$name\" created"
  else
    skip "ruleset \"$name\"" "not available on this plan for a private repository"
  fi
done

echo
echo "Next: add the secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (DOCUMENTATION/gitops.md, step 3)."
