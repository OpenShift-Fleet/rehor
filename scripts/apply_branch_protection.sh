#!/usr/bin/env bash
# apply branch protection policy from versioned config.
# requires admin access to the repository.
# usage: scripts/apply_branch_protection.sh [repo] [branch]
set -euo pipefail

REPO="${1:-OpenShift-Fleet/rehor}"
BRANCH="${2:-master}"
POLICY_FILE=".github/branch-protection/master-protection.json"

if [ ! -f "$POLICY_FILE" ]; then
  echo "error: policy file not found at $POLICY_FILE"
  exit 1
fi

if ! command -v gh &>/dev/null; then
  echo "error: gh CLI is required but not installed"
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "error: jq is required but not installed"
  exit 1
fi

echo "=== Applying branch protection to ${REPO}:${BRANCH} ==="
echo "Policy file: $POLICY_FILE"
echo ""

# strip the $comment field before sending to the API
payload=$(jq 'del(."$comment")' "$POLICY_FILE")

echo "Required status checks:"
echo "$payload" | jq -r '.required_status_checks.contexts[]' | sed 's/^/  - /'
echo ""
echo "PR reviews required: $(echo "$payload" | jq '.required_pull_request_reviews.required_approving_review_count')"
echo "Dismiss stale reviews: $(echo "$payload" | jq '.required_pull_request_reviews.dismiss_stale_reviews')"
echo "Strict (up-to-date): $(echo "$payload" | jq '.required_status_checks.strict')"
echo ""

read -r -p "Apply this policy to ${REPO}:${BRANCH}? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

echo ""
echo "Applying..."

gh api \
  --method PUT \
  "/repos/${REPO}/branches/${BRANCH}/protection" \
  --input <(echo "$payload") \
  --silent

echo "Branch protection applied successfully."
echo ""
echo "Run 'scripts/check_branch_protection.sh' to verify."
