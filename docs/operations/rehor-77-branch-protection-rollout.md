# Branch Protection Rollout (REHOR-77)

This runbook documents how to apply, verify, and roll back branch protection on the `master` branch of `OpenShift-Fleet/rehor`.

## Prerequisites

- **Admin access** to `OpenShift-Fleet/rehor` on GitHub
- `gh` CLI installed and authenticated (`gh auth status`)
- `jq` installed
- Repository cloned with latest `master`

## Policy overview

The versioned policy lives at `.github/branch-protection/master-protection.json`. It enforces:

| Setting | Value |
|---------|-------|
| Required approving reviews | 1 |
| Dismiss stale reviews | yes |
| Require branch up-to-date | yes |
| Allow force push | no |
| Allow deletions | no |
| Enforce for admins | yes |

`dismiss_stale_reviews: true` is the recommended default for this repo right now. Martin can adjust this if team review flow changes.

### Required status checks

These checks must pass before a PR can merge:

**Always-running (hard required in branch protection):**

- `Red Hat Konflux / platform-frontend-ai-dev-on-pull-request`
- `Red Hat Konflux / platform-frontend-ai-dev-memory-server-on-pull-request`

**Path-filtered (not required in branch protection):**

These run only when their path filters match. They are not enforced in branch protection to avoid blocking unrelated PRs, but they must pass when they do run:

- `format` / `lint` / `typecheck` / `test` (Python CI, triggered by `**.py`/`pyproject.toml`/`uv.lock`)
- `python-audit` / `go-audit` / `node-audit` (Dependency audit, triggered by lock/dep files)
- `security` / `container-scan` (Memory Server CI, triggered by `memory-server/**`)
- `Red Hat Konflux / platform-frontend-ai-dev-proxy-on-pull-request` (triggered by `proxy/**`)

## Applying protection

```bash
# 1. verify no protection exists yet (or check current state)
make check-branch-protection

# 2. review what will be applied
cat .github/branch-protection/master-protection.json | jq .

# 3. apply (interactive confirmation prompt)
scripts/apply_branch_protection.sh

# 4. verify applied correctly
make check-branch-protection
```

## Verifying on a live PR

After applying protection, verify enforcement works on an open PR:

```bash
# check a specific PR
make verify-required-checks PR=408

# expected output: all required checks listed with PASS/MISSING/FAILED
```

Try merging a PR with a failing or missing check via the GitHub UI to confirm it's blocked.

## Validation evidence (authoring phase, before admin apply)

The following dry-runs were executed while implementing REHOR-77:

- `make verify-required-checks PR=403` -> PASS, both required Konflux checks passed
- `make verify-required-checks PR=407` -> FAIL, merge conflicts detected (`mergeable=CONFLICTING`, `mergeStateStatus=DIRTY`)
- `make verify-required-checks PR=392` -> FAIL, merge conflicts detected (`mergeable=CONFLICTING`, `mergeStateStatus=DIRTY`)

Current pre-apply state check:

- `make check-branch-protection` -> reports no branch protection configured on `master` yet (expected before admin apply)

This validates script behavior before policy rollout:

- required checks are read from versioned JSON
- PR check lookup works for real historical PRs
- PR base/draft/state/merge-conflict readiness is validated before success is reported
- missing branch protection is detected and reported clearly

## Rollback

If protection is causing unexpected merge blocks:

### Emergency: disable all protection

```bash
gh api --method DELETE "/repos/OpenShift-Fleet/rehor/branches/master/protection"
```

This removes all branch protection immediately. Re-apply later with `scripts/apply_branch_protection.sh`.

### Partial: remove a specific required check

If one check is flaky or misconfigured:

1. Edit `.github/branch-protection/master-protection.json` and remove the check from `required_status_checks.contexts`
2. Re-run `scripts/apply_branch_protection.sh`
3. Open a follow-up ticket to fix the check and re-add it

### Adding a new required check

1. Verify the check name from a real PR: `gh pr checks <number> --repo OpenShift-Fleet/rehor`
2. Add to `required-checks.json` and `master-protection.json`
3. Re-apply protection
4. Verify with `make check-branch-protection`

## Post-rollout verification checklist

- [ ] `make check-branch-protection` reports no drift
- [ ] `make verify-required-checks PR=<recent_pr>` shows all required checks passing
- [ ] GitHub UI shows branch protection badge on master
- [ ] A PR without required checks cannot be merged (test with a draft PR if needed)
- [ ] Admin enforcement behavior is confirmed (enforce_admins is true)

## Incident response

If branch protection is blocking legitimate merges:

1. Check if the blocking check is in the required list: `make check-branch-protection`
2. If the check is failing due to a flaky issue, update policy JSON to remove or relax the requirement, then re-apply protection as admin
3. If the check shouldn't be required, follow the rollback procedure above
4. File a ticket for root cause if a check is consistently failing

## Ownership

- **Policy authoring**: any contributor (via PR to update JSON files)
- **Policy application**: repository admin (Martin or equivalent)
- **Ticket**: REHOR-77
