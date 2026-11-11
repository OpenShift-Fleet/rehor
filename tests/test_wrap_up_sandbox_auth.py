"""Wrap-up GET authentication stays sandbox-only and origin-bound."""

import importlib.util
import sys
import urllib.request
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock, Mock

import pytest

ROOT = Path(__file__).resolve().parents[1]
MARKER = "openshell:resolve:env:MEMORY_TOKEN"


@pytest.fixture(params=["jira-sprint", "jira-kanban"])
def wrap_up(request, monkeypatch):
    for name, func in (("jira_mcp", "jira_call"), ("memory_mcp", "memory_call")):
        module = ModuleType(name)
        setattr(module, func, Mock())
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setattr(sys, "path", sys.path.copy())
    path = ROOT / "presets" / "workflows" / request.param / "skills" / "wrap-up" / "wrap_up.py"
    spec = importlib.util.spec_from_file_location("wrap_up_auth_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    response = MagicMock()
    response.__enter__.return_value.read.return_value = b'{"items": [{"external_key": "TEST-123"}]}'
    monkeypatch.setattr(module.urllib.request, "urlopen", Mock(return_value=response))
    monkeypatch.setenv("BOT_MEMORY_URL", "https://memory.example/mcp")
    monkeypatch.setenv("REHOR_INPUT_SOURCE", "sandbox")
    monkeypatch.setenv("BOT_MEMORY_TOKEN", MARKER)
    return module


def request_header(module, url, method="GET"):
    assert module.http_request(url, method=method) == {"items": [{"external_key": "TEST-123"}]}
    return module.urllib.request.urlopen.call_args.args[0]


def test_get_task_attaches_non_redirectable_sandbox_placeholder(wrap_up, monkeypatch):
    monkeypatch.setattr(wrap_up, "MEMORY_URL", "https://memory.example")
    assert wrap_up.get_task("TEST-123")["external_key"] == "TEST-123"
    req = wrap_up.urllib.request.urlopen.call_args.args[0]
    assert req.get_header("Authorization") == f"Bearer {MARKER}"
    assert "Authorization" not in req.headers
    for target in (
        "https://evil.example/api/tasks",
        "http://memory.example/api/tasks",
        "https://memory.example/api/tasks",
    ):
        redirected = urllib.request.HTTPRedirectHandler().redirect_request(req, None, 302, "Found", {}, target)
        assert not redirected.has_header("Authorization")


@pytest.mark.parametrize(
    "base,target,method,expected",
    [
        ("https://memory.example/mcp", "https://MEMORY.example:443/api/tasks?limit=50", "GET", True),
        ("https://memory.example:8443/mcp", "https://memory.example:8443/api/tasks", "GET", True),
        ("https://memory.example/mcp", "https://memory.example:8443/api/tasks", "GET", False),
        ("https://memory.example/mcp", "https://memory.example:0/api/tasks", "GET", False),
        ("https://memory.example/mcp", "https://memory.example.evil/api/tasks", "GET", False),
        ("https://memory.example/mcp", "https://user@memory.example/api/tasks", "GET", False),
        ("https://memory.example/mcp", "http://memory.example/api/tasks", "GET", False),
        ("http://memory.example/mcp", "https://memory.example/api/tasks", "GET", False),
        ("https://user@memory.example/mcp", "https://memory.example/api/tasks", "GET", False),
        ("https://memory.example:bad/mcp", "https://memory.example/api/tasks", "GET", False),
        ("https://memory.example/mcp?x=1", "https://memory.example/api/tasks", "GET", False),
        ("https://memory.example/mcp", "https://memory.example/api/tasks", "POST", False),
    ],
)
def test_auth_requires_matching_https_origin(wrap_up, monkeypatch, base, target, method, expected):
    monkeypatch.setenv("BOT_MEMORY_URL", base)
    req = request_header(wrap_up, target, method)
    assert req.get_header("Authorization") == (f"Bearer {MARKER}" if expected else None)


@pytest.mark.parametrize(
    "mode,token",
    [
        ("legacy", MARKER),
        ("", MARKER),
        ("sandbox", "raw-secret"),
        ("sandbox", "openshell:resolve:env:"),
        ("sandbox", MARKER + "\n"),
        ("sandbox", "openshell:resolve:env:has-dash"),
    ],
)
def test_legacy_or_invalid_token_does_not_add_auth(wrap_up, monkeypatch, mode, token):
    monkeypatch.setenv("REHOR_INPUT_SOURCE", mode)
    monkeypatch.setenv("BOT_MEMORY_TOKEN", token)
    req = request_header(wrap_up, "https://memory.example/api/tasks")
    assert not req.has_header("Authorization")


def test_legacy_caller_headers_are_unchanged(wrap_up, monkeypatch):
    monkeypatch.setenv("REHOR_INPUT_SOURCE", "legacy")
    wrap_up.http_request("http://memory.example/api/tasks", headers={"Authorization": "caller-value"})
    req = wrap_up.urllib.request.urlopen.call_args.args[0]
    assert req.get_header("Authorization") == "caller-value"
