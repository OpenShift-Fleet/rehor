"""Shared API payload fixtures for mock server and tests."""

from typing import Any, Dict, List, Optional


def task(
    id: int,
    key: str,
    summary: str,
    status: str,
    paused_reason: Optional[str] = None,
    day: str = "01",
    repo: str = "test-repo",
    branch: str = "main",
) -> Dict[str, Any]:
    """Generate task payload."""
    return {
        "id": id,
        "external_key": key,
        "source_type": "jira",
        "source_url": f"https://issues.redhat.com/browse/{key}",
        "artifacts": [
            {"name": "PR #123", "url": f"https://github.com/example/{repo}/pull/123", "type": "pr"},
            {"name": "Branch", "url": f"https://github.com/example/{repo}/tree/{branch}", "type": "branch"},
        ],
        "status": status,
        "repo": repo,
        "branch": branch,
        "title": summary,
        "summary": summary,
        "created_at": f"2026-07-{day}T10:00:00Z",
        "last_addressed": f"2026-07-{day}T15:30:00Z" if status in {"in_progress", "pr_open"} else None,
        "paused_reason": paused_reason,
        "instance_id": "dev-bot",
        "metadata": {"priority": "high", "labels": ["bug", "p1"]},
        "slack_notification": {
            "event_type": "task_started",
            "message": f"Started work on {key}",
            "sent_at": f"2026-07-{day}T10:05:00Z",
        }
        if status == "in_progress"
        else None,
    }


def memory(
    id: int,
    category: str,
    title: str,
    content: str,
    repo: str = "test-repo",
    external_key: Optional[str] = None,
    tags: Optional[List[str]] = None,
    day: str = "01",
) -> Dict[str, Any]:
    """Generate memory payload."""
    return {
        "id": id,
        "category": category,
        "repo": repo,
        "external_key": external_key,
        "source_type": "jira" if external_key else None,
        "title": title,
        "content": content,
        "tags": tags or [],
        "created_at": f"2026-07-{day}T10:00:00Z",
        "metadata": {"importance": "high"},
    }


def cycle_run(
    id: int,
    task_id: Optional[int],
    cycle_type: str,
    instance_id: str = "dev-bot",
    started_day: str = "01",
    duration_min: int = 5,
    has_transcript: bool = True,
) -> Dict[str, Any]:
    """Generate cycle run payload."""
    start = f"2026-07-{started_day}T10:00:00Z"
    end = f"2026-07-{started_day}T10:{duration_min:02d}:00Z"
    return {
        "id": id,
        "task_id": task_id,
        "cycle_type": cycle_type,
        "instance_id": instance_id,
        "started_at": start,
        "finished_at": end,
        "tool_calls": 12,
        "tokens_used": 15000,
        "progress": {"phase": "implementation", "completed_steps": 3, "total_steps": 5},
        "input_prompt": "Implement the login bug fix for RHCLOUD-001",
        "created_at": start,
        "has_transcript": has_transcript,
    }


def cycle_entry(
    id: int,
    label: str,
    day: str = "01",
    cost: float = 0.05,
    model: str = "claude-sonnet-4",
    is_error: bool = False,
    no_work: bool = False,
    external_key: Optional[str] = None,
    repo: Optional[str] = None,
) -> Dict[str, Any]:
    """Generate cycle entry (costs) payload."""
    return {
        "id": id,
        "timestamp": f"2026-07-{day}T10:00:00Z",
        "label": label,
        "session_id": f"session-{id}",
        "num_turns": 8,
        "duration_ms": 300000,
        "cost_usd": cost,
        "input_tokens": 10000,
        "output_tokens": 5000,
        "cache_read_tokens": 2000,
        "cache_write_tokens": 1000,
        "model": model,
        "is_error": is_error,
        "no_work": no_work,
        "external_key": external_key,
        "source_type": "jira" if external_key else None,
        "repo": repo,
        "work_type": "implementation" if not no_work else None,
        "summary": f"Completed work on {external_key}" if external_key else "Idle cycle",
    }


# Default datasets
TASKS = {
    "RHCLOUD-001": task(1, "RHCLOUD-001", "Fix login bug", "in_progress", day="01", repo="frontend"),
    "RHCLOUD-002": task(2, "RHCLOUD-002", "Add dark mode", "pr_open", day="02", repo="ui-lib"),
    "RHCLOUD-003": task(
        3,
        "RHCLOUD-003",
        "Refactor auth middleware",
        "paused",
        paused_reason="Waiting for design review",
        day="03",
        repo="backend",
    ),
    "RHCLOUD-004": task(4, "RHCLOUD-004", "Update dependencies", "in_progress", day="04", repo="frontend"),
    "RHCLOUD-005": task(5, "RHCLOUD-005", "Optimize database queries", "done", day="05", repo="backend"),
    "RHCLOUD-006": task(6, "RHCLOUD-006", "Fix memory leak", "archived", day="06", repo="worker"),
}

MEMORIES = [
    memory(
        1,
        "bug",
        "Login timeout issue",
        "Users experiencing timeout after 5min idle",
        repo="frontend",
        external_key="RHCLOUD-001",
        tags=["auth", "timeout"],
        day="01",
    ),
    memory(
        2,
        "architecture",
        "Auth flow design",
        "New OAuth2 flow with PKCE extension",
        repo="backend",
        tags=["security", "oauth"],
        day="02",
    ),
    memory(
        3,
        "decision",
        "Framework choice",
        "Chose React over Vue for better TypeScript support",
        repo="frontend",
        tags=["react", "typescript"],
        day="03",
    ),
    memory(
        4,
        "workaround",
        "Database connection pooling",
        "Increased pool size to 50 to handle load spikes",
        repo="backend",
        tags=["database", "performance"],
        day="04",
    ),
]

