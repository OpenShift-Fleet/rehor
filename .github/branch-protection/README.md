# Branch Protection Configuration

This directory contains versioned branch protection policy for the `master` branch of `OpenShift-Fleet/rehor`.

## Files

| File | Purpose |
|------|---------|
| `required-checks.json` | Canonical list of required status checks with scope notes |
| `master-protection.json` | Full branch protection policy (GitHub API shape) |

## Required Checks

Check names are extracted from real PR runs using `gh pr checks <number> --repo OpenShift-Fleet/rehor`. The names must match exactly what GitHub reports, including Konflux prefixes.

### Path-scoping caveat

GitHub Actions workflows in this repo use path filters. A PR touching only Python code won't trigger Go or Dashboard checks. If branch protection requires a check that doesn't run, the PR will be blocked.

**Current approach:** require only the two Konflux container build checks that always run on every PR (main bot + memory-server). Path-filtered checks (all GitHub Actions workflows + proxy Konflux) are trusted to pass when they fire but not listed as hard requirements in branch protection.

### Updating required checks

When adding a new CI workflow or renaming a job:

1. Open a PR that exercises the new check
2. Run `gh pr checks <number> --repo OpenShift-Fleet/rehor` to capture the exact reported name
3. Update `required-checks.json` with the new entry
4. Update `master-protection.json` if the check should be a hard merge gate
5. Ask an admin to re-apply protection via `scripts/apply_branch_protection.sh`

## Applying protection

Branch protection changes require **admin** access to the repository.

`dismiss_stale_reviews` is set to `true` in the versioned policy as the current recommended default, and can be adjusted by maintainers if team review behavior changes.

```bash
# verify current state matches policy
scripts/check_branch_protection.sh

# apply policy (admin only)
scripts/apply_branch_protection.sh
```

See `docs/operations/rehor-77-branch-protection-rollout.md` for the full rollout runbook.
