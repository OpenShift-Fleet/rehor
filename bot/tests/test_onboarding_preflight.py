"""Tests for onboarding_preflight module."""

import json
import sys
from pathlib import Path

import pytest

SHARED_DIR = Path(__file__).resolve().parent.parent.parent / "presets" / "shared" / "preflight"
SKILLS_DIR = Path(__file__).resolve().parent.parent.parent / ".claude" / "skills"
sys.path.insert(0, str(SHARED_DIR))
sys.path.insert(0, str(SKILLS_DIR))

from onboarding_preflight import (
    _get_onboarding_label,
    _has_new_jira_feedback,
    _is_blocked,
    main,
)

# --- _has_new_jira_feedback ---


def test_feedback_detected_with_comments_field():
    """The fix: when MCP returns comments at top-level, feedback is detected."""
    issue = {
        "comments": [
            {
                "created": "2026-07-01T10:00:00",
                "body": "Here are the answers to your questions",
                "author": {"displayName": "Human"},
            }
        ]
    }
    task = {"last_addressed": "2026-06-30T10:00:00"}
    assert _has_new_jira_feedback(task, issue) is True


def test_feedback_detected_first_comment_no_last_addressed():
    """First human comment on a ticket with no prior addressing."""
    issue = {
        "comments": [
            {
                "created": "2026-07-01T10:00:00",
                "body": "Hello",
                "author": {"displayName": "Human"},
            }
        ]
    }
    task = {}
    assert _has_new_jira_feedback(task, issue) is True


def test_no_feedback_when_comment_is_old():
    issue = {
        "comments": [
            {
                "created": "2026-06-29T10:00:00",
                "body": "Old comment",
                "author": {"displayName": "Human"},
            }
        ]
    }
    task = {"last_addressed": "2026-06-30T10:00:00"}
    assert _has_new_jira_feedback(task, issue) is False


def test_no_feedback_when_no_comments():
    issue = {"comments": []}
    task = {"last_addressed": "2026-06-30T10:00:00"}
    assert _has_new_jira_feedback(task, issue) is False


def test_no_feedback_when_issue_is_none():
    assert _has_new_jira_feedback({}, None) is False


def test_no_feedback_when_comments_key_missing():
    issue = {"fields": {"summary": "test"}}
    task = {"last_addressed": "2026-06-30T10:00:00"}
    assert _has_new_jira_feedback(task, issue) is False


# --- _is_blocked ---


def test_is_blocked_true():
    issue = {"labels": ["onboarding:requirements", "onboarding:blocked"]}
    assert _is_blocked(issue) is True


def test_is_blocked_false():
    issue = {"labels": ["onboarding:requirements"]}
    assert _is_blocked(issue) is False


def test_is_blocked_none():
    assert _is_blocked(None) is False


# --- _get_onboarding_label ---


def test_get_onboarding_label():
    issue = {"labels": ["rehor-ai-onboarding-bot", "onboarding:requirements"]}
    assert _get_onboarding_label(issue) == "onboarding:requirements"


def test_get_onboarding_label_ignores_blocked():
    issue = {"labels": ["onboarding:blocked"]}
    assert _get_onboarding_label(issue) is None


def test_get_onboarding_label_none_issue():
    assert _get_onboarding_label(None) is None


def test_get_onboarding_label_no_onboarding_labels():
    issue = {"labels": ["rehor-ai-onboarding-bot"]}
    assert _get_onboarding_label(issue) is None


# --- main() ---


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
    monkeypatch.setattr("onboarding_preflight.INSTANCE_ID", "test-instance")
    monkeypatch.setattr("onboarding_preflight.BOT_LABEL", "rehor-ai-onboarding-bot")
    monkeypatch.setattr("onboarding_preflight.BOT_JIRA_EMAIL", "bot@test.com")
    monkeypatch.setattr("onboarding_preflight.save_state", lambda x: None)


