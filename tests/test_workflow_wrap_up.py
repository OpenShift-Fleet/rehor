"""Workflow archival uses staged MCP outcomes and fails before cleanup."""

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock, Mock, call

import pytest

ROOT = Path(__file__).resolve().parents[1]
JIRA_KEY = "TEST-123"


@pytest.fixture(params=["jira-sprint", "jira-kanban"])
def wrap_up(request, monkeypatch):
    """Load each deployed skill with isolated MCP imports and mocked IO."""
    jira_mcp = ModuleType("jira_mcp")
    monkeypatch.setattr(
        jira_mcp,
        "jira_call",
        Mock(side_effect=[{"transitions": [{"id": "31", "name": "Release Pending"}]}, {}, {}]),
        raising=False,
    )
    memory_mcp = ModuleType("memory_mcp")
    monkeypatch.setattr(
        memory_mcp,
        "memory_call",
        Mock(return_value={"status": "archived", "outcome": {"decision": "inconclusive"}}),
        raising=False,
    )
    monkeypatch.setitem(sys.modules, "jira_mcp", jira_mcp)
    monkeypatch.setitem(sys.modules, "memory_mcp", memory_mcp)
    monkeypatch.setattr(sys, "path", sys.path.copy())
    path = ROOT / "presets" / "workflows" / request.param / "skills" / "wrap-up" / "wrap_up.py"
    spec = importlib.util.spec_from_file_location(f"wrap_up_{request.param.replace('-', '_')}", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    task = {
        "external_key": JIRA_KEY,
        "repo": "example",
        "branch": f"bot/{JIRA_KEY}",
        "summary": "Verified merged change",
        "metadata": {"prs": [{"repo": "example", "number": 42, "url": "https://example.test/pr/42", "host": "github"}]},
    }
    monkeypatch.setattr(module, "http_request", Mock(return_value={"items": [task]}))
    monkeypatch.setattr(module, "get_upstream_info", Mock(return_value=("org/example", "github")))
    cleanup_names = ("slack_notify", "delete_remote_branch", "delete_local_branch")
    monkeypatch.setattr(
        module, "_cleanup_helpers", {name: getattr(module, name) for name in cleanup_names}, raising=False
    )
    for name in cleanup_names:
        monkeypatch.setattr(module, name, Mock(return_value=(True, "OK")))
    monkeypatch.setattr(module.urllib.request, "urlopen", Mock(side_effect=AssertionError("Unexpected network IO")))
    monkeypatch.setattr(module.subprocess, "run", Mock(side_effect=AssertionError("Unexpected subprocess")))
    monkeypatch.setattr(sys, "argv", [str(path), JIRA_KEY])
    return module


def test_archive_calls_only_mcp_task_remove(wrap_up):
    # Empty JSON is still a successful MCP response, consistent with the client.
    wrap_up.memory_call.return_value = {}

    assert wrap_up.archive_task(JIRA_KEY, "summary") is True

    wrap_up.memory_call.assert_called_once_with("task_remove", {"external_key": JIRA_KEY, "source_type": "jira"})
    wrap_up.http_request.assert_not_called()


def test_archive_propagates_mcp_error_as_failure(wrap_up):
    # bot/memory_mcp.py returns None for MCP isError and transport failures.
    wrap_up.memory_call.return_value = None

    assert wrap_up.archive_task(JIRA_KEY, "summary") is False

    wrap_up.http_request.assert_not_called()


def test_successful_wrap_up_keeps_cleanup_behavior(wrap_up, capsys):
    wrap_up.main()

    wrap_up.memory_call.assert_called_once_with("task_remove", {"external_key": JIRA_KEY, "source_type": "jira"})
    wrap_up.http_request.assert_called_once_with(f"{wrap_up.MEMORY_URL}/api/tasks?exclude_status=archived&limit=50")
    assert wrap_up.jira_call.call_count == 3
    wrap_up.slack_notify.assert_called_once()
    wrap_up.delete_remote_branch.assert_called_once_with("example", f"bot/{JIRA_KEY}", "github", "org/example")
    wrap_up.delete_local_branch.assert_called_once_with("example", f"bot/{JIRA_KEY}")
    assert f"DONE — {JIRA_KEY} wrapped up" in capsys.readouterr().out


def test_archive_failure_exits_before_slack_and_branch_cleanup(wrap_up, capsys):
    wrap_up.memory_call.return_value = None

    with pytest.raises(SystemExit) as exc:
        wrap_up.main()

    assert exc.value.code == 1
    assert wrap_up.jira_call.call_count == 3  # Existing Jira steps precede archival.
    wrap_up.memory_call.assert_called_once_with("task_remove", {"external_key": JIRA_KEY, "source_type": "jira"})
    wrap_up.http_request.assert_called_once_with(f"{wrap_up.MEMORY_URL}/api/tasks?exclude_status=archived&limit=50")
    wrap_up.slack_notify.assert_not_called()
    wrap_up.delete_remote_branch.assert_not_called()
    wrap_up.delete_local_branch.assert_not_called()
    output = capsys.readouterr()
    assert "DONE" not in output.out
    assert "task_outcome_report" in output.err


def test_dry_run_does_not_mutate_providers_or_stage_report(wrap_up, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["wrap_up.py", JIRA_KEY, "--dry-run"])

    wrap_up.main()

    # Preview retains the read-only task lookup, but makes no mutating calls.
    wrap_up.http_request.assert_called_once_with(f"{wrap_up.MEMORY_URL}/api/tasks?exclude_status=archived&limit=50")
    wrap_up.jira_call.assert_not_called()
    wrap_up.memory_call.assert_not_called()
    wrap_up.slack_notify.assert_not_called()
    wrap_up.delete_remote_branch.assert_not_called()
    wrap_up.delete_local_branch.assert_not_called()
    wrap_up.urllib.request.urlopen.assert_not_called()
    wrap_up.subprocess.run.assert_not_called()
    assert "[DRY RUN]" in capsys.readouterr().out


@pytest.fixture
def recovery(wrap_up, monkeypatch):
    """Reported archive from task_get plus guarded idempotent task_remove."""
    task = {
        **wrap_up.http_request.return_value["items"][0],
        "source_type": "jira",
        "status": "archived",
    }
    reported = {**task, "outcome": {"id": 7, "decision": "inconclusive"}}
    wrap_up.memory_call.side_effect = [task, reported]
    monkeypatch.setattr(sys, "argv", ["wrap_up.py", JIRA_KEY, "--resume-cleanup"])
    return wrap_up, task, reported


@pytest.mark.parametrize("decision", ["accepted", "rejected", "inconclusive", "obsolete"])
def test_resume_verifies_report_before_cleanup_without_repeating_jira(recovery, decision, capsys):
    wrap_up, _, reported = recovery
    reported["outcome"]["decision"] = decision
    operations = Mock()
    for name in ("memory_call", "jira_call", "slack_notify", "delete_remote_branch", "delete_local_branch"):
        operations.attach_mock(getattr(wrap_up, name), name)

    wrap_up.main()

    assert operations.mock_calls == [
        call.memory_call("task_get", {"external_key": JIRA_KEY, "source_type": "jira"}),
        call.memory_call("task_remove", {"external_key": JIRA_KEY, "source_type": "jira"}),
        call.slack_notify(JIRA_KEY, reported["metadata"]["prs"]),
        call.delete_remote_branch("example", f"bot/{JIRA_KEY}", "github", "org/example"),
        call.delete_local_branch("example", f"bot/{JIRA_KEY}"),
    ]
    wrap_up.http_request.assert_not_called()
    assert "DONE" in capsys.readouterr().out


def test_failed_archive_can_recover_via_report_archive_then_resume(recovery, monkeypatch, capsys):
    wrap_up, archived, reported = recovery
    args = {"external_key": JIRA_KEY, "source_type": "jira"}
    report = {
        **args,
        "artifacts": [{"type": "github_pr", "url": "https://example.test/pr/42"}],
        "evidence": [
            {
                "source": "github",
                "reference": "https://example.test/pr/42",
                "resolution": "accepted",
                "disposition": "MERGED",
                "reason": "Verified provider input confirms merge.",
            }
        ],
        "notes": None,
    }
    wrap_up.memory_call.side_effect = [None, {}, reported, archived, reported]
    monkeypatch.setattr(sys, "argv", ["wrap_up.py", JIRA_KEY])
    with pytest.raises(SystemExit, match="1"):
        wrap_up.main()
    assert "DONE" not in capsys.readouterr().out
    wrap_up.slack_notify.assert_not_called()

    # Agent stages provider evidence and retries only the failed archive step.
    wrap_up.memory_call("task_outcome_report", report)
    wrap_up.memory_call("task_remove", args)
    monkeypatch.setattr(sys, "argv", ["wrap_up.py", JIRA_KEY, "--resume-cleanup"])
    wrap_up.main()

    assert wrap_up.memory_call.call_args_list == [
        call("task_remove", args),
        call("task_outcome_report", report),
        call("task_remove", args),
        call("task_get", args),
        call("task_remove", args),
    ]
    assert wrap_up.jira_call.call_count == 3  # First attempt only.
    wrap_up.slack_notify.assert_called_once()
    wrap_up.delete_remote_branch.assert_called_once()
    wrap_up.delete_local_branch.assert_called_once()


@pytest.mark.parametrize(
    "invalid",
    [
        None,
        {},
        {"status": "pr_open"},
        {"external_key": "OTHER-123"},
        {"source_type": "github"},
        {"metadata": []},
        {"metadata": {"prs": ["corrupt"]}},
        {"metadata": {"repos": "corrupt"}},
        {"branch": ["corrupt"]},
        {"branch": None},
        {"branch": ""},
    ],
)
def test_resume_rejects_missing_or_corrupt_task_before_guard_and_cleanup(recovery, invalid, capsys):
    wrap_up, task, _ = recovery
    response = None if invalid is None else ({**task, **invalid} if invalid else {})
    wrap_up.memory_call.side_effect = [response]

    with pytest.raises(SystemExit) as exc:
        wrap_up.main()

    assert exc.value.code == 1
    wrap_up.memory_call.assert_called_once_with("task_get", {"external_key": JIRA_KEY, "source_type": "jira"})
    wrap_up.jira_call.assert_not_called()
    wrap_up.slack_notify.assert_not_called()
    wrap_up.delete_remote_branch.assert_not_called()
    wrap_up.delete_local_branch.assert_not_called()
    assert "DONE" not in capsys.readouterr().out


@pytest.mark.parametrize(
    "invalid",
    [
        None,  # MCP guard denies an unreported archive or missing selected report.
        {},
        {"status": "done"},
        {"external_key": "OTHER-123"},
        {"source_type": "github"},
        {"outcome": None},
        {"outcome": {"decision": "accepted"}},  # No persisted report identity.
        {"outcome": {"id": 0, "decision": "accepted"}},
        {"outcome": {"id": 7, "decision": "unreported"}},
        {"outcome": {"id": 7, "decision": []}},
    ],
)
def test_resume_blocks_cleanup_when_report_guard_fails_or_response_corrupt(recovery, invalid, capsys):
    wrap_up, task, reported = recovery
    response = None if invalid is None else ({**reported, **invalid} if invalid else {})
    wrap_up.memory_call.side_effect = [task, response]

    with pytest.raises(SystemExit) as exc:
        wrap_up.main()

    assert exc.value.code == 1
    assert wrap_up.memory_call.call_args_list == [
        call("task_get", {"external_key": JIRA_KEY, "source_type": "jira"}),
        call("task_remove", {"external_key": JIRA_KEY, "source_type": "jira"}),
    ]
    wrap_up.jira_call.assert_not_called()
    wrap_up.slack_notify.assert_not_called()
    wrap_up.delete_remote_branch.assert_not_called()
    wrap_up.delete_local_branch.assert_not_called()
    output = capsys.readouterr()
    assert "DONE" not in output.out
    assert "ignore DONE" in output.err[:200]
    assert "task_outcome_report" in output.err[:200]


def test_resume_dry_run_reads_task_but_never_archives_or_cleans(recovery, monkeypatch, capsys):
    wrap_up, task, _ = recovery
    wrap_up.memory_call.side_effect = [task]
    monkeypatch.setattr(sys, "argv", ["wrap_up.py", JIRA_KEY, "--resume-cleanup", "--dry-run"])

    wrap_up.main()

    wrap_up.memory_call.assert_called_once_with("task_get", {"external_key": JIRA_KEY, "source_type": "jira"})
    wrap_up.http_request.assert_not_called()
    wrap_up.jira_call.assert_not_called()
    wrap_up.slack_notify.assert_not_called()
    wrap_up.delete_remote_branch.assert_not_called()
    wrap_up.delete_local_branch.assert_not_called()
    wrap_up.urllib.request.urlopen.assert_not_called()
    wrap_up.subprocess.run.assert_not_called()
    assert "report guard runs only without --dry-run" in capsys.readouterr().out


def test_resume_skip_slack_avoids_duplicate_notification(recovery, monkeypatch):
    wrap_up, _, _ = recovery
    monkeypatch.setattr(sys, "argv", ["wrap_up.py", JIRA_KEY, "--resume-cleanup", "--skip-slack"])

    wrap_up.main()

    wrap_up.slack_notify.assert_not_called()
    wrap_up.jira_call.assert_not_called()
    wrap_up.delete_remote_branch.assert_called_once()
    wrap_up.delete_local_branch.assert_called_once()


def test_skip_slack_requires_recovery_mode(wrap_up, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["wrap_up.py", JIRA_KEY, "--skip-slack"])

    with pytest.raises(SystemExit) as exc:
        wrap_up.main()

    assert exc.value.code == 2
    wrap_up.http_request.assert_not_called()
    wrap_up.memory_call.assert_not_called()
    wrap_up.jira_call.assert_not_called()


@pytest.mark.parametrize("resume", [False, True], ids=["normal", "resume"])
@pytest.mark.parametrize(
    ("helper", "pending"),
    [
        ("slack_notify", "Slack notification"),
        ("delete_remote_branch", "remote branch deletion [example]"),
        ("delete_local_branch", "local branch deletion [example]"),
    ],
)
def test_cleanup_failure_returns_nonzero_with_pending_step_and_retry_guidance(
    recovery, monkeypatch, capsys, resume, helper, pending
):
    wrap_up, _, reported = recovery
    if not resume:
        monkeypatch.setattr(sys, "argv", ["wrap_up.py", JIRA_KEY])
        wrap_up.memory_call.side_effect = None
        wrap_up.memory_call.return_value = reported
    getattr(wrap_up, helper).return_value = (False, "delivery/API/current branch failure")

    with pytest.raises(SystemExit) as exc:
        wrap_up.main()

    assert exc.value.code == 1
    output = capsys.readouterr()
    assert "DONE" not in output.out
    assert f"pending steps: {pending}" in output.err
    assert "--resume-cleanup" in output.err
    assert "Do not rerun the full skill" in output.err
    assert ("--skip-slack" in output.err) == (helper != "slack_notify")
    # Other cleanup still runs best-effort; Jira runs only on the first attempt.
    assert wrap_up.jira_call.call_count == (0 if resume else 3)
    wrap_up.slack_notify.assert_called_once()
    wrap_up.delete_remote_branch.assert_called_once()
    wrap_up.delete_local_branch.assert_called_once()


@pytest.mark.parametrize("resume", [False, True], ids=["normal", "resume"])
def test_missing_upstream_for_tracked_branch_blocks_completion(recovery, monkeypatch, capsys, resume):
    wrap_up, _, reported = recovery
    if not resume:
        monkeypatch.setattr(sys, "argv", ["wrap_up.py", JIRA_KEY])
        wrap_up.memory_call.side_effect = None
        wrap_up.memory_call.return_value = reported
    wrap_up.get_upstream_info.return_value = ("", "github")

    with pytest.raises(SystemExit) as exc:
        wrap_up.main()

    assert exc.value.code == 1
    output = capsys.readouterr()
    assert "DONE" not in output.out
    assert f"example: FAIL: cannot resolve upstream for remote branch bot/{JIRA_KEY}" in output.out
    assert "pending steps: remote branch deletion [example]" in output.err
    assert "--resume-cleanup --skip-slack" in output.err
    wrap_up.delete_remote_branch.assert_not_called()
    wrap_up.delete_local_branch.assert_called_once()
    assert wrap_up.jira_call.call_count == (0 if resume else 3)


@pytest.mark.parametrize("resume", [False, True], ids=["normal", "resume"])
def test_missing_upstream_dry_run_remains_read_only_preview(recovery, monkeypatch, capsys, resume):
    wrap_up, task, _ = recovery
    argv = ["wrap_up.py", JIRA_KEY, "--dry-run"]
    if resume:
        argv.append("--resume-cleanup")
        wrap_up.memory_call.side_effect = [task]
    monkeypatch.setattr(sys, "argv", argv)
    wrap_up.get_upstream_info.return_value = ("", "github")

    wrap_up.main()

    output = capsys.readouterr()
    assert "example: no upstream path, skip" in output.out
    assert "FAIL" not in output.out
    assert not output.err
    assert wrap_up.memory_call.call_count == (1 if resume else 0)
    wrap_up.delete_remote_branch.assert_not_called()
    wrap_up.delete_local_branch.assert_not_called()
    wrap_up.slack_notify.assert_not_called()
    wrap_up.jira_call.assert_not_called()


def test_missing_upstream_without_branch_remains_intentional_noop(wrap_up, capsys):
    wrap_up.http_request.return_value["items"][0]["branch"] = ""
    wrap_up.get_upstream_info.return_value = ("", "github")

    wrap_up.main()

    output = capsys.readouterr()
    assert "example: no upstream path, skip" in output.out
    assert "DONE" in output.out
    assert not output.err
    wrap_up.delete_remote_branch.assert_not_called()


def test_cleanup_collects_all_pending_repos_and_skips_completed_slack(recovery, monkeypatch, capsys):
    wrap_up, task, _ = recovery
    task["metadata"]["repos"] = ["other"]
    monkeypatch.setattr(sys, "argv", ["wrap_up.py", JIRA_KEY, "--resume-cleanup", "--skip-slack"])
    wrap_up.delete_remote_branch.side_effect = [(False, "permission denied"), (True, "already gone")]
    wrap_up.delete_local_branch.side_effect = [(True, "deleted"), (False, "current branch")]

    with pytest.raises(SystemExit) as exc:
        wrap_up.main()

    assert exc.value.code == 1
    output = capsys.readouterr()
    assert "DONE" not in output.out
    assert "remote branch deletion [example]" in output.err
    assert "local branch deletion [other]" in output.err
    assert "remote branch deletion [other]" not in output.err
    assert "--skip-slack" in output.err
    wrap_up.slack_notify.assert_not_called()
    assert wrap_up.delete_remote_branch.call_count == 2
    assert wrap_up.delete_local_branch.call_count == 2


def test_resume_without_slack_config_is_successful_optional_noop(recovery, monkeypatch, capsys):
    wrap_up, _, _ = recovery
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)
    monkeypatch.setattr(wrap_up, "slack_notify", wrap_up._cleanup_helpers["slack_notify"])

    wrap_up.main()

    # No Slack MCP call; only task lookup and report verification.
    assert wrap_up.memory_call.call_count == 2
    wrap_up.delete_remote_branch.assert_called_once()
    wrap_up.delete_local_branch.assert_called_once()
    output = capsys.readouterr()
    assert "optional notification skipped" in output.out
    assert "FAIL" not in output.out
    assert "DONE" in output.out


