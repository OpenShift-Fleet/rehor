"""Tests for jira_triage preflight module."""

import json
import sys
from pathlib import Path

import pytest

SHARED_DIR = Path(__file__).resolve().parent.parent.parent / "presets" / "shared" / "preflight"
SKILLS_DIR = Path(__file__).resolve().parent.parent.parent / ".claude" / "skills"
sys.path.insert(0, str(SHARED_DIR))
sys.path.insert(0, str(SKILLS_DIR))

from jira_triage import (
    has_new_jira_feedback,
    main,
)

# --- has_new_jira_feedback ---


def test_new_feedback_detected():
    comments = [{"created": "2026-07-01T10:00:00", "body": "Hey can you check this?"}]
    assert has_new_jira_feedback(comments, "2026-06-30T10:00:00") is True


def test_old_feedback_ignored():
    comments = [{"created": "2026-06-30T08:00:00", "body": "Hey can you check this?"}]
    assert has_new_jira_feedback(comments, "2026-06-30T10:00:00") is False


def test_bot_structured_comment_not_feedback():
    comments = [{"created": "2026-07-01T10:00:00", "body": "### Analysis\n\n| col1 | col2 |\n|---|---|\n| a | b |"}]
    assert has_new_jira_feedback(comments, "2026-06-30T10:00:00") is False


def test_pr_link_not_feedback():
    comments = [{"created": "2026-07-01T10:00:00", "body": "PR: https://github.com/org/repo/pull/42"}]
    assert has_new_jira_feedback(comments, "2026-06-30T10:00:00") is False


def test_empty_comments():
    assert has_new_jira_feedback([], "2026-06-30T10:00:00") is False


# --- main() decision logic ---


def _mock_tasks(active=None, done=None, paused=None):
    items = []
    for t in active or []:
        items.append({**t, "status": t.get("status", "in_progress")})
    for t in done or []:
        items.append({**t, "status": "done"})
    for t in paused or []:
        items.append({**t, "status": "paused"})
    return items


@pytest.fixture
def env_vars(monkeypatch):
    monkeypatch.setattr("jira_triage.INSTANCE_ID", "test-instance")
    monkeypatch.setattr("jira_triage.save_state", lambda x: None)


def test_no_active_returns_start(env_vars, monkeypatch, capsys):
    """No active tasks → start (Priority 2: new Jira work)."""
    tasks = _mock_tasks()
    monkeypatch.setattr("jira_triage.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_triage.get_capacity", lambda: (0, 10))
    monkeypatch.setattr("jira_triage.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "No active tasks" in out["content"]


def test_active_with_feedback_returns_start(env_vars, monkeypatch, capsys):
    """Top-level comments key (MCP response format) triggers feedback detection."""
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "TEST-1",
                "status": "in_progress",
                "repo": "my-repo",
                "last_addressed": "2026-06-30T10:00:00",
                "metadata": {"prs": [{"repo": "my-repo", "number": 1, "host": "github"}]},
            }
        ]
    )
    jira_data = {
        "fields": {
            "status": {"name": "In Progress"},
            "labels": [],
            "issuelinks": [],
        },
        "comments": [
            {
                "created": "2026-07-01T10:00:00",
                "body": "Can you check this?",
                "author": {"displayName": "Human"},
            }
        ],
    }
    monkeypatch.setattr("jira_triage.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_triage.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("jira_triage.jira_issue", lambda key: jira_data)
    monkeypatch.setattr("jira_triage.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "JIRA FEEDBACK" in out["content"]


def test_active_with_feedback_legacy_path(env_vars, monkeypatch, capsys):
    """Fallback: comments under fields.comment.comments still works."""
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "TEST-1b",
                "status": "in_progress",
                "repo": "my-repo",
                "last_addressed": "2026-06-30T10:00:00",
                "metadata": {"prs": [{"repo": "my-repo", "number": 1, "host": "github"}]},
            }
        ]
    )
    jira_data = {
        "fields": {
            "status": {"name": "In Progress"},
            "labels": [],
            "issuelinks": [],
            "comment": {
                "comments": [
                    {
                        "created": "2026-07-01T10:00:00",
                        "body": "Can you check this?",
                        "author": {"displayName": "Human"},
                    }
                ]
            },
        }
    }
    monkeypatch.setattr("jira_triage.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_triage.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("jira_triage.jira_issue", lambda key: jira_data)
    monkeypatch.setattr("jira_triage.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "JIRA FEEDBACK" in out["content"]


def test_active_all_clean_returns_skip(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "TEST-2",
                "status": "pr_open",
                "repo": "my-repo",
                "last_addressed": "2026-07-01T12:00:00",
                "metadata": {"prs": [{"repo": "my-repo", "number": 1, "host": "github"}]},
            }
        ]
    )
    jira_data = {
        "fields": {
            "status": {"name": "Code Review"},
            "labels": [],
            "issuelinks": [],
        },
        "comments": [],
    }
    monkeypatch.setattr("jira_triage.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_triage.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("jira_triage.jira_issue", lambda key: jira_data)
    monkeypatch.setattr("jira_triage.jira_cleanup", lambda: None)
    monkeypatch.setattr("jira_triage.load_state", lambda: {})

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "skip"


def test_interrupted_task_returns_start(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "TEST-3",
                "status": "in_progress",
                "repo": "my-repo",
                "metadata": {"last_step": "implemented"},
            }
        ]
    )
    jira_data = {
        "fields": {
            "status": {"name": "In Progress"},
            "labels": [],
            "issuelinks": [],
        },
        "comments": [],
    }
    monkeypatch.setattr("jira_triage.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_triage.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("jira_triage.jira_issue", lambda key: jira_data)
    monkeypatch.setattr("jira_triage.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "INTERRUPTED" in out["content"]


def test_missing_instance_id_returns_error(monkeypatch, capsys):
    monkeypatch.setattr("jira_triage.INSTANCE_ID", "")

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "error"
