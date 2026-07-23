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

Fully automated workflow:

```bash
python3 .claude/skills/auto-fork/auto_fork.py 2>&1
```

Script operations:
1. **detect_unforkable_repos** - Scan project-repos.json for repos needing forks
2. **fork_repos** - Create forks using `gh repo fork` (GitHub) or `glab repo fork` (GitLab)
3. **update_and_commit** - Update project-repos.json with fork URLs, create branch, commit changes
4. **push_and_create_pr** - Push branch and create PR to config repo (integrated push-and-pr skill)

Complete end-to-end automation — no manual steps required.

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

Single command execution:
1. Detects repos needing forks
2. Creates forks via gh/glab CLI
3. Updates project-repos.json, creates branch `bot/auto-fork[-{instance_id}]`, commits
4. Automatically pushes branch and creates PR to config repo

Fully automated end-to-end.

## Error Handling

Fail-fast: if any fork operation fails, stops and reports error.
Idempotent: safe to re-run if forks already exist (gh/glab repo fork handle gracefully).
