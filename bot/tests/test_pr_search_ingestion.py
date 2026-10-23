"""Replay provider responses through preflight and a real local HTTP boundary."""

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "presets/shared/preflight"))
import common
import gh_pr_status
import gl_mr_status


@pytest.fixture
def ingestion(monkeypatch):
    state = {"requests": [], "status": 200}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            state["requests"].append(
                {
                    "path": self.path,
                    "authorization": self.headers.get("Authorization"),
                    "payload": json.loads(self.rfile.read(int(self.headers["Content-Length"]))),
                }
            )
            self.send_response(state["status"])
            self.send_header("Location", "/must-not-follow")
            self.end_headers()
            self.wfile.write(b'{"updated": true}')

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(common, "MEMORY_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "test-only-secret")
    monkeypatch.setattr(common, "_snapshot_disabled_warned", False)
    monkeypatch.setattr(common, "_snapshot_unavailable", False, raising=False)
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def provider_data(host):
    return {
        "state": "OPEN" if host == "github" else "opened",
        "title": "Search update",
        "url": "https://github.com/org/repo/pull/7",
        "web_url": "https://gitlab.example/org/repo/-/merge_requests/7",
        "labels": [{"name": "awaiting-review"}, {"name": "bug"}] if host == "github" else ["awaiting-review", "bug"],
        "mergeable": "MERGEABLE",
        "statusCheckRollup": [],
        "reviews": [],
        "has_conflicts": False,
        "blocking_discussions_resolved": True,
    }


@pytest.mark.parametrize("host", ["github", "gitlab"])
@pytest.mark.parametrize("status", [200, 503])
def test_successful_detail_fetch_refreshes_labels_without_changing_classification(ingestion, monkeypatch, host, status):
    ingestion["status"] = status
    data = provider_data(host)
    calls = []

    def run(args, **kwargs):
        calls.append(args)
        details = args[:3] == ["gh", "pr", "view"] or (args[0] == "glab" and "/notes" not in args[2])
        output = json.dumps(data) if details else ("[]" if host == "gitlab" else "")
        return subprocess.CompletedProcess(args, 0, output, "")

    monkeypatch.setattr(subprocess, "run", run)
    task = {
        "external_key": "TEST-1",
        "source_type": "jira",
        "repo": "org/repo",
        "metadata": {"prs": [{"host": host, "repo": "org/repo", "number": 7}]},
    }
    enriched = gh_pr_status.enrich_gh(task) if host == "github" else gl_mr_status.enrich_gl(task)
    assert enriched["issues"] == []
    assert enriched["prs"][0]["state"] == "OPEN" if host == "github" else enriched["prs"][0]["state"] == "OPENED"
    captured = ingestion["requests"]
    assert len(captured) == 1
    assert captured[0]["path"] == "/api/internal/pull-requests"
    assert captured[0]["authorization"] == "Bearer test-only-secret"
    assert captured[0]["payload"]["labels"] == ["awaiting-review", "bug"]
    assert captured[0]["payload"]["repository"] == "org/repo"
    assert captured[0]["payload"]["source_type"] == "jira"
    assert captured[0]["payload"]["host"] == host
    if host == "github":
        assert "labels" in calls[0][-1].split(",")


@pytest.mark.parametrize("labels", [None, "bug", [None], [{}]])
def test_incomplete_snapshots_never_clear_known_labels(ingestion, labels):
    data = provider_data("github")
    data["labels"] = labels
    assert common.persist_pr_snapshot({"external_key": "TEST-1"}, "github", "org/repo", 7, data) is False
    assert ingestion["requests"] == []


@pytest.mark.parametrize("status", [400, 404, 409])
def test_task_specific_rejection_does_not_suppress_other_snapshots(ingestion, status):
    ingestion["status"] = status
    task = {"external_key": "TEST-1"}
    assert common.persist_pr_snapshot(task, "github", "org/repo", 7, provider_data("github")) is False
    ingestion["status"] = 200
    assert common.persist_pr_snapshot(task, "github", "org/repo", 7, provider_data("github")) is True
    assert len(ingestion["requests"]) == 2


def test_server_outage_does_not_add_a_timeout_for_every_pr(ingestion, capsys):
    ingestion["status"] = 503
    for _ in range(5):
        assert (
            common.persist_pr_snapshot({"external_key": "TEST-1"}, "github", "org/repo", 7, provider_data("github"))
            is False
        )
    assert len(ingestion["requests"]) == 1
    assert capsys.readouterr().err.count("labels may be stale") == 1


def test_missing_secret_is_observable_once_and_never_sends_request(ingestion, monkeypatch, capsys):
    monkeypatch.delenv("UPLOAD_MEMORY_PASSWORD")
    for _ in range(2):
        assert (
            common.persist_pr_snapshot({"external_key": "TEST-1"}, "github", "org/repo", 7, provider_data("github"))
            is False
        )
    assert ingestion["requests"] == []
    assert capsys.readouterr().err.count("ingestion disabled") == 1


def test_authenticated_write_does_not_follow_redirects_or_log_credentials(ingestion, capsys):
    ingestion["status"] = 307
    assert (
        common.persist_pr_snapshot({"external_key": "TEST-1"}, "github", "org/repo", 7, provider_data("github"))
        is False
    )
    assert len(ingestion["requests"]) == 1
    log = capsys.readouterr().err
    assert "labels may be stale" in log
    assert "test-only-secret" not in log


def test_failed_provider_fetch_never_changes_snapshot(ingestion, monkeypatch):
    monkeypatch.setattr(
        subprocess, "run", lambda args, **kwargs: subprocess.CompletedProcess(args, 1, "", "unavailable")
    )
    task = {"external_key": "TEST-1", "repo": "org/repo", "metadata": {"prs": [{"repo": "org/repo", "number": 7}]}}
    assert gh_pr_status.enrich_gh(task) is None
    assert ingestion["requests"] == []


def test_preflight_surfaces_sanitized_ingestion_warnings(monkeypatch, tmp_path, caplog):
    from bot import preflight

    warning = "WARN PR/MR label ingestion failed (TimeoutError); cached labels may be stale"
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda args, **kwargs: subprocess.CompletedProcess(
            args, 0, '{"status":"skip","content":"idle"}', warning + "\nraw provider response stays private"
        ),
    )
    assert preflight._run_script(tmp_path / "trusted.py", tmp_path).status == "skip"
    assert warning in caplog.text
    assert "raw provider response" not in caplog.text


def test_ingestion_credential_only_reaches_trusted_preflight(monkeypatch, tmp_path):
    from bot import config, preflight

    monkeypatch.setattr(config, "_preflight_secret_env", {}, raising=False)
    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "preflight-only-test-secret")
    config.sanitize_env()
    assert os.environ.get("UPLOAD_MEMORY_PASSWORD") is None
    captured = {}

    def run(args, **kwargs):
        captured.update(kwargs["env"])
        return subprocess.CompletedProcess(args, 0, '{"status":"skip","content":"idle"}', "")

    monkeypatch.setattr(subprocess, "run", run)
    result = preflight._run_script(tmp_path / "trusted.py", tmp_path)
    assert result.status == "skip"
    assert captured["UPLOAD_MEMORY_PASSWORD"] == "preflight-only-test-secret"
    assert "UPLOAD_MEMORY_PASSWORD" not in os.environ
