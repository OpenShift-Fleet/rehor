# Bot Workflow Loop

The bot operates as an autonomous loop: a scheduler triggers cycles, lightweight Python scripts gather data and decide whether there's work to do, and only then does a Claude AI session start. This design ensures AI tokens are spent only when there's real work — the common "nothing to do" case costs zero.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  KEDA Cron Scaler (Kubernetes)                        ❌ NOT AI      │
│  Scales the bot pod to 1 during working hours                        │
│                                                                      │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ pod running
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Polling Loop (bot/run.py)                            ❌ NOT AI      │
│  Infinite loop: preflight → session or sleep → repeat                │
│                                                                      │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ each cycle
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Preflight Scripts (Python)                           ❌ NOT AI      │
│  Gather data, check tasks, classify PR states                        │
│  Output: "start" (work found) or "skip" (nothing to do)             │
│  Cost: $0 — runs in ~5-15 seconds                                    │
│                                                                      │
└────────────────┬─────────────────────────┬───────────────────────────┘
                 │                         │
            "start"                     "skip"
                 │                         │
                 ▼                         ▼
┌────────────────────────────┐    ┌────────────────────┐
│                            │    │                    │
│  Claude Code Session       │    │  Sleep             │
│                   ✅ AI    │    │  (no session)      │
│                            │    │  ❌ NOT AI         │
│  Reads CLAUDE.md runbook   │    │                    │
│  + preflight data          │    │  Wait for next     │
│  Uses MCP tools            │    │  cycle             │
│  Writes code, opens PRs    │    │                    │
│  Creates/updates tasks     │    └────────────────────┘
│                            │
└────────────┬───────────────┘
             │ MCP calls
             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Memory Server (FastMCP + PostgreSQL)                 ❌ NOT AI      │
│  Task storage, capacity enforcement, event publishing                │
│                                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐               │
│  │ Tasks DB │  │ SSE Event Bus│  │ REST API         │               │
│  │ (Postgres)│  │ (real-time)  │  │ (dashboard)      │               │
│  └──────────┘  └──────────────┘  └──────────────────┘               │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## The Cycle

Each iteration of the polling loop follows this sequence:

```
1. Sync remote config         (git pull instance config repo)
2. Load instance config        (workflow selection, env presets)
3. Assemble CLAUDE.md          (core + workflow + instance instructions)
4. Run preflight scripts       (Python, sequential, all scripts run)
5. Aggregate results           (any "start" → session; all "skip" → sleep)
6. If "start":
   └─ Launch Claude session    (preflight content injected into prompt)
7. If "skip":
   └─ Record orphan cycle      (logged to dashboard)
   └─ Sleep                    (default ~1 hour, configurable)
8. Cleanup                     (costs, transcripts, cache pruning)
9. Loop back to step 1
```

### When AI Runs vs When It Doesn't

| Scenario | AI runs? | Cost |
|----------|:--------:|------|
| No active tasks, no open bot PRs | No | $0 |
| Active task, PR CI still pending | No | $0 |
| Active task, PR is clean (no issues) | No | $0 |
| Active task, PR CI failed | **Yes** | tokens |
| Active task, PR has review feedback | **Yes** | tokens |
| Active task, PR was merged | **Yes** | tokens |
| No active tasks, new Jira candidate found | **Yes** | tokens |
| All preflight scripts error (API down) | No | $0 (backoff) |

The common case — "nothing changed since last cycle" — is handled entirely by Python scripts. The AI only wakes up when a preflight script explicitly returns `"start"`.

---

## Preflight System

Preflight scripts are Python programs that run before each Claude session. They gather data from external systems (GitHub, GitLab, Jira, memory server), classify it, and decide whether the AI should wake up.

### Output Contract

Every preflight script prints exactly one JSON object to stdout:

```json
{"status": "start", "content": "Work found — details here..."}
```

| Status | Session starts? | Meaning |
|--------|:---------------:|---------|
| `"start"` | **Yes** | Work found. `content` becomes part of the Claude prompt. |
| `"skip"` | No | Nothing to do. `content` is logged for debugging. |
| `"error"` | No | Script failed. Runner generates this automatically on crash/timeout. |

