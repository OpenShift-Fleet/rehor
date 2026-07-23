# Push and PR Skill

Consolidates git push (with proper credential handling) and PR creation into a single efficient operation, eliminating 5-8 wasted tool calls per implementation cycle.

## Quick Start

```bash
/push-and-pr "Add new feature" "Implements feature X with Y and Z"
```

## What It Does

This skill executes 4 operations in sequence:

1. **detect_repository** - Determine repo type (GitHub/GitLab, fork/direct) from project-repos.json
2. **sync_fork** - Sync fork with upstream if using a fork (gh repo sync / glab repo sync)
3. **push_branch** - Push current branch with proper credential helper
4. **create_pr** - Create PR with correct flags (--head for forks, --repo for upstream)

All operations use **fail-fast error handling**: if any operation fails, execution stops immediately.

## Operations

### 1. Detect Repository (`detect_repository`)

Determines repository type and configuration:
- Reads project-repos.json if available
- Falls back to git remote inspection
- Detects GitHub vs GitLab
- Detects fork vs direct push

### 2. Sync Fork (`sync_fork`)

Syncs fork with upstream before pushing (only if using a fork):

**GitHub**: `gh repo sync owner/fork`
**GitLab**: `glab repo sync`

### 3. Push Branch (`push_branch`)

Pushes current branch with proper credential helper:

**GitHub**: `git -c credential.helper='!gh auth git-credential' push origin <branch>`
**GitLab**: `git -c credential.helper='!glab auth git-credential' push origin <branch>`

### 4. Create PR (`create_pr`)

Creates pull/merge request with correct flags:

**GitHub (fork)**: `gh pr create --repo <upstream> --head <fork>:<branch> --title <title> --body <body>`
**GitHub (direct)**: `gh pr create --title <title> --body <body>`
**GitLab**: `glab mr create --hostname gitlab.cee.redhat.com --title <title> --description <body>`

Returns PR/MR URL and number.

## Configuration

No environment variables needed - uses existing gh/glab CLI authentication.

Optional project-repos.json for repository configuration:

```json
{
  "hcc-ai-assistant": {
    "type": "github",
    "upstream": "RedHatInsights/hcc-ai-assistant",
    "fork": "catastrophe-brandon/hcc-ai-assistant"
  }
}
```

## Repository Detection Logic

1. Check for project-repos.json in current directory or parent
2. If found, use configuration from file
3. If not found, inspect `git remote -v` output:
   - Check if origin is a fork (different owner than upstream)
   - Detect GitHub (github.com) vs GitLab (gitlab.cee.redhat.com)

## Credential Handling

Uses gh/glab CLI as credential helper:
- `git -c credential.helper='!gh auth git-credential'` for GitHub
- `git -c credential.helper='!glab auth git-credential'` for GitLab

This eliminates auth failures without exposing tokens.

## Testing

The skill includes comprehensive tests:
- **Unit tests**: 43 tests for individual operations
- **Integration tests**: 19 tests for full workflow
- **Total**: 62 tests

Run tests:

```bash
cd .claude/skills/push-and-pr
uv sync --all-extras
uv run pytest -v
```

## Development

```bash
# Install dependencies
uv sync --all-extras

# Run tests
uv run pytest -v

# Run tests with coverage
uv run pytest --cov=scripts --cov-report=html

# Format code
black .

# Lint
ruff check .
ruff check --fix .

# Dry-run mode
uv run python scripts/push_and_pr_operations.py "Test PR" "Test description" --dry-run
```

## PR Template Support

The skill can discover and use a repo's PR template to structure the PR body.

### Finding Templates

```bash
python3 scripts/push_and_pr_operations.py --find-template
```

Searches these locations in order (first match wins):
1. `.github/pull_request_template.md`
2. `.github/PULL_REQUEST_TEMPLATE.md`
3. `pull_request_template.md`
4. `PULL_REQUEST_TEMPLATE.md`
5. `.github/PULL_REQUEST_TEMPLATE/default.md`

Exit 0 and prints template content if found. Exit 1 if no template exists.

### Workflow

1. Run `--find-template` to discover the repo's PR template
2. If found, fill in each section (description, checklist, AI disclosure, etc.)
3. Pass the filled template as the `body` argument to the main command
4. If not found, use freeform format (ticket key + changes summary)

## Error Handling

All operations follow fail-fast behavior:
- If any operation fails, execution stops immediately
- Error messages include operation name and details
- Handles both GitHub and GitLab error responses

## Comparison: Before vs After

### Before (without skill): 5-8 tool calls

```
1. Bash: git status (check for uncommitted changes)
2. Bash: gh repo sync owner/fork (or glab repo sync)
3. Bash: git push origin branch
   - May fail with auth error
4. Bash: git -c credential.helper='!gh auth git-credential' push origin branch
5. Bash: git remote -v (check if fork)
6. Bash: gh pr create --repo upstream --head fork:branch --title "..." --body "..."
   - May fail with wrong flags
7. Bash: gh pr create --title "..." --body "..." (retry with correct flags)
8. Read PR URL from output
```

**Total**: 5-8 tool calls, multiple retries, credential failures

### After (with skill): 1 tool call

```
1. /push-and-pr "Add feature" "Implements feature X"
```

**Total**: 1 tool call, automatic credential handling, fork detection, correct flags

**Reduction**: Eliminates 4-7 tool calls (80-87% reduction)

## Implementation

The skill is implemented in Python 3.12+ with:
- **subprocess** for git/gh/glab commands
- **json** for project-repos.json parsing
- **fail-fast error handling** for reliability
- **comprehensive logging** for observability
- **dry-run mode** for safe testing
- **type hints** for code clarity

## Related

- JIRA: RHCLOUD-47264
- See also: `/post-pr` skill for post-PR-creation bookkeeping
- See also: `/claim-ticket` skill for ticket claiming
