"""Tests for jira_kanban_preflight combined module."""

import json
import sys
from pathlib import Path

import pytest

SHARED_DIR = Path(__file__).resolve().parent.parent.parent / "presets" / "shared" / "preflight"
SKILLS_DIR = Path(__file__).resolve().parent.parent.parent / ".claude" / "skills"
sys.path.insert(0, str(SHARED_DIR))
sys.path.insert(0, str(SKILLS_DIR))

from jira_kanban_preflight import (
    JIRA_COMMENT_LIMIT,
    _comments_may_be_truncated,
    _has_new_jira_feedback,
    _parse_statuses,
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


# --- _parse_statuses ---


def test_parse_default_statuses():
    assert _parse_statuses() == ["New", "Backlog", "To Do"]


def test_parse_custom_statuses(monkeypatch):
    monkeypatch.setattr("jira_kanban_preflight.BOT_KANBAN_STATUSES", "Open, In Review, Blocked")
    from jira_kanban_preflight import _parse_statuses as parse

    assert parse() == ["Open", "In Review", "Blocked"]


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
    monkeypatch.setattr("jira_kanban_preflight.INSTANCE_ID", "test-instance")
    monkeypatch.setattr("jira_kanban_preflight.BOT_LABEL", "hcc-ai-lightspeed-core")
    monkeypatch.setattr("jira_kanban_preflight.BOT_JIRA_PROJECT", "LCORE")
    monkeypatch.setattr("jira_kanban_preflight.BOT_JIRA_EMAIL", "bot@test.com")
    monkeypatch.setattr("jira_kanban_preflight.BOT_KANBAN_STATUSES", "New,Backlog,To Do")
    monkeypatch.setattr("jira_kanban_preflight.BOT_KANBAN_JQL_EXTRA", "")
    monkeypatch.setattr("jira_kanban_preflight.save_state", lambda x: None)
    return tmp_path


def test_no_active_no_candidates_returns_skip(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks()
    monkeypatch.setattr("jira_kanban_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_kanban_preflight.get_capacity", lambda: (0, 10))
    monkeypatch.setattr("jira_kanban_preflight.load_project_repos", lambda: {})
    monkeypatch.setattr("jira_kanban_preflight.build_repo_lookup", lambda x: {})
    monkeypatch.setattr("jira_kanban_preflight._get_candidates", lambda rl: [])
    monkeypatch.setattr("jira_kanban_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "skip"
    assert "No eligible work" in out["content"]


def test_no_active_with_candidates_returns_start(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks()
    candidates = [
        {
            "key": "LCORE-1",
            "summary": "Fix CVE",
            "status": "New",
            "priority": "High",
            "type": "Vulnerability",
            "labels": ["Security"],
            "repos": [],
            "description": "Fix it",
            "comments": [],
            "links": [],
        }
    ]
    monkeypatch.setattr("jira_kanban_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_kanban_preflight.get_capacity", lambda: (0, 10))
    monkeypatch.setattr("jira_kanban_preflight.load_project_repos", lambda: {})
    monkeypatch.setattr("jira_kanban_preflight.build_repo_lookup", lambda x: {})
    monkeypatch.setattr("jira_kanban_preflight._get_candidates", lambda rl: candidates)
    monkeypatch.setattr("jira_kanban_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "LCORE-1" in out["content"]


def test_candidates_without_repo_labels_still_start(env_vars, monkeypatch, capsys):
    """Kanban candidates without repo: labels should still start (unlike sprint)."""
    tasks = _mock_tasks()
    candidates = [
        {
            "key": "LCORE-10",
            "summary": "CVE in lightspeed-stack",
            "status": "New",
            "priority": "Critical",
            "type": "Vulnerability",
            "labels": ["Security", "pscomponent:lightspeed-core/lightspeed-stack-rhel9"],
            "repos": [],
            "description": "Vulnerable package found",
            "comments": [],
            "links": [],
        }
    ]
    monkeypatch.setattr("jira_kanban_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_kanban_preflight.get_capacity", lambda: (0, 10))
    monkeypatch.setattr("jira_kanban_preflight.load_project_repos", lambda: {})
    monkeypatch.setattr("jira_kanban_preflight.build_repo_lookup", lambda x: {})
    monkeypatch.setattr("jira_kanban_preflight._get_candidates", lambda rl: candidates)
    monkeypatch.setattr("jira_kanban_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "LCORE-10" in out["content"]
    assert "agent determines repo from ticket content" in out["content"]


def test_active_with_feedback_returns_start(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "LCORE-2",
                "status": "pr_open",
                "repo": "lightspeed-stack",
                "last_addressed": "2026-06-30T10:00:00",
                "metadata": {"prs": [{"repo": "lightspeed-stack", "number": 1, "host": "github"}]},
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
    monkeypatch.setattr("jira_kanban_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_kanban_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("jira_kanban_preflight._jira_issue", lambda key: jira_data)
    monkeypatch.setattr("jira_kanban_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "JIRA FEEDBACK" in out["content"]


def test_active_with_feedback_legacy_path(env_vars, monkeypatch, capsys):
    """Fallback: comments under fields.comment.comments still works."""
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "LCORE-2b",
                "status": "pr_open",
                "repo": "lightspeed-stack",
                "last_addressed": "2026-06-30T10:00:00",
                "metadata": {"prs": [{"repo": "lightspeed-stack", "number": 1, "host": "github"}]},
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
    monkeypatch.setattr("jira_kanban_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_kanban_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("jira_kanban_preflight._jira_issue", lambda key: jira_data)
    monkeypatch.setattr("jira_kanban_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "JIRA FEEDBACK" in out["content"]


def test_active_all_clean_no_candidates_returns_skip(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "LCORE-3",
                "status": "pr_open",
                "repo": "lightspeed-stack",
                "last_addressed": "2026-07-01T12:00:00",
                "metadata": {"prs": [{"repo": "lightspeed-stack", "number": 1, "host": "github"}]},
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
    monkeypatch.setattr("jira_kanban_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_kanban_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("jira_kanban_preflight._jira_issue", lambda key: jira_data)
    monkeypatch.setattr("jira_kanban_preflight.load_project_repos", lambda: {})
    monkeypatch.setattr("jira_kanban_preflight.build_repo_lookup", lambda x: {})
    monkeypatch.setattr("jira_kanban_preflight._get_candidates", lambda rl: [])
    monkeypatch.setattr("jira_kanban_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "skip"
    assert "No eligible work" in out["content"]


def test_active_all_clean_with_candidates_returns_start(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "LCORE-3",
                "status": "pr_open",
                "repo": "lightspeed-stack",
                "last_addressed": "2026-07-01T12:00:00",
                "metadata": {"prs": [{"repo": "lightspeed-stack", "number": 1, "host": "github"}]},
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
            "key": "LCORE-99",
            "summary": "New CVE",
            "status": "New",
            "priority": "High",
            "type": "Vulnerability",
            "labels": ["Security"],
            "repos": [],
            "description": "Build it",
            "comments": [],
            "links": [],
        }
    ]
    monkeypatch.setattr("jira_kanban_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_kanban_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("jira_kanban_preflight._jira_issue", lambda key: jira_data)
    monkeypatch.setattr("jira_kanban_preflight.load_project_repos", lambda: {})
    monkeypatch.setattr("jira_kanban_preflight.build_repo_lookup", lambda x: {})
    monkeypatch.setattr("jira_kanban_preflight._get_candidates", lambda rl: candidates)
    monkeypatch.setattr("jira_kanban_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "LCORE-99" in out["content"]


def test_at_capacity_investigation_only(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks()
    inv_candidates = [
        {
            "key": "LCORE-4",
            "summary": "Investigate outage",
            "status": "New",
            "priority": "High",
            "type": "Task",
            "labels": ["needs-investigation"],
            "repos": [],
            "description": "Look into it",
            "comments": [],
            "links": [],
        }
    ]
    monkeypatch.setattr("jira_kanban_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_kanban_preflight.get_capacity", lambda: (10, 10))
    monkeypatch.setattr("jira_kanban_preflight.load_project_repos", lambda: {})
    monkeypatch.setattr("jira_kanban_preflight.build_repo_lookup", lambda x: {})
    monkeypatch.setattr("jira_kanban_preflight._get_investigation_candidates", lambda rl: inv_candidates)
    monkeypatch.setattr("jira_kanban_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "Investigation" in out["content"]


def test_at_capacity_no_investigations_returns_skip(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks()
    monkeypatch.setattr("jira_kanban_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_kanban_preflight.get_capacity", lambda: (10, 10))
    monkeypatch.setattr("jira_kanban_preflight.load_project_repos", lambda: {})
    monkeypatch.setattr("jira_kanban_preflight.build_repo_lookup", lambda x: {})
    monkeypatch.setattr("jira_kanban_preflight._get_investigation_candidates", lambda rl: [])
    monkeypatch.setattr("jira_kanban_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "skip"
    assert "capacity" in out["content"].lower()


def test_missing_instance_id_returns_error(monkeypatch, capsys):
    monkeypatch.setattr("jira_kanban_preflight.INSTANCE_ID", "")

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "error"


def test_interrupted_task_returns_start(env_vars, monkeypatch, capsys):
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "LCORE-5",
                "status": "in_progress",
                "repo": "lightspeed-stack",
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
    monkeypatch.setattr("jira_kanban_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_kanban_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("jira_kanban_preflight._jira_issue", lambda key: jira_data)
    monkeypatch.setattr("jira_kanban_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "INTERRUPTED" in out["content"]


def test_extra_jql_appended(env_vars, monkeypatch):
    """BOT_KANBAN_JQL_EXTRA is included in candidate queries."""
    monkeypatch.setattr("jira_kanban_preflight.BOT_KANBAN_JQL_EXTRA", "type = Vulnerability")
    captured_jqls = []

    def mock_search(jql, limit=10):
        captured_jqls.append(jql)
        return []

    monkeypatch.setattr("jira_kanban_preflight._jira_search", mock_search)

    from jira_kanban_preflight import _get_candidates

    _get_candidates({})

    assert len(captured_jqls) >= 1
    assert "type = Vulnerability" in captured_jqls[0]


def test_custom_statuses_in_query(env_vars, monkeypatch):
    """Custom BOT_KANBAN_STATUSES appear in JQL."""
    monkeypatch.setattr("jira_kanban_preflight.BOT_KANBAN_STATUSES", "Open,Ready")
    captured_jqls = []

    def mock_search(jql, limit=10):
        captured_jqls.append(jql)
        return []

    monkeypatch.setattr("jira_kanban_preflight._jira_search", mock_search)

    from jira_kanban_preflight import _get_candidates

    _get_candidates({})

    assert len(captured_jqls) >= 1
    assert '"Open"' in captured_jqls[0]
    assert '"Ready"' in captured_jqls[0]


def test_bot_label_in_candidate_query(env_vars, monkeypatch):
    """BOT_LABEL is used to filter candidates in JQL."""
    captured_jqls = []

    def mock_search(jql, limit=10):
        captured_jqls.append(jql)
        return []

    monkeypatch.setattr("jira_kanban_preflight._jira_search", mock_search)

    from jira_kanban_preflight import _get_candidates

    _get_candidates({})

    assert len(captured_jqls) >= 1
    assert "labels = hcc-ai-lightspeed-core" in captured_jqls[0]


def test_missing_bot_label_returns_empty(env_vars, monkeypatch):
    """No BOT_LABEL → _get_candidates returns empty, no JQL fired."""
    monkeypatch.setattr("jira_kanban_preflight.BOT_LABEL", "")
    captured_jqls = []

    def mock_search(jql, limit=10):
        captured_jqls.append(jql)
        return []

    monkeypatch.setattr("jira_kanban_preflight._jira_search", mock_search)

    from jira_kanban_preflight import _get_candidates

    result = _get_candidates({})

    assert result == []
    assert len(captured_jqls) == 0


def test_bot_label_in_investigation_query(env_vars, monkeypatch):
    """BOT_LABEL is used to filter investigation candidates."""
    captured_jqls = []

    def mock_search(jql, limit=10):
        captured_jqls.append(jql)
        return []

    monkeypatch.setattr("jira_kanban_preflight._jira_search", mock_search)

    from jira_kanban_preflight import _get_investigation_candidates

    _get_investigation_candidates({})

    assert len(captured_jqls) == 1
    assert "labels = hcc-ai-lightspeed-core" in captured_jqls[0]
    assert "labels = needs-investigation" in captured_jqls[0]


# --- _comments_may_be_truncated ---


def test_truncated_when_at_limit_and_updated():
    """Exactly JIRA_COMMENT_LIMIT comments + updated after last_addressed → truncated."""
    comments = [{"created": f"2026-06-{i:02d}T10:00:00"} for i in range(1, JIRA_COMMENT_LIMIT + 1)]
    jira_data = {"updated": "2026-08-01T10:00:00"}
    assert _comments_may_be_truncated(jira_data, comments, "2026-07-01T10:00:00") is True


def test_not_truncated_when_under_limit():
    """Fewer than JIRA_COMMENT_LIMIT comments → never truncated regardless of updated."""
    comments = [{"created": "2026-06-01T10:00:00"}]
    jira_data = {"updated": "2026-08-01T10:00:00"}
    assert _comments_may_be_truncated(jira_data, comments, "2026-07-01T10:00:00") is False


def test_not_truncated_when_not_updated():
    """At limit but updated before last_addressed → not truncated."""
    comments = [{"created": f"2026-06-{i:02d}T10:00:00"} for i in range(1, JIRA_COMMENT_LIMIT + 1)]
    jira_data = {"updated": "2026-06-15T10:00:00"}
    assert _comments_may_be_truncated(jira_data, comments, "2026-07-01T10:00:00") is False


def test_not_truncated_when_no_last_addressed():
    """No last_addressed → not truncated (first encounter)."""
    comments = [{"created": f"2026-06-{i:02d}T10:00:00"} for i in range(1, JIRA_COMMENT_LIMIT + 1)]
    jira_data = {"updated": "2026-08-01T10:00:00"}
    assert _comments_may_be_truncated(jira_data, comments, "") is False


def test_not_truncated_when_no_jira_data():
    assert _comments_may_be_truncated(None, [], "2026-07-01T10:00:00") is False


def test_truncated_with_fields_updated_path():
    """updated under fields.updated also works."""
    comments = [{"created": f"2026-06-{i:02d}T10:00:00"} for i in range(1, JIRA_COMMENT_LIMIT + 1)]
    jira_data = {"fields": {"updated": "2026-08-01T10:00:00"}}
    assert _comments_may_be_truncated(jira_data, comments, "2026-07-01T10:00:00") is True


# --- truncation fallback in main() ---


def test_truncated_comments_trigger_feedback(env_vars, monkeypatch, capsys):
    """When comments are truncated and issue was updated, task is treated as feedback."""
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "LCORE-TRUNC",
                "status": "pr_open",
                "repo": "lightspeed-stack",
                "last_addressed": "2026-07-01T10:00:00",
                "metadata": {"prs": [{"repo": "lightspeed-stack", "number": 1, "host": "github"}]},
            }
        ]
    )
    old_comments = [
        {
            "created": f"2026-06-{(i % 28) + 1:02d}T10:00:00",
            "body": f"Old comment {i}",
            "author": {"displayName": "Human"},
        }
        for i in range(JIRA_COMMENT_LIMIT)
    ]
    jira_data = {
        "updated": "2026-08-05T19:52:00",
        "fields": {
            "status": {"name": "Code Review"},
            "labels": [],
            "issuelinks": [],
        },
        "comments": old_comments,
    }
    monkeypatch.setattr("jira_kanban_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("jira_kanban_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("jira_kanban_preflight._jira_issue", lambda key: jira_data)
    monkeypatch.setattr("jira_kanban_preflight.jira_cleanup", lambda: None)

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "JIRA FEEDBACK" in out["content"]
