# Writing Custom Preflight Scripts

Preflight scripts run **before** each Claude session to gather data and decide whether to start a session. They execute as plain Python — no AI tokens consumed. If there's nothing to do, the cycle ends without starting a Claude session at all.

## Output Contract

Every preflight script must print **exactly one JSON object** to stdout:

```json
{"status": "start", "content": "Work found — details here..."}
```

| Status | Meaning | Session starts? |
|--------|---------|-----------------|
| `start` | Work found. `content` becomes part of the session prompt. | Yes |
| `skip` | Nothing to do. `content` is logged but no session starts. | No |

The runner also recognizes `error` status, but you don't need to emit it — the runner produces it automatically when your script fails (non-zero exit, timeout, invalid JSON, etc.).

### Rules

- Print JSON to **stdout**. Use **stderr** for debug logging — it won't interfere with the output.
- `content` is required when `status` is `start`. It becomes the AI's input prompt, so include all data the bot needs for its decision.
- `content` is optional for `skip`. If provided, it's logged for debugging (e.g. "All 12 Jenkins jobs healthy").

## Where Scripts Go

Scripts can live in two places:

### 1. Workflow preflight directory

```
presets/workflows/<workflow-name>/preflight/
└── 01-check-something.py
```

Runs for **every instance** that uses this workflow. Use for checks that are fundamental to the workflow's decision loop (e.g. the jira-sprint workflow's PR status and Jira comment checks).

### 2. Instance preflight directory

```
instance/<config>/agent/preflight/
└── 01-check-something.py
```

Runs **only for that instance**. Use for instance-specific checks (e.g. monitoring a Jenkins server only your team cares about).

Both directories are scanned. Scripts from the workflow directory run first, then instance scripts, all sorted by filename within each group.

## Naming Convention

```
NN-description.py
```

- **`NN`** — Two-digit number controlling execution order (`01`, `02`, etc.)
- **`description`** — Kebab-case summary of what the script checks

Examples from the built-in jira-sprint workflow:

```
01-gh-pr-status.py     # Check GitHub PR states
02-gl-mr-status.py     # Check GitLab MR states
03-jira-sprint.py      # Check Jira sprint for comments and new work
```

Only `.py` files are discovered. Other file types are ignored.

## Lifecycle

When the bot's polling loop fires, here's what happens:

```
1. discover_preflight_scripts()
   ├── Scan workflow preflight/ dir
   └── Scan instance preflight/ dir (if exists)

2. For each script (sorted by filename):
   ├── Set PYTHONPATH (shared modules + skills)
   ├── Run: python3 <script>
   │   ├── cwd = bot repo root (script_dir)
   │   ├── timeout = 120 seconds
   │   └── env = parent process env + PYTHONPATH
   └── Parse JSON from stdout → ScriptResult

3. Aggregate results
   ├── Errors are excluded from the decision
   ├── Any "start" → session starts (all content concatenated)
   ├── All "skip" → no session
   └── All errors → cycle logged as error, backoff applied
```

### PYTHONPATH

Before running each script, the runner prepends two directories to `PYTHONPATH`:

| Path | Contents |
|------|----------|
| `presets/shared/preflight/` | Shared utility modules (see below) |
| `.claude/skills/` | Skill scripts (e.g. triage_jenkins.py) |

This means your script can `import common` or `from common import output_result` without path manipulation.

## Aggregation Logic

When multiple scripts run, results are combined:

1. **Errored scripts are excluded** from the start/skip decision. A transient API failure in one script doesn't block work found by another.
2. **Any `start`** among non-errored scripts → the session starts. Content from all `start` scripts is concatenated.
3. **All `skip`** → no session starts. Skip content is logged.
4. **All scripts errored** → the cycle is recorded as an error. Consecutive errors trigger exponential backoff (runner-managed, up to 300s).

Error summaries from failed scripts are prepended to the session prompt (prefixed with `[PREFLIGHT ERROR]`) so the AI has context about partial data.

## Shared Modules

