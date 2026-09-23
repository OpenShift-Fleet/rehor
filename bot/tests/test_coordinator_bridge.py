"""Tests for the JSON bridge used by the TypeScript coordinator."""

from bot.coordinator_bridge import handle


def _write_script(path, status, content):
    path.write_text(f'import json; print(json.dumps({{"status": "{status}", "content": "{content}"}}))\n')


def test_preflight_bridge_serializes_start(tmp_path):
    workflow_dir = tmp_path / "presets" / "workflows" / "test-workflow" / "preflight"
    workflow_dir.mkdir(parents=True)
    _write_script(workflow_dir / "01-test.py", "start", "work found")

    result = handle(
        {
            "protocolVersion": 1,
            "operation": "preflight",
            "scriptDir": str(tmp_path),
            "workflow": "test-workflow",
        }
    )

    assert result == {
        "action": "start",
        "prompt": "work found",
        "transcript": "",
        "scripts": [{"name": "01-test.py", "status": "start", "content": "work found"}],
    }


def test_preflight_bridge_preserves_skip_without_starting_runtime(tmp_path):
    workflow_dir = tmp_path / "presets" / "workflows" / "test-workflow" / "preflight"
    workflow_dir.mkdir(parents=True)
    _write_script(workflow_dir / "01-test.py", "skip", "nothing to do")

    result = handle(
        {
            "protocolVersion": 1,
            "operation": "preflight",
            "scriptDir": str(tmp_path),
            "workflow": "test-workflow",
        }
    )

    assert result["action"] == "skip"
    assert result["prompt"] == ""
    assert result["transcript"] == "nothing to do"


def test_preflight_bridge_returns_null_when_no_scripts(tmp_path):
    result = handle(
        {
            "protocolVersion": 1,
            "operation": "preflight",
            "scriptDir": str(tmp_path),
            "workflow": "missing",
        }
    )

    assert result is None


