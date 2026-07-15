"""Tests for preflight shared modules (presets/shared/preflight/)."""

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

SHARED_DIR = Path(__file__).resolve().parent.parent.parent / "presets" / "shared" / "preflight"
sys.path.insert(0, str(SHARED_DIR))

from common import (  # noqa: E402
    build_repo_lookup,
    fmt_comments,
    is_bot_author,
    upstream_repo,
)
from gh_pr_status import classify_gh, has_new_feedback  # noqa: E402
from gl_mr_status import classify_gl  # noqa: E402
from gl_mr_status import has_new_feedback as gl_has_new_feedback  # noqa: E402


# --- upstream_repo ---


def test_upstream_repo_qualified_github():
    path, host = upstream_repo("project-kessel/inventory-api")
    assert path == "project-kessel/inventory-api"
    assert host == "github"


def test_upstream_repo_qualified_gitlab():
    path, host = upstream_repo("gitlab.cee.redhat.com/some/repo")
    assert path == "gitlab.cee.redhat.com/some/repo"
    assert host == "gitlab"


def test_upstream_repo_bare_not_found():
    with patch("common.load_project_repos", return_value={}):
        path, host = upstream_repo("nonexistent")
    assert path == ""
    assert host == "github"


def test_upstream_repo_bare_github():
    repos = {"my-repo": {"upstream": "https://github.com/org/my-repo.git"}}
    with patch("common.load_project_repos", return_value=repos):
        path, host = upstream_repo("my-repo")
    assert path == "org/my-repo"
    assert host == "github"


def test_upstream_repo_bare_gitlab():
    repos = {"my-repo": {"upstream": "https://gitlab.cee.redhat.com/team/my-repo.git"}}
    with patch("common.load_project_repos", return_value=repos):
        path, host = upstream_repo("my-repo")
    assert path == "team/my-repo"
    assert host == "gitlab"


# --- build_repo_lookup ---


def test_build_repo_lookup():
    repos = {
        "chrome": {"upstream": "https://github.com/RedHatInsights/insights-chrome.git"},
        "rbac": {"upstream": "https://gitlab.cee.redhat.com/team/rbac-service.git"},
    }
    lookup = build_repo_lookup(repos)
    assert lookup["chrome"] == "chrome"
    assert lookup["RedHatInsights/insights-chrome"] == "chrome"
    assert lookup["rbac"] == "rbac"
    assert lookup["team/rbac-service"] == "rbac"


def test_build_repo_lookup_no_upstream():
    repos = {"simple": {}}
    lookup = build_repo_lookup(repos)
    assert lookup["simple"] == "simple"
    assert len(lookup) == 1


# --- is_bot_author ---


def test_is_bot_author_known_bots():
    assert is_bot_author("dependabot") is True
    assert is_bot_author("renovate") is True
    assert is_bot_author("github-actions") is True
    assert is_bot_author("my-app[bot]") is True
    assert is_bot_author("coderabbit-bot") is True


def test_is_bot_author_humans():
    assert is_bot_author("florkbr") is False
    assert is_bot_author("martin") is False
    assert is_bot_author("") is False
    assert is_bot_author("?") is False
    assert is_bot_author(None) is False


# --- fmt_comments ---


def test_fmt_comments_empty():
    assert fmt_comments([], "test") == "  test: (none)"


def test_fmt_comments_since_filter():
    comments = [
        {"a": "alice", "t": "2026-06-30T10:00", "b": "old"},
        {"a": "bob", "t": "2026-07-01T10:00", "b": "new"},
    ]
    result = fmt_comments(comments, "test", since="2026-06-30T12:00")
    assert "bob" in result
    assert "old" not in result


def test_fmt_comments_all_filtered():
    comments = [{"a": "alice", "t": "2026-06-30T10:00", "b": "old"}]
    result = fmt_comments(comments, "test", since="2026-07-01T00:00")
    assert "none since last_addressed" in result


def test_fmt_comments_truncation():
    comments = [{"a": f"user{i}", "t": f"2026-07-01T{i:02d}:00", "b": f"msg {i}"} for i in range(40)]
    result = fmt_comments(comments, "test", max_comments=10)
    assert "truncated" in result
    assert "showing 10" in result


def test_fmt_comments_no_truncation():
    comments = [{"a": "alice", "t": "2026-07-01T10:00", "b": "hi"}]
    result = fmt_comments(comments, "test", max_comments=30)
    assert "truncated" not in result


# --- classify_gh ---


def test_classify_gh_merged():
    state, issues = classify_gh({"state": "MERGED"})
    assert state == "MERGED"
    assert "merged" in issues


def test_classify_gh_open_clean():
    state, issues = classify_gh({"state": "OPEN", "mergeable": "MERGEABLE"})
    assert state == "OPEN"
    assert issues == []


