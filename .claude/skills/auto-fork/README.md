# Auto-Fork Skill

Automatically fork repos and update configuration. Detects repos in `project-repos.json` without forks, creates forks under bot's GitHub account, and updates the config file with the new fork URLs.

## Features

- Scans `project-repos.json` for repos needing forks
- Creates forks using `gh repo fork` (GitHub only)
- Updates config file with fork URLs
- Commits changes to new branch
- GitLab repos logged and skipped (manual forking required)

## Usage

### Basic Workflow

```bash
# Step 1: Fork repos and commit changes
uv run python auto_fork.py

# Step 2: Push and create PR (use push-and-pr skill)
# The script creates branch bot/auto-fork (or bot/auto-fork-{instance_id})
```

### Dry Run

```bash
uv run python auto_fork.py --dry-run
```

## Configuration

Required environment variables:

```bash
# Bot's GitHub username (required)
export BOT_GITHUB_USERNAME=platex-rehor-bot

# Config repo URL (optional, for PR creation context)
export BOT_CONFIG_REPO=https://github.com/your-org/your-config-repo

# Instance ID (optional, affects branch name)
export BOT_INSTANCE_ID=rehor

# Config path (optional, defaults to "rehor-config")
export BOT_CONFIG_PATH=rehor-config
```

## Development

### Install Dependencies

```bash
uv sync
```

### Run Tests

```bash
# All tests
uv run pytest -v

# With coverage
uv run pytest --cov=. --cov-report=html -v

# Specific test file
uv run pytest tests/test_operations.py -v
```

### Lint

```bash
uv run ruff check .
```

## How It Works

1. **detect_unforkable_repos** - Scans `project-repos.json`:
   - Identifies repos with `upstream` field
   - Checks if `url` matches `BOT_GITHUB_USERNAME`
   - Skips repos already forked
   - Skips GitLab repos (GitHub only)

2. **fork_repos** - Creates forks:
   - Uses `gh repo fork --clone=false`
   - Handles already-forked repos gracefully
   - Generates fork URLs: `https://github.com/{bot-username}/{repo-name}.git`

3. **update_and_commit** - Updates config:
   - Updates `url` field in `project-repos.json`
   - Preserves all other repo entries
   - Creates branch `bot/auto-fork` or `bot/auto-fork-{instance_id}`
   - Commits changes with detailed message

After completion, use the `push-and-pr` skill to push and create a PR.

## Testing

The skill includes comprehensive unit and integration tests:

- **Unit tests** (`test_operations.py`): Test individual operations in isolation
- **Integration tests** (`test_integration.py`): Test complete workflows end-to-end
- **Test coverage**: All major code paths and error conditions

CI runs tests automatically on push/PR via GitHub Actions.
