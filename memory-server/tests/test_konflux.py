"""Tests for Konflux build log retrieval tool."""

from bot_memory_server.tools.konflux import (
    _failed_steps,
    _failure_reason,
    _is_failed,
    _parse_details_url,
    _tail,
)

# --- _parse_details_url ---


def test_parse_details_url_valid():
    url = "https://konflux-ui.apps.cluster.example.com/ns/my-tenant/pipelinerun/my-app-on-pull-request-abc12"
    result = _parse_details_url(url)
    assert result == (
        "cluster.example.com",
        "my-tenant",
        "my-app-on-pull-request-abc12",
    )


def test_parse_details_url_invalid():
    assert _parse_details_url("https://example.com/not-a-konflux-url") is None


# --- _is_failed ---


def test_is_failed_true():
    conditions = [{"type": "Succeeded", "status": "False", "reason": "Failed"}]
    assert _is_failed(conditions) is True


def test_is_failed_false():
    assert _is_failed([{"type": "Succeeded", "status": "True"}]) is False
    assert _is_failed([]) is False


# --- _failure_reason ---


def test_failure_reason_with_message():
    conditions = [{"type": "Succeeded", "status": "False", "message": "step failed", "reason": "Failed"}]
    assert _failure_reason(conditions) == "step failed"


def test_failure_reason_no_failure():
    assert _failure_reason([]) == "Unknown"


# --- _failed_steps ---


def test_failed_steps_one_failed():
    steps = [
        {"name": "build", "terminated": {"exitCode": 0}},
        {"name": "push", "terminated": {"exitCode": 1}},
    ]
    result = _failed_steps(steps)
    assert len(result) == 1
    assert result[0] == {"name": "push", "exit_code": 1}


def test_failed_steps_all_ok():
    assert _failed_steps([{"name": "build", "terminated": {"exitCode": 0}}]) == []


# --- _tail ---


def test_tail_short_text():
    assert _tail("line1\nline2\nline3", 10) == "line1\nline2\nline3"


def test_tail_truncates():
    text = "\n".join(f"line{i}" for i in range(10))
    result = _tail(text, 3)
    assert result.startswith("... (7 lines truncated) ...")
    assert "line9" in result
    assert "line0" not in result


# --- classify_gh Konflux URL extraction ---


def test_classify_gh_extracts_konflux_urls():
    import sys
    from pathlib import Path

    shared_dir = Path(__file__).resolve().parent.parent.parent / "presets" / "shared" / "preflight"
    sys.path.insert(0, str(shared_dir))
    from gh_pr_status import classify_gh

    checks = [
        {
            "name": "Red Hat Konflux / my-app-on-pull-request",
            "conclusion": "FAILURE",
            "detailsUrl": "https://konflux-ui.apps.cluster.example.com/ns/my-tenant/pipelinerun/my-app-on-pull-request-abc12",
        }
    ]
    pr = {"state": "OPEN", "mergeable": "MERGEABLE", "reviews": [], "statusCheckRollup": checks}
    state, issues = classify_gh(pr)
    assert any(i.startswith("ci_fail:") for i in issues)
    konflux = [i for i in issues if i.startswith("konflux_urls:")]
    assert len(konflux) == 1
    assert "my-app-on-pull-request-abc12" in konflux[0]


def test_classify_gh_no_konflux_url_for_non_konflux_check():
    import sys
    from pathlib import Path

    shared_dir = Path(__file__).resolve().parent.parent.parent / "presets" / "shared" / "preflight"
    sys.path.insert(0, str(shared_dir))
    from gh_pr_status import classify_gh

    checks = [{"name": "lint", "conclusion": "FAILURE", "detailsUrl": "https://github.com/runs/123"}]
    pr = {"state": "OPEN", "mergeable": "MERGEABLE", "reviews": [], "statusCheckRollup": checks}
    state, issues = classify_gh(pr)
    assert "ci_fail:lint" in issues
    assert not any(i.startswith("konflux_urls:") for i in issues)
