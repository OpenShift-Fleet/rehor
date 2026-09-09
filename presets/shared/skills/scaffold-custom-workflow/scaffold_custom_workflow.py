#!/usr/bin/env python3
"""Scaffold a custom workflow directory with manifest, CLAUDE.md, and preflight skeleton."""

import argparse
import re
import sys
from pathlib import Path

KEBAB_RE = re.compile(r"^[a-z][a-z0-9]+(-[a-z0-9]+)*$")


def validate_name(name: str) -> str:
    if not KEBAB_RE.match(name):
        raise argparse.ArgumentTypeError(
            f"'{name}' is not valid kebab-case (lowercase letters, digits, hyphens; "
            f"must start with a letter, no leading/trailing/double hyphens)"
        )
    return name


def parse_csv(value: str) -> list[str]:
    if not value:
        return []
    return [v.strip() for v in value.split(",") if v.strip()]


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Scaffold a custom workflow directory.")
    p.add_argument("--name", required=True, type=validate_name, help="Workflow name (kebab-case)")
    p.add_argument("--description", required=True, help="One-line workflow description")
    p.add_argument("--trigger", required=True, choices=["jira", "scheduled"], help="Trigger type")
    p.add_argument("--output-dir", required=True, help="Instance agent directory")
    p.add_argument("--mcp-servers", default="", help="Comma-separated MCP servers")
    p.add_argument("--env-vars", default="", help="Comma-separated env vars")
    p.add_argument("--shared-skills", default="", help="Comma-separated shared skill names")
    p.add_argument("--dry-run", action="store_true", help="Show plan without writing files")
    return p.parse_args(argv)


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------


def render_manifest(cfg: dict) -> str:
    lines = [
        f"name: {cfg['name']}",
        "type: workflow",
        f"description: {cfg['description']}",
        "",
        "preflight:",
        "  - 01-check.py",
    ]

    shared = cfg.get("shared_skills", [])
    if shared:
        lines.append("")
        lines.append("shared_skills:")
        for s in shared:
            lines.append(f"  - {s}")

    lines.append("")
    lines.append("provides:")
    lines.append("  claude_md: CLAUDE.md")

    mcp = cfg.get("mcp_servers", [])
    env = cfg.get("env_vars", [])
    if mcp or env:
        lines.append("")
        lines.append("requires:")
        if mcp:
            lines.append("  mcp_servers:")
            for m in mcp:
                lines.append(f"    - {m}")
        if env:
            lines.append("  env_vars:")
            for e in env:
                lines.append(f"    - {e}")

    lines.append("")
    return "\n".join(lines)


def render_claude_md_jira(cfg: dict) -> str:
    name = cfg["name"]
    description = cfg["description"]
    return f"""\
# {name.replace("-", " ").title()} Workflow

{description}

## Decision Loop

Each cycle, the preflight script pre-fetches data at zero token cost.
You only run when there is actionable work.

### Step 1 — Read preflight data

The preflight script already checked Jira and task state. The data is in
your prompt as JSON. Do NOT re-query Jira for this information.

### Step 2 — Evaluate the work item

Read the preflight content. Decide whether to act or skip.

### Step 3 — Take action

Implement the required change. Use the tools available to you.

### Step 4 — Update task tracking

Use MCP task tools (`task_add`, `task_update`, `task_get`) to track progress.
Always pass `source_type="jira"` for Jira-driven workflows.

Never call the memory server HTTP API directly — use the MCP tools, which
enforce capacity caps, publish events, and build artifact links.

### Step 5 — Report results

Post a Jira comment summarizing what was done. If a PR was created, use
the `/post-pr` skill to handle labels, transitions, and notifications.

## Rules

- ONE task per cycle — finish or pause before picking the next
- Read preflight data first — it was fetched at zero token cost
- Track work via MCP task tools, not raw HTTP
- Be idempotent — safe to re-run if a cycle is interrupted
"""


