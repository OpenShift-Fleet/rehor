# Test Fixtures Usage Guide

## Quick Start

```python
from fixtures import TASKS, task, memory, cycle_run


# Use default datasets
def test_with_defaults():
    assert len(TASKS) == 6
    assert TASKS["RHCLOUD-001"]["status"] == "in_progress"


# Create custom payloads
def test_with_custom():
    custom_task = task(99, "TEST-1", "My test task", "in_progress")
    assert custom_task["id"] == 99
    assert custom_task["external_key"] == "TEST-1"
```

## Factory Functions

### `task(id, key, summary, status, **kwargs)`

Create a task payload.

```python
from fixtures import task

# Minimal
t = task(1, "PROJ-1", "Fix bug", "in_progress")

# With optional args
t = task(
    id=1,
    key="PROJ-1",
    summary="Fix login bug",
    status="paused",
    paused_reason="Waiting for review",
    day="15",  # Date suffix (2026-07-15)
    repo="frontend",
    branch="fix/auth",
)
```

**Parameters:**
- `id` (int): Unique task ID
- `key` (str): External key (e.g., JIRA ticket)
- `summary` (str): Task title/summary
- `status` (str): Task status (`in_progress`, `paused`, `pr_open`, `done`, `archived`)
- `paused_reason` (str, optional): Why task is paused
- `day` (str, default="01"): Day of month for timestamps
- `repo` (str, default="test-repo"): Repository name
- `branch` (str, default="main"): Branch name

### `memory(id, category, title, content, **kwargs)`

Create a memory payload.

```python
from fixtures import memory

m = memory(
    id=1,
    category="bug",
    title="Login timeout issue",
    content="Users experiencing timeout after 5min idle",
    repo="frontend",
    external_key="RHCLOUD-001",
    tags=["auth", "timeout"],
    day="10",
)
```

**Parameters:**
- `id` (int): Unique memory ID
- `category` (str): Memory category (`bug`, `architecture`, `decision`, `workaround`)
- `title` (str): Memory title
- `content` (str): Memory content/description
- `repo` (str, default="test-repo"): Repository
- `external_key` (str, optional): Associated ticket key
- `tags` (list[str], optional): Tags
- `day` (str, default="01"): Day for timestamp

### `cycle_run(id, task_id, cycle_type, **kwargs)`

Create a cycle run payload.

```python
from fixtures import cycle_run

run = cycle_run(
    id=1,
    task_id=1,
    cycle_type="implementation",
    instance_id="dev-bot",
    started_day="20",
    duration_min=8,
    has_transcript=True,
)
```

**Parameters:**
- `id` (int): Unique run ID
- `task_id` (int | None): Associated task ID (None for idle cycles)
- `cycle_type` (str): Type (`implementation`, `review`, `idle_check`)
- `instance_id` (str, default="dev-bot"): Bot instance
- `started_day` (str, default="01"): Start day
- `duration_min` (int, default=5): Duration in minutes
- `has_transcript` (bool, default=True): Whether transcript exists

### `cycle_entry(id, label, **kwargs)`

Create a cost entry payload.

```python
from fixtures import cycle_entry

entry = cycle_entry(
    id=1, label="impl-PROJ-1", day="15", cost=0.25, model="claude-opus-4", external_key="PROJ-1", repo="backend"
)
```

**Parameters:**
- `id` (int): Unique entry ID
- `label` (str): Entry label
- `day` (str, default="01"): Day for timestamp
- `cost` (float, default=0.05): Cost in USD
- `model` (str, default="claude-sonnet-4"): Model used
- `is_error` (bool, default=False): Error cycle flag
- `no_work` (bool, default=False): Idle cycle flag
- `external_key` (str, optional): Associated ticket
- `repo` (str, optional): Repository

## Default Datasets

Import and use directly:

```python
from fixtures import TASKS, MEMORIES, CYCLE_RUNS, COSTS, ANALYTICS


def test_defaults():
    # Tasks dict keyed by external_key
    assert "RHCLOUD-001" in TASKS
    assert TASKS["RHCLOUD-001"]["status"] == "in_progress"

    # Memories list
    assert len(MEMORIES) == 4
    assert MEMORIES[0]["category"] == "bug"

    # Analytics summary
    assert ANALYTICS["summary"]["total_cycles"] == 25
```

## Parametrized Tests

```python
import pytest
from fixtures import TASKS


@pytest.mark.parametrize(
    "key,expected_status",
    [
        ("RHCLOUD-001", "in_progress"),
        ("RHCLOUD-002", "pr_open"),
        ("RHCLOUD-003", "paused"),
    ],
)
def test_task_statuses(key, expected_status):
    assert TASKS[key]["status"] == expected_status
```

## Resetting State

Use `conftest.py` fixture for tests that modify datasets:

```python
def test_modify_task(clean_tasks):
    """clean_tasks fixture resets TASKS after test."""
    clean_tasks["RHCLOUD-001"]["status"] = "done"
    # ... test logic
    # TASKS auto-restored to original state after test
```

## Adding New Fixtures

1. **Add factory function** to `fixtures/api_payloads.py`:

```python
def issue(id: int, title: str, status: str) -> dict[str, Any]:
    """Generate issue payload."""
    return {
        "id": id,
        "title": title,
        "status": status,
        "created_at": "2026-07-01T10:00:00Z",
    }


ISSUES = [
    issue(1, "Bug in auth", "open"),
    issue(2, "Feature request", "closed"),
]
```

2. **Export** from `fixtures/__init__.py`:

```python
from .api_payloads import issue, ISSUES

__all__ = [..., "issue", "ISSUES"]
```

3. **Use** in tests and mock server:

```python
from fixtures import ISSUES, issue


def test_issues():
    assert len(ISSUES) == 2
    custom = issue(99, "Custom issue", "open")
```

## Best Practices

✅ **Use factory functions** for custom test data  
✅ **Import default datasets** when possible  
✅ **Keep fixtures focused** - one concept per factory  
✅ **Add type hints** for better IDE support  
✅ **Reset state** with fixtures when mutating data  
✅ **Update both factory and defaults** when changing schemas