Rules:
- Print JSON to **stdout**. Use **stderr** for debug logging.
- `"start"` requires non-empty `content` — it becomes the AI's input.
- `"skip"` content is optional (logged but not sent to AI).

### Where Scripts Live

Scripts can come from two places, both scanned automatically:

```
presets/workflows/<workflow>/preflight/     ← workflow preflight (runs FIRST)
  01-gh-pr-status.py
  02-gl-mr-status.py
  03-jira-sprint.py

instance/<config>/agent/preflight/          ← instance preflight (runs SECOND)
  04-custom-check.py                        ← you can add more here
```

Workflow scripts run first, then instance scripts. Within each group, scripts are sorted by filename.

### Naming Convention

```
NN-description.py
```

- `NN` — two-digit number controlling execution order (`01`, `02`, etc.)
- `description` — kebab-case summary of what the script checks
- Only `.py` files are discovered; other file types are ignored

### Execution

Each script runs as a subprocess:

```python
subprocess.run(
    ["python3", script_path],
    cwd=bot_repo_root,
    timeout=120,                    # 120 second timeout
    env={...PYTHONPATH...},         # includes shared modules
)
```

The runner sets `PYTHONPATH` to include:
- `presets/shared/preflight/` — shared utility modules
- `.claude/skills/` — skill scripts

### Aggregation Logic

All scripts run to completion before any decision is made. There is no short-circuit — if script 01 returns `"start"`, scripts 02, 03, etc. still run because the AI needs the full picture.

```
Script 01 → "start"   (found CI failure)
Script 02 → "skip"    (no GitLab MRs)
Script 03 → "start"   (found Jira comment)
Script 04 → "error"   (Jenkins API timeout)
                │
                ▼
         _aggregate()
                │
  ┌─────────────┼──────────────────────────────┐
  │  1. Errors excluded from decision          │
  │  2. Any "start" among non-errors? → YES    │
  │  3. Content concatenated into one prompt   │
  │  4. Errors prepended as warnings           │
  └────────────────────────────────────────────┘
                │
                ▼
  Claude receives ONE prompt with ALL data:

    [PREFLIGHT ERROR] 04-custom-check.py: Jenkins API timeout

    ## GH PR Status
    ### CI FAILING (1)
      RHCLOUD-123 PR #42: build-pipeline FAILURE

    ## Jira Sprint
    ### FEEDBACK (1)
      RHCLOUD-456: reviewer comment about test coverage
```

Decision rules:

| Condition | Result |
|-----------|--------|
| Any script returns `"start"` (others skip or error) | Session starts. All content merged. |
| All scripts return `"skip"` | No session. Loop sleeps. |
| All scripts return `"error"` | No session. Exponential backoff (up to 300s). |

One session receives all data — not one session per `"start"`. This lets Claude triage across all data sources.

### Shared Utilities

All preflight scripts can `import common` from `presets/shared/preflight/common.py`:

| Function | Description |
|----------|-------------|
| `output_result(status, content)` | Print the JSON output protocol to stdout |
| `get_tasks()` | Fetch active tasks from the memory server (cached via state file) |
| `get_capacity()` | Returns `(active_count, max_count)` tuple |
| `load_project_repos()` | Load `project-repos.json` from instance config |
| `upstream_repo(repo_name)` | Resolve repo name to `("org/repo", "github"\|"gitlab")` |
| `get_task_prs(task)` | Extract PR info from task metadata |
| `is_bot_author(author)` | Check if a comment author is a known bot |
| `fmt_task_header(task)` | Format common task fields for prompt output |
| `fmt_comments(comments, label, since)` | Format comment list, filtered by timestamp |
| `load_state()` / `save_state(updates)` | Inter-script shared state (see below) |

### Inter-Script State

Scripts within the same preflight run can share data through a state file to avoid redundant API calls:

