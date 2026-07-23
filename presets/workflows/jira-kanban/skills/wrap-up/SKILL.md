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
  - mcp__bot-memory__memory_store
---

Run the wrap-up script for a merged PR:

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
3. Task archival in memory server
4. Slack notification (`release_pending`)
5. Remote branch deletion (tolerates already-deleted branches)
6. Local branch deletion (tolerates missing repos/branches)

After the script completes, use `memory_store` to save any notable learnings
from the implementation (category: `learning` or `codebase_pattern`).
