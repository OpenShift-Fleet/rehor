# PR Review Notes — #426

**PR:** https://github.com/OpenShift-Fleet/rehor/pull/426
**Branch:** RHCLOUD-48014-digest-all-paths
**Worktree:** `git-worktrees/RHCLOUD-48014-digest-all-paths`
**Author:** radekkaluzik
**Ticket:** RHCLOUD-48014

## Step 1 — PR Summary Analysis

- [x] Read PR title/body and linked ticket purpose
- [x] Reviewed discussion/reviews (none unresolved; author `/retest` only)
- [x] Reviewed file list and stats (+2 / -0, single file `bot/run.py`)
- [x] Confirmed CI: format/lint/test/typecheck + Konflux PR pipelines green

### Notes

Digest was only invoked after a completed agent cycle. Skip/error preflight paths `continue` before that call, so idle days never sent digests. PR adds `_try_slack_digest()` on both early-exit paths, matching the agent path (digest before sleep).

### Unresolved Comments (from PR)

None.

## Step 3 — Context Gathering

- [x] `bot/slack_digest.py` — early returns (webhook / weekend / hour), exception swallowed
- [x] `memory-server/.../slack.py` `slack_send_digest` — empty queue no-op; `digest_key` dedup after successful send
- [x] Docs (`docs/presets/envs.md`) — runner triggers digest after each cycle
- [x] Existing tests: `bot/tests/test_slack_digest_*.py`, memory-server digest tests; no main-loop coverage for these call sites
- [x] CI validation gates already green on the PR

## Step 4 — Code Review (scored)

**Scope:** Modified logic (2 call-site additions)
**Validation:** lint PASS | typecheck PASS | test PASS (CI) | format PASS
**Test confidence:** full (CI suite)

### Scores

| Lens | Score | Findings |
|------|-------|----------|
| Functionality | 10/10 | 0 |
| Security | 10/10 | 0 |
| Quality | 10/10 | 0 |
| **Overall** | **10.0/10** | |

### Verdict: APPROVE

### Findings

None.

### Incidental observations (not scored)

- Three call sites for `_try_slack_digest()` (error / skip / agent). A future loop refactor could call once before sleep on all paths; not needed for this fix.
- After `SLACK_DIGEST_HOUR`, every loop iteration still hits the memory MCP until local hour checks fail next day; amplified by idle-path calls but pre-existing and server-deduped.
- Docs still say "after each cycle"; behavior now includes idle/error iterations — wording still fine.

## Step 5 — Final Recommendation

**Status:** Approve

**Summary:** Correct, minimal fix for a real bug. Placement matches the agent path; digest helpers remain exception-safe and opt-in; empty queue / already-sent paths make frequent calls safe.

**Action items for author:** None.

### Inline Comments to Submit

None.