def test_classify_gh_conflicting():
    state, issues = classify_gh({"state": "OPEN", "mergeable": "CONFLICTING"})
    assert "conflict" in issues


def test_classify_gh_ci_failure():
    pr = {
        "state": "OPEN",
        "statusCheckRollup": [
            {"name": "lint", "conclusion": "SUCCESS"},
            {"name": "test", "conclusion": "FAILURE"},
        ],
    }
    state, issues = classify_gh(pr)
    assert any("ci_fail" in i for i in issues)
    assert "test" in issues[0]


def test_classify_gh_changes_requested():
    pr = {"state": "OPEN", "reviewDecision": "CHANGES_REQUESTED"}
    state, issues = classify_gh(pr)
    assert "changes_requested" in issues


def test_classify_gh_review_comment():
    pr = {
        "state": "OPEN",
        "reviews": [
            {
                "state": "COMMENTED",
                "body": "This is a substantive review comment that is long enough",
                "author": {"login": "reviewer"},
            },
        ],
    }
    state, issues = classify_gh(pr)
    assert any("review_comment" in i for i in issues)


def test_review_comment_not_unconditional_feedback():
    """review_comment: should NOT trigger unconditional feedback bucketing.

    It must fall through to has_new_feedback() which checks timestamps and bot authors.
    """
    issues = ["review_comment:coderabbitai[bot]"]
    unconditional = any(i in ("changes_requested",) or i.startswith("review:") for i in issues)
    assert unconditional is False, "review_comment: must not match unconditional feedback check"


def test_review_comment_bot_old_is_clean():
    """PR with only an old bot review_comment should be CLEAN, not FEEDBACK."""
    enriched = {
        "task": {"last_addressed": "2026-07-01T10:00"},
        "issues": ["review_comment:coderabbitai[bot]"],
        "pr_comments": [{"a": "coderabbitai[bot]", "t": "2026-07-01T08:00", "b": "auto review"}],
        "prs": [],
    }
    issues = enriched["issues"]
    unconditional = any(i in ("changes_requested",) or i.startswith("review:") for i in issues)
    assert unconditional is False
    assert has_new_feedback(enriched) is False


def test_review_comment_human_new_is_feedback():
    """PR with a new human review_comment should be FEEDBACK via has_new_feedback."""
    enriched = {
        "task": {"last_addressed": "2026-06-30T10:00"},
        "issues": ["review_comment:reviewer"],
        "pr_comments": [{"a": "reviewer", "t": "2026-07-01T10:00", "b": "please fix this"}],
        "prs": [],
    }
    issues = enriched["issues"]
    unconditional = any(i in ("changes_requested",) or i.startswith("review:") for i in issues)
    assert unconditional is False
    assert has_new_feedback(enriched) is True


def test_changes_requested_still_unconditional():
    """changes_requested and review: should still be unconditional feedback."""
    for issue in ["changes_requested", "review:someuser"]:
        unconditional = any(i in ("changes_requested",) or i.startswith("review:") for i in [issue])
        assert unconditional is True, f"{issue} should be unconditional feedback"


# --- CI-only skip (bucket classification) ---


def _make_ci_enriched(last_addressed=None, extra_issues=None, pr_comments=None):
    """Helper to build enriched dicts for CI bucket tests."""
    issues = ["ci_fail:lint,test"]
    if extra_issues:
        issues.extend(extra_issues)
    return {
        "task": {
            "external_key": "TEST-1",
            "status": "pr_open",
            "repo": "test-repo",
            **({"last_addressed": last_addressed} if last_addressed else {}),
        },
        "prs": [{"repo": "test-repo", "num": 1, "host": "github", "state": "OPEN", "issues": issues, "data": {}}],
        "pr_comments": pr_comments or [],
        "issues": issues,
    }


def _classify_bucket(enriched_list):
    """Reproduce the bucket classification from main() for testing."""
    merged, closed, ci_fail, conflict, feedback, clean = [], [], [], [], [], []
    for e in enriched_list:
        issues = e["issues"]
        if "merged" in issues:
            merged.append(e)
        elif "closed" in issues:
            closed.append(e)
        elif any(i.startswith("ci_fail") for i in issues):
            ci_only = all(i.startswith("ci_fail") for i in issues)
            if ci_only and e["task"].get("last_addressed") and not has_new_feedback(e):
                clean.append(e)
            else:
                ci_fail.append(e)
        elif "conflict" in issues:
            conflict.append(e)
        elif any(i in ("changes_requested",) or i.startswith("review:") for i in issues):
            feedback.append(e)
        elif has_new_feedback(e):
            feedback.append(e)
        else:
            clean.append(e)
    return {"ci_fail": ci_fail, "clean": clean, "feedback": feedback}


def test_ci_only_addressed_is_clean():
    """CI-only failure with last_addressed set and no new feedback → clean."""
    e = _make_ci_enriched(last_addressed="2026-07-14T17:49")
    result = _classify_bucket([e])
    assert len(result["clean"]) == 1
    assert len(result["ci_fail"]) == 0