def render_claude_md_scheduled(cfg: dict) -> str:
    name = cfg["name"]
    description = cfg["description"]
    return f"""\
# {name.replace("-", " ").title()} Workflow

{description}

## Decision Loop

Each cycle, the preflight script pre-fetches data at zero token cost.
You only run when there is actionable work — if everything is healthy,
the preflight returns `skip` and no AI session starts (zero tokens).

### Step 1 — Read pre-fetched data

The preflight script already fetched, filtered, and classified the data.
It is in your prompt as JSON. Do NOT re-fetch this data.

### Step 2 — Classify and prioritize

Review the items in the preflight data. Determine which need action.

### Step 3 — Take action

Process actionable items. Use the tools available to you.

### Step 4 — Update task tracking

Use MCP task tools (`task_add`, `task_update`, `task_get`, `task_remove`)
to track work items. Always pass `source_type="scheduled"` for scheduled
workflows — the default is `"jira"` which will break task lookups.

Never call the memory server HTTP API directly — use the MCP tools.

### Step 5 — Signal sleep and end cycle

Write the sleep signal so the runner waits before the next cycle:

```bash
mkdir -p data && echo '{{"recommended_sleep": 3600, "reason": "{name} hourly cycle"}}' > data/cycle-sleep.json
```

Do NOT loop back — one pass per cycle.

## Rules

- One pass per cycle — do not loop
- Read preflight data first — it was fetched at zero token cost
- Track work via MCP task tools, not raw HTTP
- Pass `source_type="scheduled"` in all task calls
- If the preflight already handled reporting (zero-token compact message),
  you should NOT duplicate that report
"""


def render_preflight_jira(cfg: dict) -> str:
    name = cfg["name"]
    return f'''\
#!/usr/bin/env python3
"""Pre-flight: check for actionable work in Jira.

Runs before each AI session. Returns JSON to stdout:
  {{"status": "start", "content": "..."}}  — actionable work found, start session
  {{"status": "skip",  "content": "..."}}  — nothing to do, skip session (zero tokens)

Token-saving pattern:
  This script runs at ZERO token cost. Do all data fetching here so the
  AI session only starts when there is a decision to make. Pre-fetch and
  include all relevant data in the "content" field — the AI reads it from
  its prompt instead of making its own API calls.
"""

import json
import sys

# These imports resolve at runtime when PYTHONPATH includes presets/shared/preflight/
from common import get_capacity, get_tasks, output_result

TASK_KEY_PREFIX = "{name}:"


def main():
    tasks = get_tasks()
    active = [t for t in tasks if t.get("status") in ("in_progress", "pr_open", "pr_changes")]

    # Already working on something for this workflow?
    my_tasks = [t for t in active if t.get("external_key", "").startswith(TASK_KEY_PREFIX)]
    if my_tasks:
        output_result("skip", f"Already in progress: {{my_tasks[0][\'external_key\']}}")
        return

    # Respect capacity — don\'t overload the bot
    active_n, max_n = get_capacity()
    if active_n >= max_n:
        output_result("skip", f"At capacity ({{active_n}}/{{max_n}})")
        return

    # TODO: Add your data-fetching logic here
    # Example: query Jira for tickets matching your workflow\'s criteria,
    # check an external API, scan a repo for issues, etc.
    #
    # Key principle: fetch ALL data the AI will need and include it in
    # the "content" field. This avoids the AI making its own API calls
    # during the session, saving tokens.
    actionable_items = []  # Replace with your logic

    if not actionable_items:
        output_result("skip", f"No actionable items found ({{len(tasks)}} tasks checked)")
        return

    content = f"{{len(actionable_items)}} items need attention:\\n"
    content += json.dumps(actionable_items, indent=2)
    output_result("start", content)


if __name__ == "__main__":
    main()
'''


