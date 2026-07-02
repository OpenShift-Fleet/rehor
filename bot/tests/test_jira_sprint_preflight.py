"""Tests for jira_sprint_preflight combined module."""

import json
import sys
from pathlib import Path

import pytest

SHARED_DIR = Path(__file__).resolve().parent.parent.parent / "presets" / "shared" / "preflight"
SKILLS_DIR = Path(__file__).resolve().parent.parent.parent / ".claude" / "skills"
sys.path.insert(0, str(SHARED_DIR))
sys.path.insert(0, str(SKILLS_DIR))

from jira_sprint_preflight import (  # noqa: E402
    _has_new_jira_feedback,
    main,
)

# --- _has_new_jira_feedback ---


def test_new_feedback_detected():
    comments = [{"created": "2026-07-01T10:00:00", "body": "Hey can you check this?"}]
    assert _has_new_jira_feedback(comments, "2026-06-30T10:00:00") is True


def test_old_feedback_ignored():
    comments = [{"created": "2026-06-30T08:00:00", "body": "Hey can you check this?"}]
    assert _has_new_jira_feedback(comments, "2026-06-30T10:00:00") is False


def test_bot_structured_comment_not_feedback():
    comments = [{"created": "2026-07-01T10:00:00", "body": "### Analysis\n\n| col1 | col2 |\n|---|---|\n| a | b |"}]
    assert _has_new_jira_feedback(comments, "2026-06-30T10:00:00") is False


def test_pr_link_not_feedback():
    comments = [{"created": "2026-07-01T10:00:00", "body": "PR: https://github.com/org/repo/pull/42"}]
    assert _has_new_jira_feedback(comments, "2026-06-30T10:00:00") is False


def test_empty_comments():
    assert _has_new_jira_feedback([], "2026-06-30T10:00:00") is False


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
def env_vars(monkeypatch, tmp_path):
    monkeypatch.setattr("jira_sprint_preflight.INSTANCE_ID", "test-instance")
    monkeypatch.setattr("jira_sprint_preflight.BOT_LABEL", "hcc-ai-test")
    monkeypatch.setattr("jira_sprint_preflight.BOT_JIRA_EMAIL", "bot@test.com")
    monkeypatch.setattr("jira_sprint_preflight.save_state", lambda x: None)
    return tmp_path