@pytest.mark.parametrize(
    ("result", "ok"),
    [
        ({"sent": True}, True),
        ({"sent": False, "suppressed": True, "reason": "Suppressed — daily digest mode active"}, True),
        ({"sent": False, "reason": "Cooldown active — last release_pending"}, True),
        ({"sent": False, "reason": "Webhook error: delivery failed"}, False),
        (None, False),
        ({}, False),
    ],
)
def test_configured_slack_distinguishes_delivery_failure_from_intentional_noop(wrap_up, monkeypatch, result, ok):
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://example.test/webhook")
    wrap_up.memory_call.return_value = result

    success, _ = wrap_up._cleanup_helpers["slack_notify"](JIRA_KEY, [])

    assert success is ok
    assert wrap_up.memory_call.call_args.args[0] == "slack_notify"


def test_resume_configured_slack_delivery_failure_is_pending(recovery, monkeypatch, capsys):
    wrap_up, task, reported = recovery
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://example.test/webhook")
    monkeypatch.setattr(wrap_up, "slack_notify", wrap_up._cleanup_helpers["slack_notify"])
    wrap_up.memory_call.side_effect = [task, reported, {"sent": False, "reason": "Webhook error: delivery failed"}]

    with pytest.raises(SystemExit) as exc:
        wrap_up.main()

    assert exc.value.code == 1
    output = capsys.readouterr()
    assert "DONE" not in output.out
    assert "Slack notification" in output.err
    assert "--skip-slack" not in output.err
    wrap_up.delete_remote_branch.assert_called_once()
    wrap_up.delete_local_branch.assert_called_once()