def render_preflight_scheduled(cfg: dict) -> str:
    name = cfg["name"]
    return f'''\
#!/usr/bin/env python3
"""Pre-flight: check external service for actionable items.

Runs before each AI session. Returns JSON to stdout:
  {{"status": "start", "content": "..."}}  — actionable work found, start session
  {{"status": "skip",  "content": "..."}}  — nothing to do, skip session (zero tokens)

Token-saving pattern:
  This script runs at ZERO token cost. Do all data fetching, filtering,
  and classification here. The AI session only starts when there is a
  NEW decision to make (not just a status update).

  Include pre-fetched data in the "content" field so the AI reads it from
  its prompt instead of making its own API calls.

Throttle pattern:
  For expensive checks, use a state file to throttle how often this runs.
  Example: check every 8 hours instead of every cycle.
"""

import json
import os
import sys
import time
from pathlib import Path

THROTTLE_HOURS = 1
STATE_FILE = Path(os.environ.get("BOT_DATA_DIR", "data")) / "{name}-last-run.json"


def is_throttled():
    """Skip if last run was too recent."""
    if not STATE_FILE.exists():
        return False
    try:
        state = json.loads(STATE_FILE.read_text())
        last_run = state.get("last_run", 0)
        return (time.time() - last_run) < (THROTTLE_HOURS * 3600)
    except (json.JSONDecodeError, OSError):
        return False


def save_run_time():
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps({{"last_run": time.time()}}))


def fetch_data():
    """Fetch data from your external service.

    Replace this with your actual data source — API call, CLI command,
    file read, database query, etc.

    Returns parsed data or None on error.
    """
    # TODO: implement your data fetching
    # Example patterns:
    #   subprocess.run(["curl", ...], capture_output=True)
    #   urllib.request.urlopen(url)
    #   subprocess.run(["gh", "api", ...], capture_output=True)
    return None


def classify(data):
    """Classify fetched data into actionable vs ignorable.

    Do deterministic filtering here (no AI needed). Only items that
    require AI judgment should cause a "start" result.

    Returns (actionable_items, summary_stats).
    """
    # TODO: implement your classification logic
    actionable = []
    stats = {{"total": 0, "actionable": 0, "healthy": 0}}
    return actionable, stats


def main():
    if is_throttled():
        msg = f"{name} check throttled (last run < {{THROTTLE_HOURS}}h ago)"
        print(json.dumps({{"status": "skip", "content": msg}}))
        return

    data = fetch_data()
    save_run_time()

    if data is None:
        print(json.dumps({{"status": "skip", "content": "Could not fetch data from service"}}))
        return

    actionable, stats = classify(data)

    if not actionable:
        print(json.dumps({{
            "status": "skip",
            "content": f"All healthy — {{stats[\'total\']}} items checked, none actionable",
        }}))
        return

    # Build content with ALL data the AI will need
    header = f"{{len(actionable)}} items need attention ({{stats[\'total\']}} total checked)\\n"
    output = {{
        "actionable": actionable,
        "stats": stats,
    }}

    print(json.dumps({{
        "status": "start",
        "content": header + json.dumps(output, indent=2),
    }}))


if __name__ == "__main__":
    main()
'''


# ---------------------------------------------------------------------------
# File writing
# ---------------------------------------------------------------------------


def scaffold(cfg: dict, dry_run: bool = False) -> list[dict]:
    """Generate workflow files. Returns list of {path, status, content} dicts."""
    output_dir = Path(cfg["output_dir"])
    workflow_dir = output_dir / "workflows" / cfg["name"]

    if workflow_dir.exists() and not dry_run:
        print(f"[FAIL] Directory already exists: {workflow_dir}", file=sys.stderr)
        sys.exit(1)

    if cfg["trigger"] == "jira":
        claude_md = render_claude_md_jira(cfg)
        preflight = render_preflight_jira(cfg)
    else:
        claude_md = render_claude_md_scheduled(cfg)
        preflight = render_preflight_scheduled(cfg)

    manifest = render_manifest(cfg)

    files = [
        {"path": workflow_dir / "manifest.yaml", "content": manifest},
        {"path": workflow_dir / "CLAUDE.md", "content": claude_md},
        {"path": workflow_dir / "preflight" / "01-check.py", "content": preflight},
    ]

    results = []
    for f in files:
        rel = f["path"].relative_to(output_dir)
        if dry_run:
            results.append({"path": str(rel), "status": "dry-run", "content": f["content"]})
            print(f"[DRY-RUN] {rel}")
        else:
            f["path"].parent.mkdir(parents=True, exist_ok=True)
            f["path"].write_text(f["content"])
            results.append({"path": str(rel), "status": "ok", "content": f["content"]})
            print(f"[OK] {rel}")

    return results


def main(argv=None):
    args = parse_args(argv)
    cfg = {
        "name": args.name,
        "description": args.description,
        "trigger": args.trigger,
        "output_dir": args.output_dir,
        "mcp_servers": parse_csv(args.mcp_servers),
        "env_vars": parse_csv(args.env_vars),
        "shared_skills": parse_csv(args.shared_skills),
    }
    scaffold(cfg, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
