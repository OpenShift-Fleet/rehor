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
    _any_pr_mr_merged,
    _comments_may_be_truncated,
    _get_comments,
    _get_onboarding_label,
    _has_new_jira_feedback,
    _is_blocked,
    _phase_ticket_done,
    main,
)

# --- _has_new_jira_feedback ---


def test_feedback_detected_with_comments_field():
    """The fix: when MCP returns comments at top-level, feedback is detected."""
    comments = [
        {
            "created": "2026-07-01T10:00:00",
            "body": "Here are the answers to your questions",
            "author": {"displayName": "Human"},
        }
    ]
    assert _has_new_jira_feedback(comments, "2026-06-30T10:00:00") is True


def test_feedback_detected_first_comment_no_last_addressed():
    """First human comment on a ticket with no prior addressing."""
    comments = [
        {
            "created": "2026-07-01T10:00:00",
            "body": "Hello",
            "author": {"displayName": "Human"},
        }
    ]
    assert _has_new_jira_feedback(comments, "") is True


def test_no_feedback_when_comment_is_old():
    comments = [
        {
            "created": "2026-06-29T10:00:00",
            "body": "Old comment",
            "author": {"displayName": "Human"},
        }
    ]
    assert _has_new_jira_feedback(comments, "2026-06-30T10:00:00") is False


def test_no_feedback_when_no_comments():
    assert _has_new_jira_feedback([], "2026-06-30T10:00:00") is False


def test_no_feedback_when_issue_is_none():
    assert _has_new_jira_feedback([], "") is False


def test_no_feedback_when_comments_key_missing():
    issue = {"fields": {"summary": "test"}}
    assert _get_comments(issue) == []
    assert _has_new_jira_feedback([], "2026-06-30T10:00:00") is False


# --- _get_comments ---


def test_get_comments_top_level():
    issue = {"comments": [{"body": "a"}]}
    assert _get_comments(issue) == [{"body": "a"}]


def test_get_comments_nested():
    issue = {"fields": {"comment": {"comments": [{"body": "b"}]}}}
    assert _get_comments(issue) == [{"body": "b"}]


def test_get_comments_none():
    assert _get_comments(None) == []


# --- _comments_may_be_truncated ---


def test_truncation_detected():
    issue = {"updated": "2026-07-02T10:00:00"}
    comments = [{"body": f"c{i}"} for i in range(100)]
    assert _comments_may_be_truncated(issue, comments, "2026-07-01T10:00:00") is True


def test_no_truncation_under_limit():
    issue = {"updated": "2026-07-02T10:00:00"}
    comments = [{"body": "c"}]
    assert _comments_may_be_truncated(issue, comments, "2026-07-01T10:00:00") is False


def test_no_truncation_when_not_updated():
    issue = {"updated": "2026-06-30T10:00:00"}
    comments = [{"body": f"c{i}"} for i in range(100)]
    assert _comments_may_be_truncated(issue, comments, "2026-07-01T10:00:00") is False


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
    monkeypatch.setattr("onboarding_preflight._any_pr_mr_merged", lambda t, s: True)
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
    monkeypatch.setattr("onboarding_preflight._any_pr_mr_merged", lambda t, s: False)
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


# --- _phase_ticket_done ---


def test_phase_ticket_done_returns_true(monkeypatch):
    task = {"metadata": {"phase_tickets": {"phase1": "REHOR-101"}}}
    monkeypatch.setattr(
        "onboarding_preflight._jira_issue",
        lambda key: {"status": {"name": "Done"}},
    )
    assert _phase_ticket_done(task, "scaffolding-pr") is True


def test_phase_ticket_open_returns_false(monkeypatch):
    task = {"metadata": {"phase_tickets": {"phase2": "REHOR-102"}}}
    monkeypatch.setattr(
        "onboarding_preflight._jira_issue",
        lambda key: {"status": {"name": "In Progress"}},
    )
    assert _phase_ticket_done(task, "konflux-mr") is False


def test_phase_ticket_done_unknown_step():
    task = {"metadata": {"phase_tickets": {"phase1": "REHOR-101"}}}
    assert _phase_ticket_done(task, "unknown-step") is False


def test_phase_ticket_done_no_phase_tickets():
    task = {"metadata": {}}
    assert _phase_ticket_done(task, "scaffolding-pr") is False


def test_phase_ticket_done_jira_unavailable(monkeypatch):
    task = {"metadata": {"phase_tickets": {"phase1": "REHOR-101"}}}
    monkeypatch.setattr("onboarding_preflight._jira_issue", lambda key: None)
    assert _phase_ticket_done(task, "scaffolding-pr") is False


# --- _any_pr_mr_merged (phase-aware) ---


def test_merged_skipped_when_phase_ticket_done(monkeypatch):
    """Old merged PR ignored when its phase ticket is already Done."""
    task = {
        "metadata": {
            "phase_tickets": {"phase1": "REHOR-101"},
            "prs": [{"repo": "org/repo", "number": 1, "host": "github"}],
        }
    }
    monkeypatch.setattr(
        "onboarding_preflight._jira_issue",
        lambda key: {"status": {"name": "Done"}},
    )
    assert _any_pr_mr_merged(task, "scaffolding-pr") is False


def test_konflux_mr_ignores_old_github_pr(monkeypatch):
    """At konflux-mr step, only GitLab MRs are checked, not old GitHub PRs."""
    task = {
        "metadata": {
            "phase_tickets": {"phase2": "REHOR-102"},
            "prs": [{"repo": "org/repo", "number": 1, "host": "github"}],
            "mrs": [],
        }
    }
    monkeypatch.setattr(
        "onboarding_preflight._jira_issue",
        lambda key: {"status": {"name": "In Progress"}},
    )
    assert _any_pr_mr_merged(task, "konflux-mr") is False


