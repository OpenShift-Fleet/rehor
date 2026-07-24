"""Tests for gh_pr_status preflight."""

import sys
from pathlib import Path

SHARED_DIR = Path(__file__).resolve().parent.parent.parent / "presets" / "shared" / "preflight"
sys.path.insert(0, str(SHARED_DIR))

from gh_pr_status import classify_gh  # noqa: E402

# --- classify_gh ---


def _make_pr(state="OPEN", mergeable="MERGEABLE", reviews=None, checks=None, review_decision=None):
    pr = {"state": state, "mergeable": mergeable, "reviews": reviews or [], "statusCheckRollup": checks or []}
    if review_decision:
        pr["reviewDecision"] = review_decision
    return pr


def test_merged():
    state, issues = classify_gh(_make_pr(state="MERGED"))
    assert state == "MERGED"
    assert issues == ["merged"]


def test_closed():
    state, issues = classify_gh(_make_pr(state="CLOSED"))
    assert state == "CLOSED"
    assert issues == ["closed"]


def test_conflict():
    state, issues = classify_gh(_make_pr(mergeable="CONFLICTING"))
    assert "conflict" in issues


def test_ci_failure():
    checks = [{"name": "lint", "conclusion": "FAILURE"}]
    state, issues = classify_gh(_make_pr(checks=checks))
    assert "ci_fail:lint" in issues


def test_changes_requested_review():
    reviews = [{"state": "CHANGES_REQUESTED", "author": {"login": "alice"}, "submittedAt": "2026-07-03T10:00:00Z"}]
    state, issues = classify_gh(_make_pr(reviews=reviews))
    assert "review:alice" in issues


def test_commented_review_with_body():
    reviews = [
        {
            "state": "COMMENTED",
            "author": {"login": "bob"},
            "body": "This needs a much longer explanation of the approach",
            "submittedAt": "2026-07-03T10:00:00Z",
        }
    ]
    state, issues = classify_gh(_make_pr(reviews=reviews))
    assert "review_comment:bob" in issues


def test_commented_review_short_body_ignored():
    reviews = [
        {"state": "COMMENTED", "author": {"login": "bob"}, "body": "LGTM", "submittedAt": "2026-07-03T10:00:00Z"}
    ]
    state, issues = classify_gh(_make_pr(reviews=reviews))
    assert not any(i.startswith("review") for i in issues)


def test_clean_pr():
    state, issues = classify_gh(_make_pr())
    assert state == "OPEN"
    assert issues == []


# --- last_addressed filtering ---


def test_old_review_before_last_addressed_ignored():
    """Reviews submitted before last_addressed should not trigger FEEDBACK."""
    reviews = [
        {
            "state": "CHANGES_REQUESTED",
            "author": {"login": "coderabbitai"},
            "submittedAt": "2026-06-30T10:00:00Z",
        }
    ]
    state, issues = classify_gh(_make_pr(reviews=reviews), last_addressed="2026-07-03T07:37:00+00:00")
    assert "review:coderabbitai" not in issues
    assert issues == []


def test_new_review_after_last_addressed_kept():
    """Reviews submitted after last_addressed should still trigger."""
    reviews = [{"state": "CHANGES_REQUESTED", "author": {"login": "alice"}, "submittedAt": "2026-07-03T09:00:00Z"}]
    state, issues = classify_gh(_make_pr(reviews=reviews), last_addressed="2026-07-03T07:37:00+00:00")
    assert "review:alice" in issues


def test_no_last_addressed_keeps_all_reviews():
    """Without last_addressed, all reviews should be considered."""
    reviews = [{"state": "CHANGES_REQUESTED", "author": {"login": "alice"}, "submittedAt": "2026-06-20T10:00:00Z"}]
    state, issues = classify_gh(_make_pr(reviews=reviews), last_addressed="")
    assert "review:alice" in issues


def test_mixed_old_and_new_reviews():
    """Only new reviews should trigger, old ones filtered out."""
    reviews = [
        {
            "state": "CHANGES_REQUESTED",
            "author": {"login": "coderabbitai"},
            "submittedAt": "2026-06-28T10:00:00Z",
        },
        {"state": "CHANGES_REQUESTED", "author": {"login": "alice"}, "submittedAt": "2026-07-03T09:00:00Z"},
    ]
    state, issues = classify_gh(_make_pr(reviews=reviews), last_addressed="2026-07-03T07:37:00+00:00")
    assert "review:coderabbitai" not in issues
    assert "review:alice" in issues


def test_review_at_exact_last_addressed_ignored():
    """Review at exactly last_addressed timestamp should be ignored (already seen)."""
    reviews = [{"state": "CHANGES_REQUESTED", "author": {"login": "alice"}, "submittedAt": "2026-07-03T07:37:00Z"}]
    state, issues = classify_gh(_make_pr(reviews=reviews), last_addressed="2026-07-03T07:37:00+00:00")
    assert "review:alice" not in issues


def test_conflict_and_ci_not_affected_by_last_addressed():
    """Conflicts and CI failures are current-state, not affected by last_addressed."""
    checks = [{"name": "lint", "conclusion": "FAILURE"}]
    state, issues = classify_gh(
        _make_pr(mergeable="CONFLICTING", checks=checks), last_addressed="2026-07-03T07:37:00+00:00"
    )
    assert "conflict" in issues
    assert "ci_fail:lint" in issues