@pytest.mark.parametrize(
    ("responses", "ok"),
    [
        ([Mock(returncode=0, stderr="", stdout=""), Mock(returncode=0, stderr="", stdout="")], True),
        (
            [
                Mock(returncode=1, stderr="gh: Not Found (HTTP 404)", stdout=""),
                Mock(returncode=1, stderr="gh: Reference does not exist (HTTP 422)", stdout=""),
            ],
            True,
        ),
        (
            [
                Mock(returncode=1, stderr="gh: Forbidden (HTTP 403)", stdout=""),
                Mock(returncode=0, stderr="", stdout=""),
            ],
            False,
        ),
        (
            [
                Mock(returncode=0, stderr="", stdout=""),
                Mock(returncode=1, stderr="gh: Server error (HTTP 500)", stdout=""),
            ],
            False,
        ),
        ([TimeoutError("API timed out"), Mock(returncode=0, stderr="", stdout="")], False),
    ],
)
def test_github_remote_cleanup_reports_real_errors_and_attempts_both_targets(wrap_up, monkeypatch, responses, ok):
    monkeypatch.setattr(
        wrap_up,
        "PROJECT_REPOS",
        Mock(read_text=Mock(return_value=json.dumps({"example": {"url": "https://example.test/fork/example"}}))),
    )
    wrap_up.subprocess.run.side_effect = responses

    success, detail = wrap_up._cleanup_helpers["delete_remote_branch"](
        "example", f"bot/{JIRA_KEY}", "github", "org/example"
    )

    assert success is ok
    assert "org:" in detail and "fork:" in detail
    assert wrap_up.subprocess.run.call_count == 2
    assert [invocation.args[0][2] for invocation in wrap_up.subprocess.run.call_args_list] == [
        f"repos/org/example/git/refs/heads/bot/{JIRA_KEY}",
        f"repos/fork/example/git/refs/heads/bot/{JIRA_KEY}",
    ]


