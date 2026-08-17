#!/usr/bin/env bash
# check current branch protection against versioned policy and report drift.
# usage: scripts/check_branch_protection.sh [repo] [branch]
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

echo "=== Checking branch protection for ${REPO}:${BRANCH} ==="
echo ""

# fetch live protection settings
live_json=$(gh api "/repos/${REPO}/branches/${BRANCH}/protection" 2>/dev/null || true)

if [ -z "$live_json" ] || echo "$live_json" | jq -e '.message' &>/dev/null; then
  error_msg=$(echo "$live_json" | jq -r '.message // "unknown error"')
  if echo "$error_msg" | grep -qi "not found"; then
    echo "STATUS: no branch protection is currently configured on ${BRANCH}."
    echo ""
    echo "To apply the versioned policy, run:"
    echo "  scripts/apply_branch_protection.sh"
    exit 1
  else
    echo "error: could not read branch protection: $error_msg"
    echo "this may require admin access or the branch may not exist."
    exit 1
  fi
fi

echo "Branch protection IS configured. Checking for drift..."
echo ""

# compare required status checks
policy_checks=$(jq -r 'del(."$comment") | .required_status_checks.contexts | sort | .[]' "$POLICY_FILE")
live_checks=$(echo "$live_json" | jq -r '.required_status_checks.contexts // [] | sort | .[]')

drift=0

compare_bool_setting() {
  local label="$1"
  local policy_expr="$2"
  local live_expr="$3"
  local policy_value
  local live_value

  policy_value=$(jq -r "$policy_expr" "$POLICY_FILE")
  live_value=$(echo "$live_json" | jq -r "$live_expr")

  if [ "$policy_value" = "$live_value" ]; then
    echo "  OK:      ${label} = ${live_value}"
  else
    echo "  DRIFT:   ${label}: policy=${policy_value}, live=${live_value}"
    drift=1
  fi
}

echo "--- Required Status Checks ---"
while IFS= read -r check; do
  if echo "$live_checks" | grep -qxF "$check"; then
    echo "  OK:      $check"
  else
    echo "  MISSING: $check (in policy but not enforced)"
    drift=1
  fi
done <<< "$policy_checks"

# check for extra checks in live that aren't in policy
while IFS= read -r check; do
  [ -z "$check" ] && continue
  if ! echo "$policy_checks" | grep -qxF "$check"; then
    echo "  EXTRA:   $check (enforced but not in policy)"
    drift=1
  fi
done <<< "$live_checks"

echo ""
echo "--- PR Review Settings ---"
compare_bool_setting \
  "required approvals" \
  '.required_pull_request_reviews.required_approving_review_count // 0' \
  '.required_pull_request_reviews.required_approving_review_count // 0'
compare_bool_setting \
  "dismiss stale reviews" \
  '.required_pull_request_reviews.dismiss_stale_reviews // false' \
  '.required_pull_request_reviews.dismiss_stale_reviews // false'
compare_bool_setting \
  "require code owner reviews" \
  '.required_pull_request_reviews.require_code_owner_reviews // false' \
  '.required_pull_request_reviews.require_code_owner_reviews // false'

echo ""
echo "--- Branch Up-to-Date Requirement ---"
compare_bool_setting \
  "require up-to-date" \
  '.required_status_checks.strict // false' \
  '.required_status_checks.strict // false'

echo ""
echo "--- Repository Protection Controls ---"
compare_bool_setting \
  "enforce for admins" \
  '.enforce_admins // false' \
  '.enforce_admins.enabled // false'
compare_bool_setting \
  "allow force pushes" \
  '.allow_force_pushes // false' \
  '.allow_force_pushes.enabled // false'
compare_bool_setting \
  "allow deletions" \
  '.allow_deletions // false' \
  '.allow_deletions.enabled // false'
compare_bool_setting \
  "required linear history" \
  '.required_linear_history // false' \
  '.required_linear_history.enabled // false'

policy_restrictions=$(jq -c '.restrictions // null' "$POLICY_FILE")
live_restrictions=$(echo "$live_json" | jq -c '.restrictions // null')
if [ "$policy_restrictions" = "$live_restrictions" ]; then
  echo "  OK:      restrictions = $live_restrictions"
else
  echo "  DRIFT:   restrictions: policy=$policy_restrictions, live=$live_restrictions"
  drift=1
fi

echo ""
if [ "$drift" -eq 0 ]; then
  echo "OK: live branch protection matches versioned policy."
  exit 0
else
  echo "DRIFT DETECTED: live settings do not match policy."
  echo "Run 'scripts/apply_branch_protection.sh' to reconcile (admin required)."
  exit 1
fi