```python
# Script 01: fetch tasks once
from common import get_tasks, save_state
tasks = get_tasks()              # HTTP call to memory server
save_state({"tasks": tasks})     # writes data/preflight-state.json

# Script 02: reuse cached tasks
from common import load_state
state = load_state()
tasks = state.get("tasks", [])   # no HTTP call
```

The state file is automatically deleted after each preflight run completes. It does not persist across cycles.

### Error Handling

The runner handles all failure modes — scripts don't need to catch these:

| Failure | Runner's response |
|---------|-------------------|
| Non-zero exit code | `ScriptResult(status="error", content=stderr)` |
| Timeout (120s) | `ScriptResult(status="error", content="timed out")` |
| Empty stdout | `ScriptResult(status="error", content="produced no output")` |
| Invalid JSON | `ScriptResult(status="error", content="invalid JSON: ...")` |
| Unknown status value | `ScriptResult(status="error", content="unknown status: ...")` |
| `"start"` with empty content | `ScriptResult(status="error", content="start with empty content")` |

A single script error does **not** block the cycle. If script 01 errors but script 03 returns `"start"`, the session still starts. The error is included in the prompt as a `[PREFLIGHT ERROR]` warning so Claude knows one data source is degraded. Only when **all** scripts error does the cycle fail.

### Preflight Is Read-Only

Preflight scripts only **read** tasks — they never create, update, or archive them:

```
PREFLIGHT (Python, $0)                 AGENT (Claude, $$$)
─────────────────────                  ──────────────────
get_tasks()         READ               task_add()        CREATE
get_capacity()      READ               task_update()     UPDATE
filter by status    READ               task_remove()     ARCHIVE
filter by prefix    READ
```

This separation is intentional: preflights are pure functions over external state. They can never corrupt the task system, even if they crash.

### What a Preflight Script Must Do

Every preflight script should follow this pattern. The order matters — check tasks first, then check for work.

```
Phase 1: Task checks (mandatory)
  ├─ get_tasks()                    fetch all tasks from memory server
  ├─ get_capacity()                 get (active_count, max_count)
  ├─ filter active tasks            status in ("in_progress", "pr_open", "pr_changes")
  ├─ check for duplicate work       does a task with MY prefix already exist?
  │   → YES: output_result("skip")
  ├─ check capacity                 active_count >= max_count?
  │   → YES: output_result("skip")
  └─ proceed to Phase 2

Phase 2: Work discovery (workflow-specific)
  ├─ query external system          GitHub API, Jira, Jenkins, etc.
  ├─ classify results               actionable vs not
  ├─ no work found?
  │   → output_result("skip", "reason")
  └─ work found?
      → output_result("start", "structured data for Claude")
```

#### Phase 1: Task Checks

These three checks prevent the bot from creating duplicate work or exceeding capacity. Every preflight script should include them:

**1. Fetch tasks and capacity:**

```python
from common import get_tasks, get_capacity, output_result

tasks = get_tasks()
active_n, max_n = get_capacity()
active = [t for t in tasks if t.get("status") in ("in_progress", "pr_open", "pr_changes")]
```

**2. Check for duplicate work using `external_key` prefix:**

```python
TASK_KEY_PREFIX = "my-workflow:"    # unique to your workflow

my_tasks = [t for t in active
            if t.get("external_key", "").startswith(TASK_KEY_PREFIX)]
if my_tasks:
    keys = ", ".join(t.get("external_key", "") for t in my_tasks)
    output_result("skip", f"Already in progress: {keys}")
    return
```

