---
name: push-and-pr
description: >
  Consolidates git push and PR/MR creation into a single efficient operation,
  eliminating 5-8 wasted tool calls per implementation cycle
when_to_use: >
  Invoke after implementing changes and committing to push and create PR. Triggers on:
  "push and pr", "create pr", "open pr", "git push pr". Replaces manual git push +
  gh pr create / glab mr create calls.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/push-and-pr/scripts/push_and_pr_operations.py *)"
  - Read
---

## Template-aware PR body

Before creating the PR, check if the repo has a PR template and use it to structure the body.

**Step 1 — Discover template:**

```bash
python3 .claude/skills/push-and-pr/scripts/push_and_pr_operations.py --find-template 2>&1
```

- Exit 0 → template found, raw content printed to stdout.
- Exit 1 → no template found, use freeform format (ticket key + changes summary).

**Step 2 — Fill template sections:**

If a template was found, fill in each section before passing as `<PR_BODY>`:
- Remove HTML comments (`<!-- ... -->`) and replace with actual content.
- **Description/Summary** → what changed, why, Jira ticket link `[KEY](url)`.
- **Checklist** → mark completed items `[x]`, leave others `[ ]`.
- **AI disclosure** → "Assisted by: Claude Code".
- **Screenshots** → reference uploaded screenshot URLs (if applicable).
- **Other sections** → fill based on heading context; write "N/A" if not applicable.

**Step 3 — Push and create PR:**

```bash
python3 .claude/skills/push-and-pr/scripts/push_and_pr_operations.py "<PR_TITLE>" "<PR_BODY>" 2>&1
```

Use `--dry-run` to preview without executing:

```bash
python3 .claude/skills/push-and-pr/scripts/push_and_pr_operations.py "<PR_TITLE>" "<PR_BODY>" --dry-run 2>&1
```

The script executes 4 operations in sequence:

1. **Detect repository** - Determine repo type (GitHub/GitLab, fork/direct) from project-repos.json or git remotes
2. **Sync fork** - Sync fork with upstream if using a fork (gh repo sync / glab repo sync)
3. **Push branch** - Push current branch with proper credential helper (gh auth / glab auth)
4. **Create PR** - Create PR/MR with correct flags (--head for forks, --repo for upstream)

## Repository Detection

Checks for project-repos.json in current directory or parent. If not found, inspects git remotes:
- Detects GitHub (github.com) vs GitLab (gitlab.cee.redhat.com)
- Detects fork (different owner than upstream)

## Credential Handling

Uses gh/glab CLI as credential helper:
- GitHub: `git -c credential.helper='!gh auth git-credential' push`
- GitLab: `git -c credential.helper='!glab auth git-credential' push`

No API tokens needed - relies on existing gh/glab CLI authentication.

## Error Handling

Fail-fast approach: if any operation fails, execution stops immediately and reports the error.