These modules are available via PYTHONPATH from `presets/shared/preflight/`:

### `common.py`

The main utility module. Key functions:

| Function | Description |
|----------|-------------|
| `output_result(status, content)` | Print the JSON output protocol to stdout |
| `load_state()` | Load inter-script state from `data/preflight-state.json` |
| `save_state(updates)` | Merge updates into inter-script state file |
| `get_tasks()` | Fetch active tasks from the memory server (cached via state) |
| `get_capacity()` | Get `(active_count, max)` capacity tuple (cached via state) |
| `load_project_repos()` | Load `project-repos.json` |
| `build_repo_lookup()` | Build name → canonical key mapping from project-repos |
| `upstream_repo(repo_name)` | Resolve repo name to `(upstream_path, host)` |
| `fmt_comments(comments, label)` | Format a list of comments for the prompt |
| `fmt_task_header(task)` | Format common task fields as header lines |
| `get_task_prs(task)` | Extract PR info from task metadata |
| `is_bot_author(author)` | Check if a comment author is a known bot |

### Other shared modules

| Module | Description |
|--------|-------------|
| `gh_pr_status.py` | GitHub PR status checking (CI, reviews, conflicts) |
| `gl_mr_status.py` | GitLab MR status checking (pipelines, threads) |
| `jira_sprint_preflight.py` | Jira sprint data fetching |
| `jira_triage.py` | Jira comment triage helpers |

## Inter-Script State

Scripts within the same preflight run can share data through a state file:

```python
from common import load_state, save_state

# Script 01: fetch tasks once
tasks = fetch_tasks_from_api()
save_state({"tasks": tasks})

# Script 02: reuse cached tasks
state = load_state()
tasks = state.get("tasks", [])
```

The state file (`data/preflight-state.json`) is automatically cleaned up after each preflight run completes. It only persists for the duration of a single run — not across cycles.

This is useful for expensive API calls. For example, the built-in scripts use it to fetch the task list once in the first script and reuse it in subsequent scripts.

## Error Handling

The runner handles all failure modes — your script doesn't need to catch these:

| Failure | What the runner does |
|---------|---------------------|
| Non-zero exit code | `ScriptResult(status="error", content=stderr)` |
| Timeout (120s) | `ScriptResult(status="error", content="timed out after 120s")` |
| Empty stdout | `ScriptResult(status="error", content="produced no output")` |
| Invalid JSON | `ScriptResult(status="error", content="invalid JSON: ...")` |
| Unknown status | `ScriptResult(status="error", content="unknown status: ...")` |
| `start` with empty content | `ScriptResult(status="error", content="returned start with empty content")` |

**Your script should still handle its own internal errors gracefully** — catch API failures, missing env vars, etc. and output a `skip` status with an explanation rather than crashing:

```python
data = fetch_from_api()
if data is None:
    output_result("skip", "API unreachable — skipping this check")
    return
```

## Complete Skeleton

Minimal preflight script:

```python
#!/usr/bin/env python3
"""Pre-flight: check if there's work to do."""

import json
import sys


def main():
    # Gather data (API calls, file checks, etc.)
    work_items = check_for_work()

    if not work_items:
        json.dump(
            {"status": "skip", "content": "No work found."},
            sys.stdout,
        )
        return

    # Build prompt content for the AI session
    content = f"Found {len(work_items)} items to process:\n"
    for item in work_items:
        content += f"- {item}\n"

    json.dump(
        {"status": "start", "content": content},
        sys.stdout,
    )


def check_for_work():
    """Replace with your actual check logic."""
    return []


if __name__ == "__main__":
    main()
```

### Using shared utilities

```python
#!/usr/bin/env python3
"""Pre-flight: check tasks and PR statuses."""

from common import get_tasks, get_task_prs, output_result


def main():
    tasks = get_tasks()
    if not tasks:
        output_result("skip", "No active tasks.")
        return

    actionable = []
    for task in tasks:
        prs = get_task_prs(task)
        if prs:
            actionable.append(task)

    if not actionable:
        output_result("skip", f"{len(tasks)} tasks, none with open PRs.")
        return

    lines = [f"{len(actionable)} tasks with open PRs:"]
    for t in actionable:
        lines.append(f"  {t.get('external_key', '?')} [{t.get('status', '?')}]")

    output_result("start", "\n".join(lines))


if __name__ == "__main__":
    main()
```