def test_ci_only_no_last_addressed_is_actionable():
    """CI-only failure without last_addressed → still actionable (first encounter)."""
    e = _make_ci_enriched(last_addressed=None)
    result = _classify_bucket([e])
    assert len(result["ci_fail"]) == 1
    assert len(result["clean"]) == 0


def test_ci_plus_conflict_is_actionable():
    """CI failure combined with conflict → actionable even with last_addressed."""
    e = _make_ci_enriched(last_addressed="2026-07-14T17:49", extra_issues=["conflict"])
    result = _classify_bucket([e])
    assert len(result["ci_fail"]) == 1
    assert len(result["clean"]) == 0


def test_ci_only_with_new_feedback_is_actionable():
    """CI-only with last_addressed but new human comment → actionable."""
    e = _make_ci_enriched(
        last_addressed="2026-07-14T10:00",
        pr_comments=[{"a": "reviewer", "t": "2026-07-14T18:00", "b": "can you retry CI?"}],
    )
    result = _classify_bucket([e])
    assert len(result["ci_fail"]) == 1
    assert len(result["clean"]) == 0


def test_ci_only_with_old_feedback_is_clean():
    """CI-only with last_addressed after the last comment → clean."""
    e = _make_ci_enriched(
        last_addressed="2026-07-14T18:00",
        pr_comments=[{"a": "reviewer", "t": "2026-07-14T10:00", "b": "can you retry CI?"}],
    )
    result = _classify_bucket([e])
    assert len(result["clean"]) == 1
    assert len(result["ci_fail"]) == 0


# --- classify_gl ---


def test_classify_gl_merged():
    state, issues = classify_gl({"state": "merged"})
    assert state == "MERGED"
    assert "merged" in issues


def test_classify_gl_open_clean():
    state, issues = classify_gl({"state": "opened", "has_conflicts": False, "blocking_discussions_resolved": True})
    assert state == "OPENED"
    assert issues == []


def test_classify_gl_conflicts():
    state, issues = classify_gl({"state": "opened", "has_conflicts": True})
    assert "conflict" in issues


def test_classify_gl_ci_fail():
    mr = {"state": "opened", "head_pipeline": {"status": "failed"}}
    state, issues = classify_gl(mr)
    assert "ci_fail" in issues


def test_classify_gl_unresolved_threads():
    mr = {"state": "opened", "blocking_discussions_resolved": False}
    state, issues = classify_gl(mr)
    assert "unresolved_threads" in issues


# --- has_new_feedback (GH) ---


def test_gh_has_new_feedback_new_comment():
    enriched = {
        "task": {"last_addressed": "2026-06-30T10:00"},
        "pr_comments": [{"a": "reviewer", "t": "2026-07-01T10:00", "b": "please fix"}],
    }
    assert has_new_feedback(enriched) is True


def test_gh_has_new_feedback_old_comment():
    enriched = {
        "task": {"last_addressed": "2026-07-01T12:00"},
        "pr_comments": [{"a": "reviewer", "t": "2026-07-01T10:00", "b": "please fix"}],
    }
    assert has_new_feedback(enriched) is False


def test_gh_has_new_feedback_bot_ignored():
    enriched = {
        "task": {"last_addressed": "2026-06-30T10:00"},
        "pr_comments": [{"a": "dependabot", "t": "2026-07-01T10:00", "b": "auto update"}],
    }
    assert has_new_feedback(enriched) is False


def test_gh_has_new_feedback_no_last_addressed():
    enriched = {
        "task": {},
        "pr_comments": [{"a": "reviewer", "t": "2026-07-01T10:00", "b": "looks good"}],
    }
    assert has_new_feedback(enriched) is True


def test_gh_has_new_feedback_empty():
    enriched = {"task": {}, "pr_comments": []}
    assert has_new_feedback(enriched) is False


# --- has_new_feedback (GL) ---


def test_gl_has_new_feedback_new_note():
    enriched = {
        "task": {"last_addressed": "2026-06-30T10:00"},
        "mr_notes": [{"a": "reviewer", "t": "2026-07-01T10:00", "b": "needs work"}],
    }
    assert gl_has_new_feedback(enriched) is True


def test_gl_has_new_feedback_old_note():
    enriched = {
        "task": {"last_addressed": "2026-07-01T12:00"},
        "mr_notes": [{"a": "reviewer", "t": "2026-07-01T10:00", "b": "needs work"}],
    }
    assert gl_has_new_feedback(enriched) is False


def test_gl_has_new_feedback_bot_ignored():
    enriched = {
        "task": {"last_addressed": "2026-06-30T10:00"},
        "mr_notes": [{"a": "my-app[bot]", "t": "2026-07-01T10:00", "b": "automated check"}],
    }
    assert gl_has_new_feedback(enriched) is False
