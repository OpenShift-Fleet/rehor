"""Example tests using shared fixtures."""

import pytest
from fixtures import TASKS, memory, task


def test_task_fixture_structure():
    """Verify task fixture generates expected structure."""
    t = task(1, "TEST-001", "Test summary", "in_progress")

    assert t["id"] == 1
    assert t["external_key"] == "TEST-001"
    assert t["title"] == "Test summary"
    assert t["status"] == "in_progress"
    assert t["source_type"] == "jira"
    assert "artifacts" in t
    assert t["last_addressed"] is not None  # in_progress sets this


def test_task_paused_state():
    """Verify paused task has reason."""
    t = task(2, "TEST-002", "Paused task", "paused", paused_reason="Blocked by TEST-001")

    assert t["status"] == "paused"
    assert t["paused_reason"] == "Blocked by TEST-001"
    assert t["last_addressed"] is None  # paused clears this


def test_memory_fixture_with_tags():
    """Verify memory fixture handles tags."""
    m = memory(1, "bug", "Test bug", "Bug description", tags=["urgent", "regression"])

    assert m["category"] == "bug"
    assert "urgent" in m["tags"]
    assert "regression" in m["tags"]


def test_default_tasks_dataset():
    """Verify default TASKS dataset is usable."""
    assert len(TASKS) == 6
    assert "RHCLOUD-001" in TASKS

    task_001 = TASKS["RHCLOUD-001"]
    assert task_001["status"] == "in_progress"
    assert task_001["repo"] == "frontend"


@pytest.mark.parametrize(
    "key,expected_status",
    [
        ("RHCLOUD-001", "in_progress"),
        ("RHCLOUD-002", "pr_open"),
        ("RHCLOUD-003", "paused"),
        ("RHCLOUD-005", "done"),
        ("RHCLOUD-006", "archived"),
    ],
)
def test_task_statuses(key, expected_status):
    """Verify default tasks have correct statuses."""
    assert TASKS[key]["status"] == expected_status
