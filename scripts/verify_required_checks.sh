#!/usr/bin/env bash
# verify that all required status checks have passed on a given PR.
# usage: scripts/verify_required_checks.sh <pr_number> [repo]
set -euo pipefail

PR_NUMBER="${1:-}"
REPO="${2:-OpenShift-Fleet/rehor}"
CHECKS_FILE=".github/branch-protection/required-checks.json"

if [ -z "$PR_NUMBER" ]; then
  echo "usage: $0 <pr_number> [repo]"
  echo "  pr_number: GitHub PR number to verify"
  echo "  repo:      owner/repo (default: OpenShift-Fleet/rehor)"
  exit 1
fi

if [ ! -f "$CHECKS_FILE" ]; then
  echo "error: required checks manifest not found at $CHECKS_FILE"
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

echo "=== Verifying required checks for PR #${PR_NUMBER} on ${REPO} ==="
echo ""

# validate target branch and basic merge readiness before check-state evaluation
expected_branch=$(jq -r '.branch // "master"' "$CHECKS_FILE")
pr_meta=$(gh pr view "$PR_NUMBER" --repo "$REPO" \
  --json state,isDraft,baseRefName,mergeable,mergeStateStatus,reviewDecision 2>/dev/null || true)

if [ -z "$pr_meta" ] || [ "$pr_meta" = "null" ]; then
  echo "error: could not load PR metadata for #${PR_NUMBER}."
  echo "verify the PR exists and gh is authenticated."
  exit 1
fi

pr_state=$(echo "$pr_meta" | jq -r '.state // "UNKNOWN"')
pr_draft=$(echo "$pr_meta" | jq -r '.isDraft // false')
pr_base=$(echo "$pr_meta" | jq -r '.baseRefName // ""')
pr_mergeable=$(echo "$pr_meta" | jq -r '.mergeable // "UNKNOWN"')
pr_merge_status=$(echo "$pr_meta" | jq -r '.mergeStateStatus // "UNKNOWN"')
pr_review_decision=$(echo "$pr_meta" | jq -r '.reviewDecision // "UNKNOWN"')

if [ "$pr_base" != "$expected_branch" ]; then
  echo "error: PR base branch is '$pr_base', expected '$expected_branch'."
  echo "this check only reports merge readiness for the protected target branch."
  exit 1
fi

if [ "$pr_state" != "OPEN" ]; then
  echo "error: PR #${PR_NUMBER} is in state '$pr_state' (expected OPEN)."
  exit 1
fi

if [ "$pr_draft" = "true" ]; then
  echo "error: PR #${PR_NUMBER} is still a draft and not merge-ready."
  exit 1
fi

if [ "$pr_mergeable" = "CONFLICTING" ] || [ "$pr_merge_status" = "DIRTY" ]; then
  echo "error: PR #${PR_NUMBER} has merge conflicts (mergeable=$pr_mergeable, mergeStateStatus=$pr_merge_status)."
  exit 1
fi

if [ "$pr_merge_status" = "BEHIND" ]; then
  echo "error: PR #${PR_NUMBER} is behind its base branch and must be updated."
  exit 1
fi

if [ "$pr_review_decision" != "APPROVED" ]; then
  echo "error: PR #${PR_NUMBER} has review decision '$pr_review_decision' (expected APPROVED)."
  exit 1
fi

if [ "$pr_mergeable" = "UNKNOWN" ] || [ "$pr_merge_status" = "UNKNOWN" ]; then
  echo "warning: GitHub reports merge readiness as UNKNOWN"
  echo "         (mergeable=$pr_mergeable, mergeStateStatus=$pr_merge_status)."
  echo "         continuing with required check validation."
fi

# extract required check names from manifest (github_actions + konflux, where required=true)
required_checks=$(jq -r '
  (
    [.checks.github_actions[] | select(.required == true) | .name] +
    [.checks.konflux[] | select(.required == true) | .name]
  ) | .[]
' "$CHECKS_FILE")

required_check_count=$(jq -r '
  (
    [.checks.github_actions[] | select(.required == true) | .name] +
    [.checks.konflux[] | select(.required == true) | .name]
  ) | length
' "$CHECKS_FILE")

if [ "$required_check_count" -eq 0 ]; then
  echo "error: no required checks were found in $CHECKS_FILE."
  echo "fail-closed: at least one required check must be configured."
  exit 1
fi

# get current PR check statuses
pr_checks_json=$(gh pr checks "$PR_NUMBER" --repo "$REPO" --json name,state 2>/dev/null || true)

if [ -z "$pr_checks_json" ] || [ "$pr_checks_json" = "[]" ]; then
  echo "error: could not retrieve checks for PR #${PR_NUMBER}. verify the PR exists and gh is authenticated."
  exit 1
fi

failures=0
missing=0
pending=0
passed=0

while IFS= read -r check_name; do
  # look up all states for this check name. some names (e.g. "test")
  # can appear in multiple workflows, so we evaluate the worst state.
  states=$(echo "$pr_checks_json" | jq -r --arg name "$check_name" '
    [.[] | select(.name == $name) | .state // empty] | .[]
  ')

  if [ -z "$states" ]; then
    echo "  MISSING:  $check_name"
    missing=$((missing + 1))
  else
    worst_state="SUCCESS"
    while IFS= read -r state; do
      case "$state" in
        FAILURE|ERROR|TIMED_OUT|ACTION_REQUIRED|CANCELLED|STALE)
          worst_state="FAILURE"
          break
          ;;
        PENDING|EXPECTED|QUEUED|IN_PROGRESS|WAITING|REQUESTED)
          if [ "$worst_state" != "FAILURE" ]; then
            worst_state="PENDING"
          fi
          ;;
        SUCCESS|NEUTRAL|SKIPPED)
          ;;
        *)
          if [ "$worst_state" = "SUCCESS" ]; then
            worst_state="PENDING"
          fi
          ;;
      esac
    done <<< "$states"

    if [ "$worst_state" = "SUCCESS" ]; then
      echo "  PASS:     $check_name"
      passed=$((passed + 1))
    elif [ "$worst_state" = "PENDING" ]; then
      echo "  PENDING:  $check_name"
      pending=$((pending + 1))
    else
      echo "  FAILED:   $check_name"
      failures=$((failures + 1))
    fi
  fi
done <<< "$required_checks"

echo ""
echo "--- Summary ---"
echo "  passed:  $passed"
echo "  pending: $pending"
echo "  missing: $missing"
echo "  failed:  $failures"
echo ""

total_issues=$((failures + missing))
if [ "$pending" -gt 0 ]; then
  echo "WARN: $pending check(s) still pending. re-run once complete."
  exit 2
fi

if [ "$total_issues" -gt 0 ]; then
  echo "FAIL: $total_issues required check(s) missing or failed. PR is NOT ready to merge."
  exit 1
fi

echo "OK: all required checks passed. PR #${PR_NUMBER} is ready to merge."
exit 0
