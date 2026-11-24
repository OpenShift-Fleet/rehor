---
name: wrap-up
description: >
  Post-merge bookkeeping for completed PRs. Archives task, transitions Jira to
  "Release Pending", posts Jira comment, sends Slack notification, deletes bot
  branches (remote + local). Handles already-deleted branches gracefully.
when_to_use: >
  Invoke when triage shows a PR in MERGED state. Triggers on: "merged",
  "wrap up", "wrap-up", "archive", "release pending", "PR merged".
  Replaces manual task_update + jira_transition + jira_comment + slack_notify
  + branch deletion calls.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/wrap-up/wrap_up.py *)"
  - Read
  - mcp__bot-memory__task_outcome_report
  - mcp__bot-memory__task_remove
  - mcp__bot-memory__task_get
  - mcp__bot-memory__memory_store
---

## Stage outcome evidence before wrap-up

Before invoking the script for a real wrap-up, the agent LLM must call
`task_outcome_report` with `external_key: <JIRA_KEY>`, `source_type: "jira"`,
`artifacts`, `evidence`, and `notes` (string or null). Wait for successful report
staging before running the script. Use verified provider facts already available
in the input/context; do not re-fetch facts already supplied or invent missing facts.

Finish evidence-relevant task updates before staging, then run wrap-up immediately to archive. Actual status changes invalidate the staged pointer except completion to `done`; identical status writes preserve it. Reopening an archived task always invalidates it, even to `done`. Changed metadata values invalidate it except `last_step`, `next_step`, and `status_before_pause`; identical values preserve it. Report history remains intact.

- Include all relevant PR/MR artifacts with `type` (`github_pr` or `gitlab_mr`),
  stable `id` and/or `url`, and verified provider metadata such as state and
  base/target repository. Retain Jira and other workflow artifacts when relevant.
- Every evidence item uses the same fields: `source`, `reference`, `resolution`
  (`accepted`, `rejected`, or `unknown`), `disposition`, `reason`, and optional `kind` and `authorType`.
  `kind` is `Literal["state", "comment"]`, default `state`. New comment payloads must set `kind: "comment"`; provider/workflow facts use `kind: "state"` or legacy omission.
  `authorType` is optional (`human`, `workflow`, `agent`, or `automation`). Only comment evidence marked agent/automation is excluded; state facts remain valid regardless of author type. Human/workflow comments count, and comments without `authorType` retain their existing counted behavior.
  Keep the raw provider status/resolution/comment in `disposition`; the LLM assigns
  each evidence resolution and reason from verified facts. Identify comments by
  content/context when Jira credentials are shared; do not assume author identity
  proves a human decision.
- A verified merged PR/MR can support `accepted` evidence for that artifact.
  Include relevant Jira resolutions and authoritative comments too; do not assume
  every task is accepted because one PR merged. Label ambiguous evidence `unknown`
  and explain missing/conflicting facts in `notes`. Do not submit a final task
  decision. The server derives it; the script does not auto-label acceptance.
- Handle superseded PRs/MRs explicitly: retain the old artifact and put its stable
  ID or URL in the replacement artifact's `supersedes` list. Evidence references
  must identify the corresponding artifacts consistently. A closed-unmerged,
  superseded PR/MR is not by itself task rejection or task-level `Obsolete`.
  Record replacement facts and explain the relationship in `notes`.

For `--dry-run`, do not stage a report or call any mutating MCP tool.

Run the wrap-up script after successful report staging:

```bash
python3 .claude/skills/wrap-up/wrap_up.py <JIRA_KEY> 2>&1
```

Use `--dry-run` to preview without making changes:

```bash
python3 .claude/skills/wrap-up/wrap_up.py <JIRA_KEY> --dry-run 2>&1
```

The script handles:
1. Jira transition → "Release Pending"
2. Jira comment with PR links
3. Task archival via MCP `task_remove` (requires the staged report)
4. Slack notification (`release_pending`)
5. Remote branch deletion (tolerates already-deleted branches)
6. Local branch deletion (tolerates missing repos/branches)

## Archive failure recovery

Any skill/script error overrides `DONE` or a zero exit code. Older deployed
scripts may print `DONE` and perform cleanup even after archive failure. Inspect
the failed step and which later steps actually completed; never blindly rerun
the whole skill. New scripts exit nonzero before cleanup on archive failure.

If the report is missing or the archive freshness guard fails, stage a fresh `task_outcome_report` from verified current-work input/context as above (`correction=true` if the task is already archived). Never restore or reuse a historical report pointer. Then retry
**archive only** via `task_remove` with the Jira key
and `source_type: "jira"`. Do not retry a rejected `task_update(status="archived")`.
Do not bypass the guard with REST DELETE or `manual=true`, or fabricate acceptance.
If facts are unavailable, stop and report the blocker. For transport/server
errors, resolve the error and use `task_get` to inspect state before retrying;
an archive may have succeeded before its response was lost.

After `task_remove` succeeds, run this only if Slack/branch cleanup is pending:

```bash
python3 .claude/skills/wrap-up/wrap_up.py <JIRA_KEY> --resume-cleanup 2>&1
```

This mode skips Jira transition/comment, loads the archived task via `task_get`,
and retries strict, idempotent `task_remove` to verify its selected report before
cleanup. Missing/corrupt task/report state blocks cleanup. It accepts any reported
decision (`accepted`, `rejected`, `inconclusive`, `obsolete`), not just acceptance.
It requires a backend supporting reported archive retries; if verification fails,
stop instead of weakening the guard.

If Slack already completed and only branches remain, add `--skip-slack` (valid
only with `--resume-cleanup`) to avoid duplicate notifications. Otherwise normal
Slack cooldown applies. Branch deletion tolerates already-deleted branches.
If legacy cleanup already completed, retry archive only; do not resume cleanup.
Add `--dry-run` to preview recovery without mutations: `task_get` still reads
state, but report verification via `task_remove` is deferred until the real run.

Real cleanup failures exit nonzero without `DONE` after best-effort cleanup and
list pending steps (Slack notification, remote/local branch deletion by repo).
Fix those errors, then follow the printed `--resume-cleanup` command; add
`--skip-slack` when notification completed. Do not stage another report or rerun
completed Jira steps. Switch off the task branch before retrying a current-branch
local deletion failure. Missing Slack configuration, cooldown, and digest
suppression are intentional non-error no-ops. Failed Jira steps are reported
separately and must be retried individually, not through cleanup recovery.

After the script completes successfully, use `memory_store` to save any notable learnings
from the implementation (category: `learning` or `codebase_pattern`).
