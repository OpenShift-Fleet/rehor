"""Tests for slack_pr_reactions preflight module."""

import json
import sys
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import pytest

SHARED_DIR = Path(__file__).resolve().parent.parent.parent / "presets" / "shared" / "preflight"
sys.path.insert(0, str(SHARED_DIR))

from slack_pr_reactions import (  # noqa: E402
    check_pr_status,
    check_schedule,
    desired_reaction_from_gh,
    desired_reaction_from_gl,
    extract_pr_urls,
    find_open_prs_thread,
    get_thread_replies,
    process_thread,
    run,
    sync_reaction,
)

# --- extract_pr_urls ---


def test_extract_pr_urls_github():
    text = "Please review https://github.com/org/repo/pull/42"
    urls = extract_pr_urls(text)
    assert urls == [("github", "org/repo", 42)]


def test_extract_pr_urls_gitlab():
    text = "MR: https://gitlab.cee.redhat.com/team/project/-/merge_requests/7"
    urls = extract_pr_urls(text)
    assert urls == [("gitlab", "team/project", 7)]


def test_extract_pr_urls_nested_gitlab_path():
    text = "https://gitlab.cee.redhat.com/a/b/c/-/merge_requests/99"
    urls = extract_pr_urls(text)
    assert urls == [("gitlab", "a/b/c", 99)]


def test_extract_pr_urls_multiple():
    text = "GH https://github.com/o/r/pull/1 and GL https://gitlab.cee.redhat.com/g/l/-/merge_requests/2"
    urls = extract_pr_urls(text)
    assert len(urls) == 2
    assert urls[0][0] == "github"
    assert urls[1][0] == "gitlab"


def test_extract_pr_urls_none():
    assert extract_pr_urls("no links here") == []


# --- check_schedule ---


def test_check_schedule_matches_window():
    now = datetime(2026, 7, 31, 9, 0, 30)  # Friday 9:00:30
    assert check_schedule("0 9 * * 1-5", now=now) is True


def test_check_schedule_outside_window():
    now = datetime(2026, 7, 31, 10, 0, 0)  # Friday 10:00
    assert check_schedule("0 9 * * 1-5", now=now) is False


def test_check_schedule_weekend():
    now = datetime(2026, 8, 1, 9, 0, 0)  # Saturday
    assert check_schedule("0 9 * * 1-5", now=now) is False


# --- desired_reaction_from_gh (emoji state machine) ---


def test_gh_open_no_decision_eyes():
    assert desired_reaction_from_gh({"state": "OPEN", "reviewDecision": "REVIEW_REQUIRED"}) == "eyes"


def test_gh_approved_lgtm():
    assert desired_reaction_from_gh({"state": "OPEN", "reviewDecision": "APPROVED"}) == "lgtm-5363"


def test_gh_changes_requested():
    assert desired_reaction_from_gh({"state": "OPEN", "reviewDecision": "CHANGES_REQUESTED"}) == "changes_requested"


def test_gh_merged():
    assert desired_reaction_from_gh({"state": "MERGED"}) == "merged2"


def test_gh_closed_clears():
    assert desired_reaction_from_gh({"state": "CLOSED"}) is None


# --- desired_reaction_from_gl ---


def test_gl_open_eyes():
    assert desired_reaction_from_gl({"state": "opened"}) == "eyes"


def test_gl_approved_lgtm():
    assert desired_reaction_from_gl({"state": "opened", "approved": True}) == "lgtm-5363"


def test_gl_blocking_discussions_changes():
    mr = {"state": "opened", "blocking_discussions_resolved": False}
    assert desired_reaction_from_gl(mr) == "changes_requested"


def test_gl_merged():
    assert desired_reaction_from_gl({"state": "merged"}) == "merged2"


def test_gl_closed_clears():
    assert desired_reaction_from_gl({"state": "closed"}) is None


# --- sync_reaction ---


@pytest.fixture
def mock_reactions():
    with patch("slack_pr_reactions._reactions_add") as add, patch("slack_pr_reactions._reactions_remove") as remove:
        add.return_value = True
        remove.return_value = True
        yield add, remove


@pytest.fixture
def mock_conflict():
    with patch("slack_pr_reactions.comment_conflict") as conflict:
        yield conflict


def test_sync_adds_desired_reaction(mock_reactions, mock_conflict):
    add, remove = mock_reactions
    sync_reaction("token", "C1", "123.456", "100.000", [], "eyes", "BOT")
    add.assert_called_once_with("token", "C1", "123.456", "eyes")
    remove.assert_not_called()
    mock_conflict.assert_not_called()


def test_sync_removes_old_bot_reaction_before_add(mock_reactions, mock_conflict):
    add, remove = mock_reactions
    current = [{"name": "eyes", "users": ["BOT"]}]
    sync_reaction("token", "C1", "123.456", "100.000", current, "lgtm-5363", "BOT")
    remove.assert_called_once_with("token", "C1", "123.456", "eyes")
    add.assert_called_once_with("token", "C1", "123.456", "lgtm-5363")


def test_sync_closed_removes_bot_status(mock_reactions, mock_conflict):
    add, remove = mock_reactions
    current = [{"name": "eyes", "users": ["BOT"]}, {"name": "jira-blocker", "users": ["HUMAN"]}]
    sync_reaction("token", "C1", "123.456", "100.000", current, None, "BOT")
    remove.assert_called_once_with("token", "C1", "123.456", "eyes")
    add.assert_not_called()