## Real Example Pattern

A common pattern for custom preflight scripts is fetching data from an external service, classifying it, and deciding whether to start a session. Here's the general structure:

```python
#!/usr/bin/env python3
"""Pre-flight: check external service for issues."""

import json
import subprocess
import sys


def fetch_data():
    """Fetch data from your service. Return None on failure."""
    try:
        proc = subprocess.run(
            [sys.executable, "path/to/fetch_script.py"],
            capture_output=True, text=True, timeout=60,
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return None
        return json.loads(proc.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        return None


def classify(data):
    """Classify items. Return (actionable, healthy, has_issues)."""
    items = data.get("items", [])
    if not items:
        return [], [], False

    actionable = [i for i in items if i.get("status") == "failing"]
    healthy = [i for i in items if i.get("status") != "failing"]
    return actionable, healthy, len(actionable) > 0


def main():
    data = fetch_data()
    if data is None:
        json.dump(
            {"status": "skip", "content": "Service unreachable. Skipping."},
            sys.stdout,
        )
        return

    actionable, healthy, has_issues = classify(data)

    if not has_issues:
        json.dump(
            {"status": "skip",
             "content": f"All {len(healthy)} items healthy. Skipping."},
            sys.stdout,
        )
        return

    content = f"{len(actionable)} failing, {len(healthy)} healthy.\n"
    content += json.dumps({"failing": actionable}, indent=2)

    json.dump(
        {"status": "start", "content": content},
        sys.stdout,
    )


if __name__ == "__main__":
    main()
```

Key principles:
- **Fail gracefully**: If your API is down, output `skip`, not a crash. The bot can try again next cycle.
- **Include only actionable data**: Don't dump everything into the prompt. Healthy items waste tokens — summarize them with a count.
- **Deterministic classification**: Do filtering, sorting, and priority in Python (free), not in the AI session (expensive).

## Testing

### Run standalone

```bash
# Set any env vars your script needs
export BOT_INSTANCE_ID="test"

# Run from the bot repo root (scripts expect cwd = script_dir)
cd /path/to/dev-bot
PYTHONPATH=presets/shared/preflight:.claude/skills python3 path/to/your-script.py
```

### Validate output

The output should be exactly one JSON object. Verify with:

```bash
python3 your-script.py | python3 -m json.tool
```

You should see `{"status": "start"|"skip", "content": "..."}`.

### Common mistakes

- **Printing debug info to stdout** — Use `print(..., file=sys.stderr)` for logging. Anything on stdout is parsed as the JSON result.
- **Return value mismatch** — If a helper function returns N values, the caller must unpack exactly N. The runner won't catch this — Python will raise a `ValueError` and your script exits non-zero.
- **Missing env vars** — Check `os.environ.get()` and handle gracefully rather than crashing with `KeyError`.
- **Forgetting `if __name__ == "__main__"`** — Without this guard, importing the script (e.g. for testing) will run `main()`.

## Declaring in manifest.yaml

The `preflight:` field in your workflow's `manifest.yaml` is for documentation — it lists which scripts exist:

```yaml
preflight:
  - 01-check-service.py
  - 02-check-capacity.py
```

Discovery is **filesystem-based**: the runner scans the `preflight/` directory for `.py` files. Adding or removing a file is sufficient — you don't need to update `manifest.yaml` for scripts to run. But keeping the manifest in sync is good practice for documentation.

## Related Docs

- [Workflow presets](workflows.md) — How workflows (including preflight) fit into the preset system
- [Custom workflows](custom-workflows.md) — Building complete custom workflows with preflight scripts
- [Presets overview](README.md) — How presets work together
