"""Memory HTTP endpoints preserve origins while removing the MCP path."""

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from unittest.mock import Mock

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = [
    "presets/shared/preflight/common.py",
    "presets/workflows/jira-sprint/skills/wrap-up/wrap_up.py",
    "presets/workflows/jira-kanban/skills/wrap-up/wrap_up.py",
]


@pytest.mark.parametrize("script", SCRIPTS)
@pytest.mark.parametrize(
    ("configured", "expected"),
    [
        (None, "http://localhost:8080"),
        ("https://example.com/mcp", "https://example.com"),
        ("https://example.com/mcp/", "https://example.com"),
        ("https://example.com", "https://example.com"),
        ("https://example.com/", "https://example.com"),
        ("https://example.com/camp", "https://example.com/camp"),
        ("https://example.com/camp/mcp/", "https://example.com/camp"),
        ("https://mcp", "https://mcp"),
        ("https://mcp/", "https://mcp"),
    ],
)
def test_memory_base_url(monkeypatch, script, configured, expected):
    if configured is None:
        monkeypatch.delenv("BOT_MEMORY_URL", raising=False)
    else:
        monkeypatch.setenv("BOT_MEMORY_URL", configured)
    for module_name, function_name in (("jira_mcp", "jira_call"), ("memory_mcp", "memory_call")):
        module = ModuleType(module_name)
        setattr(module, function_name, Mock())
        monkeypatch.setitem(sys.modules, module_name, module)
    monkeypatch.setattr(sys, "path", sys.path.copy())
    spec = importlib.util.spec_from_file_location("memory_base_url_test", ROOT / script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    if script.endswith("common.py"):
        monkeypatch.setattr(module, "load_state", Mock(return_value={}))
        monkeypatch.setattr(module, "save_state", Mock())
        monkeypatch.setattr(module, "http_get", Mock(return_value={"items": []}))
        monkeypatch.setattr(module, "INSTANCE_ID", "")
        module.get_tasks()
        module.http_get.assert_called_once_with(f"{expected}/api/tasks?exclude_status=archived&limit=50")
    else:
        monkeypatch.setattr(module, "http_request", Mock(return_value={"items": []}))
        module.get_task("TEST-123")
        module.http_request.assert_called_once_with(f"{expected}/api/tasks?exclude_status=archived&limit=50")