def test_github_fork_lookup_error_still_attempts_upstream_and_returns_failure(wrap_up, monkeypatch):
    monkeypatch.setattr(wrap_up, "PROJECT_REPOS", Mock(read_text=Mock(side_effect=OSError("config unavailable"))))
    wrap_up.subprocess.run.side_effect = None
    wrap_up.subprocess.run.return_value = Mock(returncode=0, stderr="", stdout="")

    ok, detail = wrap_up._cleanup_helpers["delete_remote_branch"]("example", f"bot/{JIRA_KEY}", "github", "org/example")

    assert ok is False
    assert "fork lookup failed" in detail
    assert "org: deleted" in detail
    wrap_up.subprocess.run.assert_called_once()


@pytest.mark.parametrize(
    ("stderr", "ok"),
    [
        ("error: branch 'bot/TEST-123' not found.", True),
        ("error: branch 'bot/TEST-123' is currently checked out", False),
        ("error: cannot delete branch 'bot/TEST-123' used by worktree", False),
    ],
)
def test_local_cleanup_only_treats_missing_branch_as_success(wrap_up, monkeypatch, stderr, ok):
    repos = MagicMock()
    repos.__truediv__.return_value.exists.return_value = True
    monkeypatch.setattr(wrap_up, "REPOS_DIR", repos)
    wrap_up.subprocess.run.side_effect = None
    wrap_up.subprocess.run.return_value = Mock(returncode=1, stderr=stderr, stdout="")

    success, _ = wrap_up._cleanup_helpers["delete_local_branch"]("example", f"bot/{JIRA_KEY}")

    assert success is ok
    wrap_up.subprocess.run.assert_called_once()


@pytest.mark.parametrize("jira_failure", ["transition", "comment"])
def test_existing_jira_failure_does_not_claim_completion(wrap_up, jira_failure, capsys):
    transitions = {"transitions": [{"id": "31", "name": "Release Pending"}]}
    wrap_up.jira_call.side_effect = [None, {}] if jira_failure == "transition" else [transitions, {}, None]

    with pytest.raises(SystemExit) as exc:
        wrap_up.main()

    assert exc.value.code == 1
    output = capsys.readouterr()
    assert "DONE" not in output.out
    assert f"Jira {jira_failure}" in output.err
    assert "Retry failed Jira steps separately" in output.err
    wrap_up.slack_notify.assert_called_once()
    wrap_up.delete_remote_branch.assert_called_once()
    wrap_up.delete_local_branch.assert_called_once()