def test_no_active_no_candidates_returns_skip(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks()
    monkeypatch.setattr("jira_sprint_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_sprint_preflight.get_capacity", lambda: (0, 10))
    monkeypatch.setattr("jira_sprint_preflight.load_project_repos", lambda: {})
    monkeypatch.setattr("jira_sprint_preflight.build_repo_lookup", lambda x: {})
    monkeypatch.setattr("jira_sprint_preflight._get_candidates", lambda rl: [])
    monkeypatch.setattr("jira_sprint_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "skip"
    assert "No eligible work" in out["content"]


def test_no_active_with_candidates_returns_start(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks()
    candidates = [
        {
            "key": "TEST-1",
            "summary": "Fix bug",
            "status": "New",
            "priority": "High",
            "type": "Bug",
            "labels": ["hcc-ai-test", "repo:my-repo"],
            "repos": ["my-repo"],
            "description": "Fix it",
            "comments": [],
            "links": [],
        }
    ]
    monkeypatch.setattr("jira_sprint_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_sprint_preflight.get_capacity", lambda: (0, 10))
    monkeypatch.setattr("jira_sprint_preflight.load_project_repos", lambda: {})
    monkeypatch.setattr("jira_sprint_preflight.build_repo_lookup", lambda x: {})
    monkeypatch.setattr("jira_sprint_preflight._get_candidates", lambda rl: candidates)
    monkeypatch.setattr("jira_sprint_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "TEST-1" in out["content"]


def test_active_with_feedback_returns_start(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "TEST-2",
                "status": "pr_open",
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
    monkeypatch.setattr("jira_sprint_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_sprint_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("jira_sprint_preflight._jira_issue", lambda key: jira_data)
    monkeypatch.setattr("jira_sprint_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "JIRA FEEDBACK" in out["content"]


def test_active_all_clean_no_candidates_returns_skip(env_vars, monkeypatch, capsys):
    """Active tasks all Jira-clean, falls through to Phase 2, no candidates → skip."""
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "TEST-3",
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
            "comment": {"comments": []},
        }
    }
    monkeypatch.setattr("jira_sprint_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_sprint_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("jira_sprint_preflight._jira_issue", lambda key: jira_data)
    monkeypatch.setattr("jira_sprint_preflight.load_project_repos", lambda: {})
    monkeypatch.setattr("jira_sprint_preflight.build_repo_lookup", lambda x: {})
    monkeypatch.setattr("jira_sprint_preflight._get_candidates", lambda rl: [])
    monkeypatch.setattr("jira_sprint_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "skip"
    assert "No eligible work" in out["content"]


def test_active_all_clean_with_candidates_returns_start(env_vars, monkeypatch, capsys):
    """Active tasks all Jira-clean but capacity + candidates → start (the bug fix)."""
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "TEST-3",
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
            "comment": {"comments": []},
        }
    }
    candidates = [
        {
            "key": "TEST-99",
            "summary": "New feature",
            "status": "New",
            "priority": "High",
            "type": "Story",
            "labels": ["hcc-ai-test", "repo:my-repo"],
            "repos": ["my-repo"],
            "description": "Build it",
            "comments": [],
            "links": [],
        }
    ]
    monkeypatch.setattr("jira_sprint_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_sprint_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("jira_sprint_preflight._jira_issue", lambda key: jira_data)
    monkeypatch.setattr("jira_sprint_preflight.load_project_repos", lambda: {})
    monkeypatch.setattr("jira_sprint_preflight.build_repo_lookup", lambda x: {})
    monkeypatch.setattr("jira_sprint_preflight._get_candidates", lambda rl: candidates)
    monkeypatch.setattr("jira_sprint_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "TEST-99" in out["content"]


def test_at_capacity_investigation_only(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks()
    inv_candidates = [
        {
            "key": "TEST-4",
            "summary": "Investigate outage",
            "status": "New",
            "priority": "High",
            "type": "Task",
            "labels": ["hcc-ai-test", "needs-investigation"],
            "repos": [],
            "description": "Look into it",
            "comments": [],
            "links": [],
        }
    ]
    monkeypatch.setattr("jira_sprint_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_sprint_preflight.get_capacity", lambda: (10, 10))
    monkeypatch.setattr("jira_sprint_preflight.load_project_repos", lambda: {})
    monkeypatch.setattr("jira_sprint_preflight.build_repo_lookup", lambda x: {})
    monkeypatch.setattr("jira_sprint_preflight._get_investigation_candidates", lambda rl: inv_candidates)
    monkeypatch.setattr("jira_sprint_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "Investigation" in out["content"]


def test_at_capacity_no_investigations_returns_skip(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks()
    monkeypatch.setattr("jira_sprint_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_sprint_preflight.get_capacity", lambda: (10, 10))
    monkeypatch.setattr("jira_sprint_preflight.load_project_repos", lambda: {})
    monkeypatch.setattr("jira_sprint_preflight.build_repo_lookup", lambda x: {})
    monkeypatch.setattr("jira_sprint_preflight._get_investigation_candidates", lambda rl: [])
    monkeypatch.setattr("jira_sprint_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "skip"
    assert "capacity" in out["content"].lower()


def test_missing_instance_id_returns_error(monkeypatch, capsys):
    monkeypatch.setattr("jira_sprint_preflight.INSTANCE_ID", "")

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "error"


def test_interrupted_task_returns_start(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "TEST-5",
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
            "comment": {"comments": []},
        }
    }
    monkeypatch.setattr("jira_sprint_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_sprint_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("jira_sprint_preflight._jira_issue", lambda key: jira_data)
    monkeypatch.setattr("jira_sprint_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "INTERRUPTED" in out["content"]