def test_app_interface_mr_checks_latest_gitlab_mr(monkeypatch):
    """At app-interface-mr step, only the latest GitLab MR is checked."""
    task = {
        "metadata": {
            "phase_tickets": {"phase3": "REHOR-103"},
            "prs": [{"repo": "org/scaffolding", "number": 1, "host": "github"}],
            "mrs": [
                {"repo": "releng/konflux-release-data", "number": 10, "host": "gitlab"},
                {"repo": "service/app-interface", "number": 20, "host": "gitlab"},
            ],
        }
    }
    monkeypatch.setattr(
        "onboarding_preflight._jira_issue",
        lambda key: {"status": {"name": "In Progress"}},
    )
    monkeypatch.setattr(
        "onboarding_preflight.upstream_repo",
        lambda r: ("service/app-interface", None),
    )
    monkeypatch.setattr(
        "onboarding_preflight.subprocess",
        type(
            "FakeSP",
            (),
            {"run": staticmethod(lambda *a, **kw: type("R", (), {"returncode": 0, "stdout": '{"state": "merged"}'})())},
        )(),
    )
    assert _any_pr_mr_merged(task, "app-interface-mr") is True


def test_app_interface_mr_ignores_old_merged_konflux_mr(monkeypatch):
    """At app-interface-mr step, old merged Konflux MR doesn't false-positive."""
    task = {
        "metadata": {
            "phase_tickets": {"phase3": "REHOR-103"},
            "prs": [{"repo": "org/scaffolding", "number": 1, "host": "github"}],
            "mrs": [
                {"repo": "releng/konflux-release-data", "number": 10, "host": "gitlab"},
                {"repo": "service/app-interface", "number": 20, "host": "gitlab"},
            ],
        }
    }
    monkeypatch.setattr(
        "onboarding_preflight._jira_issue",
        lambda key: {"status": {"name": "In Progress"}},
    )
    monkeypatch.setattr(
        "onboarding_preflight.upstream_repo",
        lambda r: ("service/app-interface", None),
    )
    monkeypatch.setattr(
        "onboarding_preflight.subprocess",
        type(
            "FakeSP",
            (),
            {"run": staticmethod(lambda *a, **kw: type("R", (), {"returncode": 0, "stdout": '{"state": "opened"}'})())},
        )(),
    )
    # Latest MR (app-interface) is not merged — should return False
    # even though the older Konflux MR (index 0) is merged
    assert _any_pr_mr_merged(task, "app-interface-mr") is False


def test_tekton_setup_does_not_trigger_merge_check(env_vars, monkeypatch, capsys):
    """tekton-setup is not in labels_with_auto_advance — no merge check."""
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "REHOR-60",
                "status": "in_progress",
                "repo": "",
                "last_addressed": "2026-07-01T12:00:00",
                "metadata": {
                    "step": "tekton-setup",
                    "prs": [{"repo": "org/repo", "number": 1, "host": "github"}],
                    "mrs": [{"repo": "releng/konflux-release-data", "number": 10, "host": "gitlab"}],
                },
            }
        ]
    )
    issue = {
        "labels": ["rehor-ai-onboarding-bot", "onboarding:tekton-setup"],
        "comments": [],
    }
    monkeypatch.setattr("onboarding_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("onboarding_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("onboarding_preflight._jira_issue", lambda key: issue)
    monkeypatch.setattr("onboarding_preflight._get_candidates", lambda: [])
    monkeypatch.setattr("onboarding_preflight.jira_cleanup", lambda: None)
    # _any_pr_mr_merged should NOT be called — if it were, this would fail
    monkeypatch.setattr(
        "onboarding_preflight._any_pr_mr_merged",
        lambda t, s: (_ for _ in ()).throw(AssertionError("should not be called")),
    )

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "skip"
    assert "PR/MR MERGED" not in out["content"]


def test_konflux_mr_merged_with_phase_open_returns_start(env_vars, monkeypatch, capsys):
    """At konflux-mr step, merged MR with open phase ticket triggers start."""
    tasks = _mock_tasks(
        active=[
            {
                "external_key": "REHOR-70",
                "status": "pr_open",
                "repo": "",
                "last_addressed": "2026-07-01T12:00:00",
                "metadata": {
                    "step": "konflux-mr",
                    "phase_tickets": {"phase2": "REHOR-702"},
                    "mrs": [{"repo": "releng/konflux-release-data", "number": 10, "host": "gitlab"}],
                },
            }
        ]
    )

    def _fake_jira(key):
        if key == "REHOR-702":
            return {"status": {"name": "In Progress"}}
        return {
            "labels": ["rehor-ai-onboarding-bot", "onboarding:konflux-mr"],
            "comments": [],
        }

    monkeypatch.setattr("onboarding_preflight.get_tasks", lambda: tasks)
    monkeypatch.setattr("onboarding_preflight.get_capacity", lambda: (1, 10))
    monkeypatch.setattr("onboarding_preflight._jira_issue", _fake_jira)
    monkeypatch.setattr("onboarding_preflight._get_candidates", lambda: [])
    monkeypatch.setattr("onboarding_preflight.jira_cleanup", lambda: None)
    monkeypatch.setattr("onboarding_preflight.upstream_repo", lambda r: ("releng/konflux-release-data", None))
    monkeypatch.setattr(
        "onboarding_preflight.subprocess",
        type(
            "FakeSP",
            (),
            {"run": staticmethod(lambda *a, **kw: type("R", (), {"returncode": 0, "stdout": '{"state": "merged"}'})())},
        )(),
    )

    main()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "start"
    assert "PR/MR MERGED" in out["content"]