The `TASK_KEY_PREFIX` is how a workflow identifies "its" tasks. Each workflow uses a different prefix (see [Task Identity](#task-identity) below).

**3. Check capacity:**

```python
if active_n >= max_n:
    output_result("skip", f"At capacity ({active_n}/{max_n})")
    return
```

Capacity is global — it counts ALL active tasks across all workflows, not just yours.

#### Phase 2: Work Discovery

This is workflow-specific. Query your external system and decide if there's actionable work:

```python
# Example: check for open bot PRs
prs = find_bot_prs(upstream_repo, bot_author)
if len(prs) < 2:
    output_result("skip", f"Only {len(prs)} PRs, need ≥2")
    return

# Include everything the agent needs in the content
output_result("start", json.dumps({
    "repo": upstream_repo,
    "pr_count": len(prs),
    "prs": pr_summary,
    "task_key": f"{TASK_KEY_PREFIX}{upstream_repo}",  # pre-computed for the agent
}))
```

Key points:
- The `content` in `"start"` becomes the AI's input prompt — include all data Claude needs
- Pre-compute the `task_key` so the agent doesn't have to figure out the key format
- Filter out noise (healthy items, resolved issues) — every character costs tokens

#### Complete Skeleton

```python
#!/usr/bin/env python3
"""Preflight: check for work and gate on task state."""

import json
from common import get_tasks, get_capacity, output_result

TASK_KEY_PREFIX = "my-workflow:"

def main():
    # Phase 1: Task checks
    tasks = get_tasks()
    active_n, max_n = get_capacity()
    active = [t for t in tasks if t.get("status") in ("in_progress", "pr_open", "pr_changes")]

    my_tasks = [t for t in active if t.get("external_key", "").startswith(TASK_KEY_PREFIX)]
    if my_tasks:
        output_result("skip", f"Already in progress: {my_tasks[0]['external_key']}")
        return

    if active_n >= max_n:
        output_result("skip", f"At capacity ({active_n}/{max_n})")
        return

    # Phase 2: Work discovery (replace with your logic)
    work = find_work()
    if not work:
        output_result("skip", "No work found")
        return

    output_result("start", json.dumps({
        "items": work,
        "task_key": f"{TASK_KEY_PREFIX}{work[0]['scope']}",
    }))

if __name__ == "__main__":
    main()
```

### Preflight-to-Agent Data Handoff

The `content` field from `output_result("start", content)` is the **only data channel** between the preflight and the agent. The framework injects it into the Claude prompt like this:

```
## Pre-flight Data

The following data was gathered by pre-flight scripts.
Do NOT re-fetch task statuses, PR statuses, or Jira comments already shown below.

{content from all "start" scripts, concatenated}
```

Include everything the agent needs to act:
- **What to work on** — repo name, PR numbers, Jira keys
- **Pre-computed task key** — so the agent uses the correct `external_key` format
- **Classification results** — MERGED/CI FAIL/FEEDBACK buckets (already triaged)
- **Context** — comments, error messages, CI pipeline URLs

The CLAUDE.md runbook then tells the agent how to interpret this data and what actions to take.

---

## Task State Machine

Tasks are the coordination primitive between cycles. They track what the bot is working on, prevent duplicate work, and manage capacity.

### The 6 States

Defined as a PostgreSQL enum in `memory-server/bot_memory_server/schema.sql`:

```sql
CREATE TYPE task_status AS ENUM (
    'in_progress', 'pr_open', 'pr_changes', 'paused', 'done', 'archived'
);
```

| Status | Blocks new work? | Who sets it | Meaning |
|--------|:----------------:|-------------|---------|
| `in_progress` | **Yes** | Agent (`task_add`) | Agent is actively working (coding, testing) |
| `pr_open` | **Yes** | Agent (`task_update`) | PR created, waiting for CI and/or review |
| `pr_changes` | **Yes** | Agent (`task_update`) | Reviewer requested changes, agent addressing them |
| `paused` | No | Agent (`task_update`) | Work intentionally paused (blocked on question). Has `paused_reason`. |
| `done` | No | Agent (`task_update`) | Work completed — PR merged, cleanup finished |
| `archived` | No | Agent (`task_remove`) | Soft-deleted — excluded from all queries by default |

### Active Statuses

The three states that block new work are defined in `memory-server/bot_memory_server/tools/tasks.py`:

```python
ACTIVE_STATUSES = ("in_progress", "pr_open", "pr_changes")
```

Preflight scripts use this to:
1. **Prevent duplicate work** — skip if a task with a matching `external_key` prefix is active
2. **Enforce capacity** — skip if active task count ≥ `MAX_ACTIVE` (default 10)

### State Diagram

```
                         ┌──────────────────────┐
                         │      NO TASK          │
                         │  (nothing in DB)      │
                         └──────────┬─────────────┘
                                    │
                          task_add(status="in_progress")
                          or task_add(status="pr_open")
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
                    ▼                               ▼
         ┌──────────────────┐            ┌──────────────────┐
         │   in_progress     │            │    pr_open        │
         │  coding/testing   │───────────▶│  waiting for      │
         │                   │ push PR    │  CI / review      │
         └──────────────────┘            └──┬────┬──────┬───┘
                    ▲                        │    │      │
                    │               CI fix   │    │      │ reviewer
                    │               pushed   │    │      │ requests
                    │                        │    │      │ changes
                    │                        │    │      │
                    │                        │    │      ▼
                    │                        │    │   ┌──────────────────┐
                    │                        │    │   │   pr_changes      │
                    │                        │    │   │  addressing       │
                    │                        │    │   │  review feedback  │──┐
                    │                        │    │   └──────────────────┘  │
                    │                        │    │     agent pushes fix,   │
                    │                        │    │     status → pr_open    │
                    │                        │    │           ▲             │
                    │                        │    │           └─────────────┘
                    │                        │    │
                    │                   ┌────┘    └────┐
                    │                   │              │
                    │              CI passes      CI fails /
                    │              PR merged      can't fix
                    │                   │              │
                    │                   ▼              ▼
                    │            close originals   delete branch
                    │            link to PR        keep originals
                    │                   │              │
                    │                   ▼              ▼
                    │            ┌──────────────────────────┐
                    │            │          done             │
                    │            │  work finished            │
                    │            └──────────┬───────────────┘
                    │                       │
                    │                  task_remove()
                    │                       │
                    │                       ▼
                    │            ┌──────────────────────────┐
                    │            │        archived           │
                    │            │  soft-deleted from queries │
                    │            └──────────────────────────┘
                    │
                    │            ┌──────────────────────────┐
                    └────────────│        paused             │
                     unblock     │  (escape hatch)           │
                                 │  blocked on question      │
                                 │  doesn't count as active  │
                                 └──────────────────────────┘
```

### State Transitions

| # | From | To | Who | When |
|---|------|-----|-----|------|
| 1 | *(none)* | `in_progress` | Agent via `task_add` | Agent claims a Jira ticket and starts coding |
| 2 | *(none)* | `pr_open` | Agent via `task_add` | Agent creates task after pushing PR (e.g. consolidation workflows) |
| 3 | `in_progress` | `pr_open` | Agent via `task_update` | Agent pushes code and opens a PR |
| 4 | `pr_open` | `pr_open` | Agent via `task_update` | Pushed a CI fix, still waiting |
| 5 | `pr_open` | `pr_changes` | Agent via `task_update` | Addressed reviewer feedback |
| 6 | `pr_changes` | `pr_open` | Agent via `task_update` | Pushed review fix, waiting for re-review |
| 7 | `pr_open` | `done` | Agent via `task_update` | CI passed and PR merged, cleanup complete |
| 8 | `pr_open` | `done` | Agent via `task_update` | CI failed, can't fix, branch deleted |
| 9 | any active | `paused` | Agent via `task_update` | Blocked on external question |
| 10 | `paused` | `in_progress` | Agent via `task_update` | Unblocked, resuming work |
| 11 | `done` | `archived` | Agent via `task_remove` | Cleanup, hide from default queries |

### Task Identity

Each task is uniquely identified by `(external_key, source_type)`:

```sql
UNIQUE(external_key, source_type)
```

#### The `external_key` Convention

The `external_key` follows the pattern: `<workflow-name>:<scope>`

| Part | Purpose | Example |
|------|---------|---------|
| `workflow-name` | Namespace that groups all tasks from one workflow | `konflux-pr-squash` |
| `:` | Separator | — |
| `scope` | What specifically is being worked on | `project-kessel/insights-rbac` |

Full examples:

| Workflow | `external_key` | `source_type` |
|----------|----------------|---------------|
| Jira-driven | `RHCLOUD-12345` | `jira` |
| Konflux PR squash | `konflux-pr-squash:project-kessel/insights-rbac` | `github` |
| Custom CI fixer | `ci-fix:org/repo#42` | `github` |

The `workflow-name` prefix is what preflight scripts use to find "their" tasks (see [Phase 1: Task Checks](#phase-1-task-checks) above). It must be:
- **Unique per workflow** — two different workflows must not share a prefix
- **Deterministic** — the same work must always produce the same key
- **Stable** — if the bot wakes up and checks, the key shouldn't have changed

#### The `source_type` Field

The `source_type` defaults to `"jira"`. Non-Jira workflows **must set it explicitly** — getting it wrong means lookups and duplicate-prevention checks will fail silently, because `task_get` and `task_update` look up by `(external_key, source_type)`.

Common values: `"jira"`, `"github"`, `"gitlab"`, `"scheduled"`.

#### How Task Keys Flow Through the System

The task key is defined in three places — and they must agree:

```
┌─────────────────────┐     ┌───────────────────────┐     ┌──────────────────┐
│  Preflight script   │     │  CLAUDE.md runbook     │     │  Agent (Claude)  │
│                     │     │                        │     │                  │
│  TASK_KEY_PREFIX =  │     │  "Use this format:     │     │  task_add(       │
│  "my-workflow:"     │     │   my-workflow:<repo>"  │     │    external_key= │
│                     │     │                        │     │    "my-workflow:  │
│  Pre-computes:      │────▶│  Defines the key       │────▶│     org/repo",  │
│  task_key in output │     │  format as prose        │     │    source_type=  │
│                     │     │  instructions           │     │    "github"     │
└─────────────────────┘     └───────────────────────┘     └──────────────────┘
     (Python code)              (Prose for AI)              (MCP tool call)
```

1. **Preflight defines the prefix** — in Python code, used for duplicate checking
2. **Preflight pre-computes the full key** — includes it in the `"start"` content so the agent doesn't have to guess
3. **CLAUDE.md documents the key format** — as prose instructions for the AI agent
4. **Agent uses the key** — in `task_add` and `task_update` MCP calls

Example from a real CLAUDE.md runbook:

```markdown
## Task Tracking

When you start working on a repository, create a task:
- external_key: `konflux-pr-squash:<org>/<repo>` (e.g. `konflux-pr-squash:project-kessel/insights-rbac`)
- source_type: `github`
- status: starts as `in_progress`, move to `pr_open` when PR is created
```

And the corresponding preflight outputs:

```json
{
  "repo": "project-kessel/insights-rbac",
  "task_key": "konflux-pr-squash:project-kessel/insights-rbac",
  "prs": [...]
}
```

The agent reads the pre-computed `task_key` from the preflight data and uses it directly in `task_add`.

### MCP Tools

The agent interacts with tasks through MCP tools exposed by the `bot-memory` server:

| Tool | Purpose | Key behavior |
|------|---------|-------------|
| `task_add` | Create a new task | **Refuses if ≥10 active tasks.** Publishes `task_added` event. |
| `task_update` | Change status, summary, metadata | Lookup by `external_key` + `source_type`. Metadata is merged (not replaced). Publishes `task_updated` event. |
| `task_get` | Fetch one task | Lookup by `external_key` + `source_type`. |
| `task_list` | List all tasks | Filters by status, instance_id. Excludes `archived` by default. |
| `task_remove` | Archive a task | Sets status to `archived` (soft delete, preserves history). Publishes `task_archived` event. |
| `task_check_capacity` | Check if bot can take more work | Returns `{active: N, max: 10, has_capacity: bool}`. |
| `bot_status_update` | Update bot's current activity | States: `working`, `idle`, `error`. Shown on dashboard. |

### Who Reads vs Who Writes

```
                    ┌────────────────┐
                    │  PostgreSQL    │
                    │  tasks table   │
                    └───┬───┬───┬───┘
                        │   │   │
         ┌──────────────┘   │   └──────────────┐
         │                  │                  │
         ▼                  ▼                  ▼
  Preflight scripts    Claude agent       Dashboard
  (Python, no AI)      (MCP tools)        (REST API)

  get_tasks()          task_list()        GET /api/tasks
  get_capacity()       task_get()
                       task_add()         SSE /api/events
  READ ONLY            task_update()      (real-time)
                       task_remove()
                       READ + WRITE       READ ONLY
```

---

## Complete Workflow Example

This traces a full lifecycle through multiple scheduler ticks, showing every task state transition.

### Tick 1 — First Run, No Task Exists

```
SCHEDULER
    │
    ▼
PREFLIGHT: 01-check-bot-prs.py
    ├─ get_tasks() → []                           no tasks exist
    ├─ get_capacity() → (0, 10)                   0 active, 10 max
    ├─ filter by prefix → []                      no blocker
    ├─ gh pr list --author red-hat-konflux[bot]
    ├─ found 4 open bot PRs (≥2 required)
    └─ output_result("start", {repo, prs, ...})
                                                   ┌─────────────┐
    ▼                                              │  NO TASK     │
                                                   └─────────────┘
CLAUDE SESSION starts
    ├─ Reads CLAUDE.md runbook + preflight data
    ├─ Runs consolidation script
    │   ├─ Groups PRs by ecosystem (Go: 3, Python: 1)
    │   ├─ Skips Python (only 1 PR)
    │   ├─ Processes Go: go get × 3, go mod tidy
    │   ├─ Pushes branch, creates PR #55
    │   └─ Resolves any conflicts
    │
    ├─ Creates task via MCP:
    │   task_add(
    │     external_key = "konflux-pr-squash:org/repo",
    │     source_type  = "github",
    │     status       = "pr_open",
    │     metadata     = {prs: [{number: 55, host: "github"}], ...}
    │   )
    │                                              ┌─────────────┐
    │   Memory server:                             │   pr_open    │
    │     ✓ active count (0) < max (10)            │              │
    │     ✓ INSERT INTO tasks                      │  waiting for │
    │     ✓ publish "task_added" event             │  CI pipeline │
    │       → dashboard updates                    └─────────────┘
    │       → Slack notified
    │
    └─ Session ends.
```

### Tick 2 — CI Still Running

```
PREFLIGHT: 01-check-bot-prs.py
    ├─ get_tasks() → [{status: "pr_open", external_key: "konflux-pr-squash:..."}]
    ├─ filter by prefix → FOUND active task
    └─ output_result("skip", "Already in progress")

PREFLIGHT: gh_pr_status.py                        ┌─────────────┐
    ├─ gh pr view #55 → CI: PENDING               │   pr_open    │
    ├─ classify → CLEAN                            │  (unchanged) │
    └─ output_result("skip", "all clean")          └─────────────┘

No Claude session. Zero tokens.
```

### Tick 3 — CI Passed, PR Merged

```
PREFLIGHT: gh_pr_status.py
    ├─ gh pr view #55 → state: MERGED
    ├─ classify → MERGED
    └─ output_result("start", "MERGED: PR #55")

CLAUDE SESSION starts                              ┌─────────────┐
    ├─ Sees: "PR #55 is MERGED"                    │   pr_open    │
    ├─ Closes original bot PRs:                    └──────┬──────┘
    │   gh pr comment 101 "Consolidated into #55"         │
    │   gh pr close 101                                   │
    │   gh pr close 102                                   │
    │   gh pr close 103                                   │
    │                                                     │
    ├─ Updates task:                                      │
    │   task_update(                                      │
    │     external_key = "konflux-pr-squash:org/repo",    │
    │     source_type  = "github",                        │
    │     status       = "done",                          │
    │     summary      = "3 PRs consolidated, merged"     │
    │   )                                                 │
    │                                              ┌──────▼──────┐
    │                                              │    done      │
    │                                              │ lock released│
    └─ Session ends.                               └─────────────┘
```

### Tick 4 — Loop Is Free Again

```
PREFLIGHT: 01-check-bot-prs.py
    ├─ get_tasks() → [{status: "done"}]            "done" is NOT active
    ├─ filter by prefix → []                       no blocker
    ├─ gh pr list → 0 open bot PRs
    └─ output_result("skip", "0 PRs, need ≥2")

No Claude session. Waiting for new bot PRs.
```

### Alternative Path: CI Fails

```
PREFLIGHT: gh_pr_status.py
    ├─ gh pr view #55 → CI: FAILURE
    └─ output_result("start", "CI FAILING: build-pipeline")

CLAUDE SESSION                                     ┌─────────────┐
    ├─ Reads CI failure details                    │   pr_open    │
    │                                              └──────┬──────┘
    ├─ Can fix? Try go mod tidy -e, push fix              │
    │   → task_update(status="pr_open", ...)              │
    │     stays pr_open, next tick re-checks CI           │
    │                                              ┌──────▼──────┐
    │                                              │   pr_open    │
    │                                              └─────────────┘
    │
    └─ Cannot fix?
        ├─ git push origin --delete <branch>
        ├─ gh pr close #55
        ├─ Do NOT close originals (they're fallbacks)
        ├─ task_update(status="done",
        │    summary="CI failed, branch deleted")
        │                                          ┌─────────────┐
        └─ Session ends.                           │    done      │
                                                   │ originals    │
                                                   │ still open   │
                                                   └─────────────┘
```

### Alternative Path: Review Feedback

```
PREFLIGHT: gh_pr_status.py
    ├─ gh pr view #55 → reviewDecision: CHANGES_REQUESTED
    └─ output_result("start", "FEEDBACK: review:jdoe")

CLAUDE SESSION                                     ┌─────────────┐
    ├─ Reads review comments                       │   pr_open    │
    ├─ Addresses feedback, pushes fix              └──────┬──────┘
    │                                                     │
    ├─ task_update(                                       │
    │    status = "pr_changes",                           │
    │    last_addressed = "2026-07-23T14:30:00Z"          │
    │  )                                                  │
    │                                              ┌──────▼──────┐
    └─ Session ends.                               │ pr_changes   │
                                                   │ still blocks │
                                                   │ new runs     │
                                                   └─────────────┘

Next tick: gh_pr_status.py checks again.
  → CI passes + approved → MERGED path → done
  → More feedback → FEEDBACK path repeats
```

---

## Built-In Preflight Scripts

The `jira-sprint` workflow includes three preflight scripts:

| Script | What it checks | Returns "start" when |
|--------|---------------|---------------------|
| `01-gh-pr-status.py` | GitHub PR states (CI, reviews, conflicts, merges) | Any PR is merged, has CI failure, has conflicts, or has new review feedback |
| `02-gl-mr-status.py` | GitLab MR states (pipelines, threads) | Same as above but for GitLab |
| `03-jira-sprint.py` | Jira sprint for comments and new work candidates | Active task has new Jira comments, or new unassigned ticket found |

### GitHub PR Classification Buckets

`gh_pr_status.py` classifies each PR into one of these buckets:

| Bucket | Condition | Actionable? |
|--------|-----------|:-----------:|
| MERGED | PR state is `MERGED` | **Yes** — agent wraps up |
| CLOSED | PR state is `CLOSED` | **Yes** — agent handles closure |
| CI FAILING | `statusCheckRollup` has `FAILURE` conclusions | **Yes** — agent investigates |
| CONFLICTS | `mergeable` is `CONFLICTING` | **Yes** — agent rebases |
| FEEDBACK | `reviewDecision` is `CHANGES_REQUESTED`, or new review comments from humans | **Yes** — agent addresses |
| CLEAN | No issues found | No |

The `last_addressed` timestamp on each task is used to filter out old feedback. Reviews submitted before `last_addressed` are ignored — the bot already handled them in a prior cycle.

---

## Related Docs

- [Workflow Presets](presets/workflows.md) — Available workflows and their decision loops
- [Writing Custom Preflight Scripts](presets/custom-preflight.md) — How to write your own preflight scripts
- [Creating Custom Workflows](presets/custom-workflows.md) — Building complete custom workflows
- [Scheduling](scheduling.md) — KEDA cron scaling configuration
