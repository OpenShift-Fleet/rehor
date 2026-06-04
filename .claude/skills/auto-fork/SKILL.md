---
name: auto-fork
description: >
  Auto-fork repos + update config. Scans project-repos.json for missing forks → forks via gh/glab → updates config → commits.
when_to_use: >
  Triage when repo needs fork or setting up instances. Triggers: "fork repo", "auto fork", "setup fork", "missing fork".
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
2. **fork_repos** - Create forks using `gh repo fork` (GitHub) or `glab repo fork` (GitLab)
3. **update_and_commit** - Update project-repos.json with new fork URLs and commit changes

After this completes successfully, use the **push-and-pr** skill to push and create PR.

## Configuration

Env vars (auto-provided by runtime):

- `GH_USER_NAME` — bot GH username
- `GL_USER_NAME` — bot GL username
- `BOT_CONFIG_PATH` — config dir (default `rehor-config`)
- `BOT_INSTANCE_ID` — instance ID (optional, for branch naming)

## Repo Detection

Repos w/ `upstream` but `url` not matching bot account → need fork.
- GH: check `url` contains `github.com/{GH_USER_NAME}/` → fork via `gh repo fork`
- GL: check `url` contains `gitlab.cee.redhat.com/{GL_USER_NAME}/` → fork via `glab repo fork --hostname gitlab.cee.redhat.com`

## Workflow

1. Run auto-fork script to fork repos and commit changes
2. Script creates branch `bot/auto-fork` (or `bot/auto-fork-{instance_id}`)
3. Use push-and-pr skill to push branch and create PR to config repo

## Error Handling

Fail-fast: if any fork operation fails, stops and reports error.
Idempotent: safe to re-run if forks already exist (gh/glab repo fork handle gracefully).