CYCLE_RUNS = [
    cycle_run(1, 1, "implementation", started_day="01", duration_min=5),
    cycle_run(2, 1, "review", started_day="01", duration_min=3),
    cycle_run(3, 2, "implementation", started_day="02", duration_min=8),
    cycle_run(4, None, "idle_check", started_day="03", duration_min=1, has_transcript=False),
]

COSTS = [
    cycle_entry(1, "impl-RHCLOUD-001", day="01", cost=0.12, external_key="RHCLOUD-001", repo="frontend"),
    cycle_entry(2, "review-RHCLOUD-001", day="01", cost=0.08, external_key="RHCLOUD-001", repo="frontend"),
    cycle_entry(3, "impl-RHCLOUD-002", day="02", cost=0.15, external_key="RHCLOUD-002", repo="ui-lib"),
    cycle_entry(4, "idle", day="03", cost=0.01, no_work=True),
    cycle_entry(5, "impl-RHCLOUD-004", day="04", cost=0.10, external_key="RHCLOUD-004", repo="frontend"),
]

EMBEDDINGS = [
    {
        "id": 1,
        "title": "Login timeout issue",
        "content": "Users timeout after idle",
        "category": "bug",
        "repo": "frontend",
        "tags": ["auth"],
        "x": 0.1,
        "y": 0.2,
        "z": 0.3,
    },
    {
        "id": 2,
        "title": "Auth flow design",
        "content": "OAuth2 with PKCE",
        "category": "architecture",
        "repo": "backend",
        "tags": ["security"],
        "x": 0.4,
        "y": 0.5,
        "z": 0.2,
    },
    {
        "id": 3,
        "title": "Framework choice",
        "content": "React over Vue",
        "category": "decision",
        "repo": "frontend",
        "tags": ["react"],
        "x": 0.7,
        "y": 0.1,
        "z": 0.4,
    },
]

TAGS = ["auth", "timeout", "security", "oauth", "react", "typescript", "database", "performance"]

ANALYTICS = {
    "summary": {
        "total_cycles": 25,
        "work_cycles": 20,
        "idle_cycles": 3,
        "error_cycles": 2,
        "unique_tickets": 5,
        "total_cost": 3.50,
        "avg_cost_per_work_cycle": 0.175,
        "avg_turns": 8.5,
        "avg_duration_ms": 350000,
        "repos_touched": 3,
        "tickets_resolved": 2,
    },
    "work_types": [
        {
            "category": "implementation",
            "cycles": 12,
            "total_cost": 1.80,
            "avg_cost": 0.15,
            "avg_turns": 9,
            "avg_duration_ms": 400000,
        },
        {
            "category": "review",
            "cycles": 5,
            "total_cost": 0.70,
            "avg_cost": 0.14,
            "avg_turns": 7,
            "avg_duration_ms": 250000,
        },
        {
            "category": "debugging",
            "cycles": 3,
            "total_cost": 1.00,
            "avg_cost": 0.33,
            "avg_turns": 12,
            "avg_duration_ms": 600000,
        },
    ],
    "repos": [
        {"repo": "frontend", "tickets": 3, "cycles": 10, "total_cost": 1.50, "avg_turns": 8},
        {"repo": "backend", "tickets": 2, "cycles": 8, "total_cost": 1.20, "avg_turns": 9},
        {"repo": "ui-lib", "tickets": 1, "cycles": 2, "total_cost": 0.80, "avg_turns": 7},
    ],
    "tickets": [
        {
            "external_key": "RHCLOUD-001",
            "title": "Fix login bug",
            "status": "in_progress",
            "repo": "frontend",
            "total_cycles": 5,
            "impl_cycles": 3,
            "review_cycles": 2,
            "total_cost": 0.60,
            "hours_span": 8.5,
        },
        {
            "external_key": "RHCLOUD-002",
            "title": "Add dark mode",
            "status": "pr_open",
            "repo": "ui-lib",
            "total_cycles": 3,
            "impl_cycles": 2,
            "review_cycles": 1,
            "total_cost": 0.45,
            "hours_span": 5.2,
        },
    ],
    "feedback": {
        "avg_review_rounds": 1.8,
        "zero_review": 2,
        "one_review": 8,
        "multi_review": 10,
    },
}

BOT_STATUS = {
    "state": "working",
    "message": "Processing RHCLOUD-001...",
    "external_key": "RHCLOUD-001",
    "repo": "test-repo",
    "instance_id": "dev-bot",
    "updated_at": "2026-07-22T10:00:00Z",
    "cycle_start": "2026-07-22T09:55:00Z",
}

TASK_CYCLE_GROUPS = [
    {
        "task_id": 1,
        "external_key": "RHCLOUD-001",
        "title": "Fix login bug",
        "task_status": "in_progress",
        "repo": "frontend",
        "cycle_count": 5,
        "transcript_count": 5,
        "total_tool_calls": 60,
        "total_tokens": 75000,
        "first_cycle": "2026-07-01T10:00:00Z",
        "last_cycle": "2026-07-01T15:30:00Z",
    },
    {
        "task_id": 2,
        "external_key": "RHCLOUD-002",
        "title": "Add dark mode",
        "task_status": "pr_open",
        "repo": "ui-lib",
        "cycle_count": 3,
        "transcript_count": 3,
        "total_tool_calls": 36,
        "total_tokens": 45000,
        "first_cycle": "2026-07-02T10:00:00Z",
        "last_cycle": "2026-07-02T18:00:00Z",
    },
]

ACTIVE_STATUSES = {"in_progress", "pr_open", "review", "waiting"}
MAX_ACTIVE = 3