def test_active_task_with_new_feedback_returns_start(env_vars, monkeypatch, capsys):
    """Core test: preflight detects new Jira comment and returns start."""
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "REHOR-10",
                "status": "in_progress",
                "repo": "",
                "last_addressed": "2026-06-30T10:00:00",
                "metadata": {"step": "requirements"},
            }
        ]
    )
    issue = {
        "labels": ["rehor-ai-onboarding-bot", "onboarding:requirements"],
        "comments": [
            {
                "created": "2026-07-01T10:00:00",
                "body": "Our team name is Platform and we want to onboard service X",
                "author": {"displayName": "Human User"},
            }
        ],
    }
    monkeypatch.setattr("onboarding_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("onboarding_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("onboarding_preflight._jira_issue", lambda key: issue)
    monkeypatch.setattr("onboarding_preflight._get_candidates", lambda: [])
    monkeypatch.setattr("onboarding_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "HAS NEW JIRA FEEDBACK" in out["content"]


def test_active_task_no_feedback_no_candidates_returns_skip(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "REHOR-10",
                "status": "in_progress",
                "repo": "",
                "last_addressed": "2026-07-01T12:00:00",
                "metadata": {"step": "requirements"},
            }
        ]
    )
    issue = {
        "labels": ["rehor-ai-onboarding-bot", "onboarding:requirements"],
        "comments": [
            {
                "created": "2026-07-01T10:00:00",
                "body": "Already addressed comment",
                "author": {"displayName": "Human User"},
            }
        ],
    }
    monkeypatch.setattr("onboarding_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("onboarding_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("onboarding_preflight._jira_issue", lambda key: issue)
    monkeypatch.setattr("onboarding_preflight._get_candidates", lambda: [])
    monkeypatch.setattr("onboarding_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "skip"


def test_no_active_with_candidates_returns_start(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks()
    candidates = [
        {
            "key": "REHOR-20",
            "fields": {
                "summary": "Onboard team Foo",
                "status": {"name": "New"},
                "labels": ["rehor-ai-onboarding-bot"],
            },
        }
    ]
    monkeypatch.setattr("onboarding_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("onboarding_preflight.get_capacity", lambda: (0, 10))
    monkeypatch.setattr("onboarding_preflight._get_candidates", lambda: candidates)
    monkeypatch.setattr("onboarding_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "REHOR-20" in out["content"]


def test_no_active_no_candidates_returns_skip(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks()
    monkeypatch.setattr("onboarding_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("onboarding_preflight.get_capacity", lambda: (0, 10))
    monkeypatch.setattr("onboarding_preflight._get_candidates", lambda: [])
    monkeypatch.setattr("onboarding_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "skip"
    assert "No active tasks and no new candidates" in out["content"]


def test_blocked_task_skipped(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "REHOR-30",
                "status": "in_progress",
                "repo": "",
                "metadata": {"step": "scaffolding-pr"},
            }
        ]
    )
    issue = {
        "labels": ["rehor-ai-onboarding-bot", "onboarding:scaffolding-pr", "onboarding:blocked"],
        "comments": [],
    }
    monkeypatch.setattr("onboarding_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("onboarding_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("onboarding_preflight._jira_issue", lambda key: issue)
    monkeypatch.setattr("onboarding_preflight._get_candidates", lambda: [])
    monkeypatch.setattr("onboarding_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "skip"
    assert "BLOCKED" in out["content"]


def test_auto_advance_label_merged_returns_start(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "REHOR-40",
                "status": "in_progress",
                "repo": "",
                "last_addressed": "2026-07-01T12:00:00",
                "metadata": {"step": "scaffolding-pr"},
            }
        ]
    )
    issue = {
        "labels": ["rehor-ai-onboarding-bot", "onboarding:scaffolding-pr"],
        "comments": [],
    }
    monkeypatch.setattr("onboarding_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("onboarding_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("onboarding_preflight._jira_issue", lambda key: issue)
    monkeypatch.setattr("onboarding_preflight._get_candidates", lambda: [])
    monkeypatch.setattr("onboarding_preflight._any_pr_mr_merged", lambda t: True)
    monkeypatch.setattr("onboarding_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "PR/MR MERGED" in out["content"]


def test_auto_advance_label_not_merged_returns_skip(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "REHOR-40",
                "status": "in_progress",
                "repo": "",
                "last_addressed": "2026-07-01T12:00:00",
                "metadata": {"step": "scaffolding-pr"},
            }
        ]
    )
    issue = {
        "labels": ["rehor-ai-onboarding-bot", "onboarding:scaffolding-pr"],
        "comments": [],
    }
    monkeypatch.setattr("onboarding_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("onboarding_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("onboarding_preflight._jira_issue", lambda key: issue)
    monkeypatch.setattr("onboarding_preflight._get_candidates", lambda: [])
    monkeypatch.setattr("onboarding_preflight._any_pr_mr_merged", lambda t: False)
    monkeypatch.setattr("onboarding_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "skip"
    assert "waiting for PR/MR merge" in out["content"]


def test_missing_instance_id_returns_error(monkeypatch, capsys):
    monkeypatch.setattr("onboarding_preflight.INSTANCE_ID", "")

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "error"


def test_jira_unavailable_still_works(env_vars, monkeypatch, capsys):
    """When Jira MCP is down, task shows unavailable but doesn't crash."""
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "REHOR-50",
                "status": "in_progress",
                "repo": "",
                "metadata": {"step": "requirements"},
            }
        ]
    )
    monkeypatch.setattr("onboarding_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("onboarding_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("onboarding_preflight._jira_issue", lambda key: None)
    monkeypatch.setattr("onboarding_preflight._get_candidates", lambda: [])
    monkeypatch.setattr("onboarding_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "skip"
    assert "jira unavailable" in out["content"]