def test_sync_human_conflict_posts_comment(mock_reactions, mock_conflict):
    add, remove = mock_reactions
    current = [{"name": "lgtm-5363", "users": ["HUMAN"]}]
    sync_reaction("token", "C1", "123.456", "100.000", current, "eyes", "BOT")
    add.assert_called_once()
    mock_conflict.assert_called_once_with("token", "C1", "100.000", "123.456", "lgtm-5363", "eyes")


def test_sync_skips_jira_blocker(mock_reactions, mock_conflict):
    add, remove = mock_reactions
    current = [{"name": "jira-blocker", "users": ["HUMAN"]}]
    sync_reaction("token", "C1", "123.456", "100.000", current, "eyes", "BOT")
    add.assert_called_once()
    remove.assert_not_called()


# --- Slack API mocks ---


def test_find_open_prs_thread_match():
    history = {
        "ok": True,
        "messages": [
            {"text": "Random", "ts": "1.0"},
            {"text": "Open PRs for this week", "ts": "2.0", "user": "U1"},
        ],
    }
    with patch("slack_pr_reactions._slack_request", return_value=history):
        ts = find_open_prs_thread("token", "C1", "open prs")
    assert ts == "2.0"


def test_find_open_prs_thread_poster_filter():
    history = {
        "ok": True,
        "messages": [
            {"text": "Open PRs", "ts": "1.0", "user": "U_WRONG"},
            {"text": "Open PRs", "ts": "2.0", "user": "U_RIGHT"},
        ],
    }
    with patch("slack_pr_reactions._slack_request", return_value=history):
        ts = find_open_prs_thread("token", "C1", "open prs", poster="U_RIGHT")
    assert ts == "2.0"


def test_find_open_prs_thread_no_match():
    with patch("slack_pr_reactions._slack_request", return_value={"ok": True, "messages": []}):
        assert find_open_prs_thread("token", "C1", "open prs") is None


def test_get_thread_replies():
    data = {"ok": True, "messages": [{"text": "parent", "ts": "1.0"}, {"text": "reply", "ts": "1.1"}]}
    with patch("slack_pr_reactions._slack_request", return_value=data):
        replies = get_thread_replies("token", "C1", "1.0")
    assert len(replies) == 2


# --- GH/GL CLI mocks ---


def test_check_pr_status_github_success():
    gh_json = json.dumps({"state": "OPEN", "reviewDecision": "APPROVED"})
    with patch("subprocess.run") as run:
        run.return_value.returncode = 0
        run.return_value.stdout = gh_json
        desired, ok = check_pr_status("github", "org/repo", 1)
    assert ok is True
    assert desired == "lgtm-5363"


def test_check_pr_status_github_error():
    with patch("subprocess.run") as run:
        run.return_value.returncode = 1
        run.return_value.stderr = "not found"
        desired, ok = check_pr_status("github", "org/repo", 1)
    assert ok is False
    assert desired is None


def test_check_pr_status_gitlab_success():
    gl_json = json.dumps({"state": "merged"})
    with patch("subprocess.run") as run:
        run.return_value.returncode = 0
        run.return_value.stdout = gl_json
        desired, ok = check_pr_status("gitlab", "team/proj", 5)
    assert ok is True
    assert desired == "merged2"


def test_check_pr_status_gitlab_error():
    with patch("subprocess.run") as run:
        run.return_value.returncode = 1
        run.return_value.stderr = "404"
        desired, ok = check_pr_status("gitlab", "team/proj", 5)
    assert ok is False


# --- process_thread ---


def test_process_thread_syncs_pr_messages():
    replies = [
        {"text": "header", "ts": "1.0"},
        {"text": "https://github.com/o/r/pull/10", "ts": "1.1"},
    ]
    with (
        patch("slack_pr_reactions.get_thread_replies", return_value=replies),
        patch("slack_pr_reactions.check_pr_status", return_value=("eyes", True)),
        patch("slack_pr_reactions.get_reactions", return_value=[]),
        patch("slack_pr_reactions.sync_reaction") as sync,
    ):
        count = process_thread("token", "C1", "1.0", "BOT")
    assert count == 1
    sync.assert_called_once()


# --- run() ---


def test_run_missing_env(capsys, monkeypatch):
    monkeypatch.delenv("SLACK_USER_TOKEN", raising=False)
    monkeypatch.delenv("SLACK_OPEN_PRS_CHANNEL", raising=False)
    run()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "skip"
    assert "missing" in out["content"]


def test_run_outside_schedule(capsys, monkeypatch):
    monkeypatch.setenv("SLACK_USER_TOKEN", "x")
    monkeypatch.setenv("SLACK_OPEN_PRS_CHANNEL", "C1")
    monkeypatch.setenv("SLACK_OPEN_PRS_SCHEDULE", "0 9 * * 1-5")
    with patch("slack_pr_reactions.check_schedule", return_value=False):
        run()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "skip"
    assert "outside schedule" in out["content"]


def test_run_happy_path(capsys, monkeypatch):
    monkeypatch.setenv("SLACK_USER_TOKEN", "x")
    monkeypatch.setenv("SLACK_OPEN_PRS_CHANNEL", "C1")
    with (
        patch("slack_pr_reactions.check_schedule", return_value=True),
        patch("slack_pr_reactions.get_bot_user_id", return_value="BOT"),
        patch("slack_pr_reactions.find_open_prs_thread", return_value="1.0"),
        patch("slack_pr_reactions.process_thread", return_value=3),
    ):
        run()
    out = json.loads(capsys.readouterr().out.strip())
    assert out["status"] == "skip"
    assert "synced 3" in out["content"]
