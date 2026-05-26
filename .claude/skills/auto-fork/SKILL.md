---
name: auto-fork
description: >
  Automatically fork repos and update config. Detects repos in project-repos.json
  without forks (or referenced in new instance configs without forks), creates forks
  under bot's GitHub account, updates project-repos.json, and commits changes.
  After running, use push-and-pr skill to create the PR.
when_to_use: >
  Invoke during triage when a repo needs forking, or when setting up new instances.
  Triggers on: "fork repo", "auto fork", "setup fork", "missing fork".
  Replaces manual gh repo fork operations.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/auto-fork/auto_fork.py *)"
  - Bash
  - Read
  - Skill
---

Detect repos without forks and automatically fork + update config:

```bash
python3 .claude/skills/auto-fork/auto_fork.py 2>&1
```

The script executes these operations:

1. **detect_unforkable_repos** - Scan project-repos.json for repos needing forks
2. **fork_repos** - Create forks using `gh repo fork` for GitHub repos
3. **update_and_commit** - Update project-repos.json with new fork URLs and commit changes

After this completes successfully, use the **push-and-pr** skill to push and create PR.

GitLab repos are skipped with a logged notice (manual forking required).

## Configuration

Set these environment variables:

```bash
# Config repo where project-repos.json lives (required)
export BOT_CONFIG_REPO=https://github.com/your-org/your-config-repo

# Bot's GitHub account (required) — username for fork destination
export BOT_GITHUB_USERNAME=platex-rehor-bot

# Instance ID (optional) — branch will be bot/auto-fork-{instance_id}
export BOT_INSTANCE_ID=rehor

# Config path (optional) — defaults to "rehor-config"
export BOT_CONFIG_PATH=rehor-config
```

## Repo Detection

Identifies repos needing forks:
- Repos with `upstream` defined but `url` doesn't match bot's account pattern
- For GitHub: checks if `url` contains `github.com/{BOT_GITHUB_USERNAME}/`
- GitLab repos logged and skipped (no auto-fork support yet)

## Workflow

1. Run auto-fork script to fork repos and commit changes
2. Script creates branch `bot/auto-fork` (or `bot/auto-fork-{instance_id}`)
3. Use push-and-pr skill to push branch and create PR to config repo

## Error Handling

Fail-fast: if any fork operation fails, stops and reports error.
Idempotent: safe to re-run if forks already exist (gh repo fork handles gracefully).