def test_prepare_bridge_reuses_runner_config_sequence(tmp_path, monkeypatch):
    import bot.merge as merge
    import bot.run as runner

    profile_dir = tmp_path / "profile" / "agent"
    shared_dir = tmp_path / "shared" / "agent"
    profile_dir.mkdir(parents=True)
    shared_dir.mkdir(parents=True)
    (profile_dir / "instance.yaml").write_text(
        "workflow: test-workflow\nsource: github\nenvs: [github]\n"
        "runtime: opencode-v1\nprovider: rehor-openai\n"
        "claude_md:\n  strategy: append\n"
    )
    workflow_dir = tmp_path / "presets" / "workflows" / "test-workflow"
    workflow_dir.mkdir(parents=True)
    bot_dir = tmp_path / "bot"
    bot_dir.mkdir()
    (bot_dir / "mcp.json").write_text(
        '{"mcpServers": {"mcp-atlassian": {"type": "http", '
        '"url": "${JIRA_MCP_URL}", '
        '"headers": {"Authorization": "Bearer ${JIRA_MCP_TOKEN}"}}}}'
    )
    persona_dir = tmp_path / "personas" / "frontend"
    persona_dir.mkdir(parents=True)
    (persona_dir / "mcp.json").write_text('{"mcpServers": {"hcc-patternfly-data-view": {"command": "hcc-pf-mcp"}}}')
    monkeypatch.setenv("JIRA_MCP_URL", "https://jira.example/mcp")
    monkeypatch.setenv("JIRA_MCP_TOKEN", "secret-value")
    (tmp_path / ".mcp.json").write_text(
        '{"mcpServers": {"bot-memory": {"type": "http", "url": "http://memory-server/mcp"}, '
        '"chrome-devtools": {"command": "chrome-devtools-mcp"}}}'
    )
    (tmp_path / "config.json").write_text(
        '{"claude": {"model": "test-model", "maxTurns": 10}, '
        '"polling": {"intervalSeconds": 300, "idleIntervalSeconds": 60, '
        '"idleReminderCooldownSeconds": 3600}, "jira": {"boardKey": "TEST"}}'
    )

    monkeypatch.setattr(runner, "SCRIPT_DIR", tmp_path)
    monkeypatch.setattr(runner, "sync_config_repo", lambda label: (profile_dir, shared_dir))
    monkeypatch.setattr(runner, "assemble_claude_md", lambda *args: None)
    monkeypatch.setattr(merge, "apply_merged_config", lambda *args: None)
    monkeypatch.setattr(merge, "install_skills", lambda *args: [])

    result = handle(
        {
            "protocolVersion": 1,
            "operation": "prepare",
            "scriptDir": str(tmp_path),
            "label": "hcc-ai-framework",
        }
    )

    assert result["model"] == "test-model"
    assert result["maxTurns"] == 10
    assert result["intervalSeconds"] == 300
    assert result["idleIntervalSeconds"] == 60
    assert result["cycleTimeoutSeconds"] == 1800
    assert result["idleReminderCooldownSeconds"] == 3600
    assert result["workflow"] == "test-workflow"
    assert result["source"] == "github"
    assert result["envs"] == ["github"]
    assert result["runtimeId"] == "opencode-v1"
    assert result["providerId"] == "rehor-openai"
    assert result["activeEnvs"] == ["github"]
    assert result["claudeMdStrategy"] == "append"
    assert result["remoteAgentDir"] == str(profile_dir)
    assert result["sharedAgentDir"] == str(shared_dir)
    assert result["mcpServers"] == {
        "mcp-atlassian": {
            "type": "http",
            "url": "https://jira.example/mcp",
            "headers": {"Authorization": "Bearer secret-value"},
        },
        "hcc-patternfly-data-view": {"command": "hcc-pf-mcp"},
    }
    assert result["openCodeMcpServers"] == {
        "mcp-atlassian": {
            "type": "http",
            "url": "${JIRA_MCP_URL}",
            "headers": {"Authorization": "Bearer ${JIRA_MCP_TOKEN}"},
        },
        "hcc-patternfly-data-view": {"command": "hcc-pf-mcp"},
        "bot-memory": {"type": "http", "url": "http://memory-server/mcp"},
        "chrome-devtools": {"command": "chrome-devtools-mcp"},
    }
    assert result["optionalMcpServers"] == ["hcc-patternfly-data-view"]
    assert "Bash" in result["allowedTools"]


def test_prepare_bridge_reports_resolved_cycle_model(tmp_path, monkeypatch):
    """The bridge must hand the coordinator the same model run.py would pass to run_cycle."""
    import bot.merge as merge
    import bot.run as runner

    profile_dir = tmp_path / "profile" / "agent"
    profile_dir.mkdir(parents=True)
    (profile_dir / "instance.yaml").write_text("workflow: test-workflow\n")
    workflow_dir = tmp_path / "presets" / "workflows" / "test-workflow"
    workflow_dir.mkdir(parents=True)
    (workflow_dir / "manifest.yaml").write_text("name: test-workflow\nmodel_tier: workflow-tier\n")
    (tmp_path / "config.json").write_text(
        '{"claude": {"model": "global-model", "maxTurns": 10, '
        '"modelTiers": {"workflow-tier": "workflow-model"}}, '
        '"polling": {"intervalSeconds": 300, "idleIntervalSeconds": 60, '
        '"idleReminderCooldownSeconds": 3600}, "jira": {"boardKey": "TEST"}}'
    )

    monkeypatch.delenv("BOT_MODEL", raising=False)
    monkeypatch.setattr(runner, "SCRIPT_DIR", tmp_path)
    monkeypatch.setattr(runner, "sync_config_repo", lambda label: (profile_dir, None))
    monkeypatch.setattr(runner, "assemble_claude_md", lambda *args: None)
    monkeypatch.setattr(merge, "apply_merged_config", lambda *args: None)
    monkeypatch.setattr(merge, "install_skills", lambda *args: [])

    request = {
        "protocolVersion": 1,
        "operation": "prepare",
        "scriptDir": str(tmp_path),
        "label": "hcc-ai-framework",
    }

    assert handle(request)["model"] == "workflow-model"

    monkeypatch.setenv("BOT_MODEL", "env-model")
    assert handle(request)["model"] == "env-model"

    (profile_dir / "instance.yaml").write_text("workflow: test-workflow\nmodel: pinned-model\n")
    assert handle(request)["model"] == "pinned-model"


