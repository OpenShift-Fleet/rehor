"""Tests for gh_pr_status preflight."""

import sys
from pathlib import Path

SHARED_DIR = Path(__file__).resolve().parent.parent.parent / "presets" / "shared" / "preflight"
sys.path.insert(0, str(SHARED_DIR))

from gh_pr_status import classify_gh

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


def test_security_scan_filtered_from_ci_fail():
    """Security scan checks should not appear in ci_fail issues."""
    checks = [
        {"name": "unit-tests", "conclusion": "FAILURE"},
        {"name": "clair-scan", "conclusion": "FAILURE"},
    ]
    state, issues = classify_gh(_make_pr(checks=checks))
    ci_fail_issues = [i for i in issues if i.startswith("ci_fail:")]
    assert len(ci_fail_issues) == 1
    assert "unit-tests" in ci_fail_issues[0]
    assert "clair-scan" not in ci_fail_issues[0]


def test_security_scan_only_no_ci_fail():
    """When only security scans fail, no ci_fail issue should be raised."""
    checks = [
        {"name": "clair-scan", "conclusion": "FAILURE"},
        {"name": "sast-snyk-check", "conclusion": "FAILURE"},
    ]
    state, issues = classify_gh(_make_pr(checks=checks))
    assert not any(i.startswith("ci_fail:") for i in issues)
    assert any(i.startswith("security_scan_fail:") for i in issues)


def test_security_scan_reported_separately():
    """Filtered security scans should appear as security_scan_fail issues."""
    checks = [
        {"name": "lint", "conclusion": "FAILURE"},
        {"name": "grype-vulnerability-scan", "conclusion": "FAILURE"},
    ]
    state, issues = classify_gh(_make_pr(checks=checks))
    assert "ci_fail:lint" in issues
    sec_issues = [i for i in issues if i.startswith("security_scan_fail:")]
    assert len(sec_issues) == 1
    assert "grype-vulnerability-scan" in sec_issues[0]


def test_no_security_scans_unchanged():
    """When no security scans are present, behavior is unchanged."""
    checks = [{"name": "lint", "conclusion": "FAILURE"}]
    state, issues = classify_gh(_make_pr(checks=checks))
    assert "ci_fail:lint" in issues
    assert not any(i.startswith("security_scan_fail:") for i in issues)


def test_conflict_and_ci_not_affected_by_last_addressed():
    """Conflicts and CI failures are current-state, not affected by last_addressed."""
    checks = [{"name": "lint", "conclusion": "FAILURE"}]
    state, issues = classify_gh(
        _make_pr(mergeable="CONFLICTING", checks=checks), last_addressed="2026-07-03T07:37:00+00:00"
    )
    assert "conflict" in issues
    assert "ci_fail:lint" in issues