def test_open_code_mcp_merge_preserves_environment_references(tmp_path, monkeypatch):
    from bot.config import load_mcp_servers

    bot_dir = tmp_path / "bot"
    bot_dir.mkdir()
    (bot_dir / "mcp.json").write_text(
        '{"mcpServers": {"jira": {"type": "http", "url": "${JIRA_URL}", '
        '"headers": {"Authorization": "Bearer ${JIRA_TOKEN}"}}}}'
    )
    monkeypatch.setenv("JIRA_URL", "https://jira.example/mcp")
    monkeypatch.setenv("JIRA_TOKEN", "secret-value")

    resolved = load_mcp_servers(tmp_path)
    references = load_mcp_servers(tmp_path, resolve_env=False)

    assert resolved["jira"]["url"] == "https://jira.example/mcp"
    assert resolved["jira"]["headers"]["Authorization"] == "Bearer secret-value"
    assert references["jira"]["url"] == "${JIRA_URL}"
    assert references["jira"]["headers"]["Authorization"] == "Bearer ${JIRA_TOKEN}"


def test_optional_mcp_servers_come_from_persona_and_active_env_manifests(tmp_path):
    from pathlib import Path

    from bot.config import discover_optional_mcp_servers

    (tmp_path / "personas" / "frontend").mkdir(parents=True)
    (tmp_path / "personas" / "frontend" / "mcp.json").write_text(
        '{"mcpServers": {"persona-mcp": {"command": "persona-mcp"}}}'
    )
    env_dir = tmp_path / "presets" / "envs" / "browser"
    env_dir.mkdir(parents=True)
    (env_dir / "manifest.yaml").write_text("provides:\n  mcp_servers:\n    browser-mcp:\n      type: stdio\n")

    assert discover_optional_mcp_servers(tmp_path, ["browser"]) == ["browser-mcp", "persona-mcp"]

    repository_root = Path(__file__).resolve().parents[2]
    assert "chrome-devtools" in discover_optional_mcp_servers(repository_root, ["browser"])


def test_bridge_maintenance_operations_preserve_idle_and_cleanup_hooks(tmp_path, monkeypatch):
    import bot.idle_reminder as idle_reminder
    import bot.run as runner

    monkeypatch.setattr(runner, "SCRIPT_DIR", tmp_path)
    calls = []
    monkeypatch.setattr(
        idle_reminder,
        "on_preflight_skip",
        lambda *args, **kwargs: calls.append(("skip", args, kwargs)),
    )
    monkeypatch.setattr(
        idle_reminder,
        "on_preflight_start",
        lambda *args, **kwargs: calls.append(("start", args, kwargs)),
    )
    monkeypatch.setattr(
        runner,
        "cleanup_between_cycles",
        lambda script_dir: calls.append(("cleanup", script_dir)),
    )

    request_base = {"protocolVersion": 1, "scriptDir": str(tmp_path), "instanceId": "instance-1"}
    handle(
        {
            **request_base,
            "operation": "idle_skip",
            "idleCycleLimit": 4,
            "cooldownSeconds": 3600,
        }
    )
    handle({**request_base, "operation": "idle_start"})
    handle({"protocolVersion": 1, "operation": "cleanup", "scriptDir": str(tmp_path)})

    assert calls == [
        ("skip", ("instance-1",), {"idle_cycle_limit": 4, "cooldown_seconds": 3600}),
        ("start", ("instance-1",), {}),
        ("cleanup", tmp_path),
    ]


def test_bridge_rejects_unknown_operation():
    try:
        handle({"protocolVersion": 1, "operation": "unknown"})
    except ValueError as exc:
        assert str(exc) == "operation must be preflight, prepare, idle_skip, idle_start, or cleanup"
    else:
        raise AssertionError("unknown operation should fail")
