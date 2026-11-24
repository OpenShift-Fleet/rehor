"""Tests for the JSON bridge used by the TypeScript coordinator."""

import json

import pytest

from bot.coordinator_bridge import handle


def test_bridge_main_logs_info_to_stderr_without_corrupting_stdout(tmp_path):
    import json
    import subprocess
    import sys

    workflow_dir = tmp_path / "presets" / "workflows" / "test-workflow" / "preflight"
    workflow_dir.mkdir(parents=True)
    _write_script(workflow_dir / "01-test.py", "skip", "nothing to do")
    result = subprocess.run(
        [sys.executable, "-m", "bot.coordinator_bridge"],
        input=json.dumps({"operation": "preflight", "scriptDir": str(tmp_path), "workflow": "test-workflow"}),
        text=True,
        capture_output=True,
        check=True,
    )
    assert json.loads(result.stdout)["result"]["action"] == "skip"
    records = [json.loads(line) for line in result.stderr.splitlines()]
    assert any(record["level"] == "INFO" and record["logger"] == "bot.preflight" for record in records)
    messages = [record["message"] for record in records if record["logger"] == "bot.preflight"]
    assert "Preflight 01-test.py starting" in messages
    assert any(message.startswith("Preflight 01-test.py → skip (13 chars) in ") for message in messages)


def test_bridge_main_logs_own_errors_as_json():
    import json
    import subprocess
    import sys

    result = subprocess.run(
        [sys.executable, "-m", "bot.coordinator_bridge"],
        input=json.dumps({"operation": "unsupported"}),
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 2
    assert result.stdout == ""
    record = json.loads(result.stderr)
    assert record["level"] == "ERROR"
    assert record["logger"] == "bot.coordinator_bridge"
    assert record["message"].startswith("coordinator bridge failed: operation must be")


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


@pytest.mark.parametrize(
    "runtime, provider, json_budget_usd, expected_budget_usd",
    [
        ("opencode", "rehor-openai", None, 5.0),
        ("opencode", "rehor-openai", 7.5, 7.5),
        ("opencode", "vertex", None, 5.0),
        ("claude", "vertex", None, 5.0),
        ("claude", "vertex", 7.5, 7.5),
    ],
)
def test_prepare_bridge_reuses_runner_config_sequence(
    tmp_path, monkeypatch, caplog, runtime, provider, json_budget_usd, expected_budget_usd
):
    import bot.merge as merge
    import bot.run as runner

    profile_dir = tmp_path / "profile" / "agent"
    shared_dir = tmp_path / "shared" / "agent"
    profile_dir.mkdir(parents=True)
    shared_dir.mkdir(parents=True)
    (profile_dir / "instance.yaml").write_text(
        "workflow: test-workflow\nsource: github\nenvs: [github]\n"
        f"runtime: {runtime}\nprovider: {provider}\n"
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
        '{"claude": {"model": "claude-test-model", "maxTurns": 10}, '
        '"opencode": {"model": "test-model"}, '
        '"polling": {"intervalSeconds": 300, "idleIntervalSeconds": 60, '
        '"idleReminderCooldownSeconds": 3600}, "jira": {"boardKey": "TEST"}}'
    )
    if json_budget_usd is not None:
        config_path = tmp_path / "config.json"
        raw = json.loads(config_path.read_text())
        raw["claude"]["budgetUsd"] = json_budget_usd
        config_path.write_text(json.dumps(raw))
    monkeypatch.delenv("REHOR_OPENCODE_MAX_TOOL_CALLS", raising=False)

    calls = []
    git_config_global = str(tmp_path / ".gitconfig")
    monkeypatch.delenv("GIT_CONFIG_GLOBAL", raising=False)
    monkeypatch.setattr(runner, "SCRIPT_DIR", tmp_path)

    def setup_git(script_dir):
        calls.append(("setup_git", script_dir))
        monkeypatch.setenv("GIT_CONFIG_GLOBAL", git_config_global)

    monkeypatch.setattr(runner, "setup_git", setup_git)

    def sync_config_repo(label):
        calls.append(("sync", label))
        return profile_dir, shared_dir

    monkeypatch.setattr(runner, "sync_config_repo", sync_config_repo)
    assembled_claude_instructions = []
    monkeypatch.setattr(
        runner,
        "assemble_claude_md",
        lambda *args: assembled_claude_instructions.append(args),
    )
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

    assert calls[:2] == [("setup_git", tmp_path), ("sync", "hcc-ai-framework")]
    assert result["model"] == ("test-model" if provider == "rehor-openai" else "claude-test-model")
    assert result["budgetUsd"] == expected_budget_usd
    assert result["intervalSeconds"] == 300
    assert result["idleIntervalSeconds"] == 60
    assert result["cycleTimeoutSeconds"] == 3600
    assert result["idleReminderCooldownSeconds"] == 3600
    assert result["workflow"] == "test-workflow"
    assert result["source"] == "github"
    assert result["envs"] == ["github"]
    assert result["gitConfigGlobal"] == git_config_global
    assert result["runtimeId"] == runtime
    assert len(assembled_claude_instructions) == (1 if runtime == "claude" else 0)
    assert result["providerId"] == provider
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
    from bot.config import ALLOWED_TOOLS

    assert "LSP" in ALLOWED_TOOLS
    if runtime == "opencode":
        assert result["allowedTools"] == [tool for tool in ALLOWED_TOOLS if tool != "LSP"]
        assert "OpenCode V2.1.2 does not support LSP" in caplog.text
    else:
        assert result["allowedTools"] == ALLOWED_TOOLS
        assert "does not support LSP" not in caplog.text


def test_runtime_allowlist_only_omits_known_unsupported_tool(monkeypatch):
    import bot.config as config
    from bot.coordinator_bridge import _allowed_tools_for_runtime

    monkeypatch.setattr(config, "ALLOWED_TOOLS", ["Read", "LSP", "UnknownFutureTool"])
    assert _allowed_tools_for_runtime("opencode") == ["Read", "UnknownFutureTool"]
    assert _allowed_tools_for_runtime("claude") == ["Read", "LSP", "UnknownFutureTool"]


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
    # The real setup_git exports GIT_CONFIG_GLOBAL for the whole test process.
    monkeypatch.setattr(runner, "setup_git", lambda script_dir: None)
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


def test_prepare_bridge_applies_instance_cycle_timeout(tmp_path, monkeypatch):
    """instance.yaml cycle_timeout_seconds overrides config.json claude.cycleTimeoutSeconds."""
    import bot.merge as merge
    import bot.run as runner

    profile_dir = tmp_path / "profile" / "agent"
    profile_dir.mkdir(parents=True)
    (profile_dir / "instance.yaml").write_text("workflow: test-workflow\ncycle_timeout_seconds: 7200\n")
    workflow_dir = tmp_path / "presets" / "workflows" / "test-workflow"
    workflow_dir.mkdir(parents=True)
    (tmp_path / "config.json").write_text(
        '{"claude": {"model": "global-model", "maxTurns": 10, "cycleTimeoutSeconds": 1800}, '
        '"polling": {"intervalSeconds": 300, "idleIntervalSeconds": 60}, "jira": {"boardKey": "TEST"}}'
    )

    monkeypatch.delenv("BOT_MODEL", raising=False)
    monkeypatch.setattr(runner, "SCRIPT_DIR", tmp_path)
    monkeypatch.setattr(runner, "setup_git", lambda script_dir: None)
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

    # The instance.yaml value wins over config.json claude.cycleTimeoutSeconds.
    assert handle(request)["cycleTimeoutSeconds"] == 7200

    # Without the instance key, the config.json value flows through unchanged.
    (profile_dir / "instance.yaml").write_text("workflow: test-workflow\n")
    assert handle(request)["cycleTimeoutSeconds"] == 1800


def test_prepare_bridge_validates_before_installing_skills(tmp_path, monkeypatch):
    """A missing workflow is a structured bridge error and leaves skills untouched."""
    import pytest

    import bot.merge as merge
    import bot.run as runner
    from bot.coordinator_bridge import BridgeError

    profile_dir = tmp_path / "profile" / "agent"
    profile_dir.mkdir(parents=True)
    (profile_dir / "instance.yaml").write_text("workflow: missing-workflow\n")
    (tmp_path / "config.json").write_text(
        '{"claude": {"model": "global-model", "maxTurns": 10}, '
        '"polling": {"intervalSeconds": 300, "idleIntervalSeconds": 60}, "jira": {"boardKey": "TEST"}}'
    )
    installed = []
    monkeypatch.setattr(runner, "SCRIPT_DIR", tmp_path)
    monkeypatch.setattr(runner, "setup_git", lambda script_dir: None)
    monkeypatch.setattr(runner, "sync_config_repo", lambda label: (profile_dir, None))
    monkeypatch.setattr(runner, "assemble_claude_md", lambda *args: installed.append("claude_md"))
    monkeypatch.setattr(merge, "apply_merged_config", lambda *args: None)
    monkeypatch.setattr(merge, "install_skills", lambda *args: installed.append("skills") or [])

    with pytest.raises(BridgeError, match="validate_instance_config failed"):
        handle(
            {
                "protocolVersion": 1,
                "operation": "prepare",
                "scriptDir": str(tmp_path),
                "label": "hcc-ai-framework",
            }
        )
    assert installed == []


@pytest.fixture
def baked_profile_request(tmp_path, monkeypatch):
    import bot.run as runner

    monkeypatch.setattr(runner, "SCRIPT_DIR", tmp_path)
    monkeypatch.setattr(runner, "setup_git", lambda script_dir: None)
    monkeypatch.setenv("REHOR_INPUT_SOURCE", "sandbox")
    monkeypatch.setenv("REHOR_PRIVATE_RUNTIME", "1")
    monkeypatch.setenv("BOT_CONFIG_PATH", "instance/fleetshift-config")
    monkeypatch.setenv("BOT_CONFIG_REPO", "https://example.invalid/must-not-fetch")
    monkeypatch.delenv("BOT_MODEL", raising=False)
    (tmp_path / "config.json").write_text(
        '{"claude": {"model": "default-claude", "maxTurns": 10}, '
        '"opencode": {"model": "default-opencode"}, '
        '"polling": {"intervalSeconds": 300, "idleIntervalSeconds": 60}, "jira": {"boardKey": "TEST"}}'
    )
    (tmp_path / "presets" / "workflows" / "jira-sprint").mkdir(parents=True)
    (tmp_path / ".claude").mkdir()
    agent = tmp_path / "instance" / "fleetshift-config" / "agent"
    agent.mkdir(parents=True)
    (agent / "instance.yaml").write_text(
        "workflow: jira-sprint\nsource: jira\nruntime: opencode\nprovider: rehor-openai\nmodel: fleet-model\nenvs: []\n"
    )
    agents = agent / ".opencode" / "agents"
    agents.mkdir(parents=True)
    (agents / "fleetshift-coordinator.md").write_text("---\nmode: primary\n---\nCoordinator\n")
    (agent / "opencode.json").write_text('{"default_agent": "fleetshift-coordinator"}')
    (agent / "project-repos.json").write_text('{"example/repo": {"url": "https://example.invalid/repo"}}')
    shared = tmp_path / "instance" / "shared" / "agent"
    shared.mkdir(parents=True)
    monkeypatch.setattr(runner, "sync_config_repo", lambda label: pytest.fail("private sandbox must not sync"))
    return {"operation": "prepare", "scriptDir": str(tmp_path), "label": "fleetshift"}, agent, shared


def test_private_sandbox_loads_baked_profile_and_exposes_native_agents(baked_profile_request):
    request, agent, shared = baked_profile_request
    result = handle(request)

    assert (result["runtimeId"], result["providerId"], result["model"]) == ("opencode", "rehor-openai", "fleet-model")
    assert result["remoteAgentDir"] == str(agent.resolve())
    assert result["sharedAgentDir"] == str(shared.resolve())
    assert json.loads((agent / "opencode.json").read_text())["default_agent"] == "fleetshift-coordinator"
    assert (agent / ".opencode" / "agents" / "fleetshift-coordinator.md").is_file()
    assert "example/repo" in json.loads((agent.parents[2] / "project-repos.json").read_text())


@pytest.mark.parametrize("path", ["/absolute/profile", "../outside", "instance/../fleetshift-config", "missing"])
def test_private_sandbox_rejects_unsafe_or_missing_profile(baked_profile_request, monkeypatch, path):
    from bot.coordinator_bridge import BridgeError

    request, _, _ = baked_profile_request
    monkeypatch.setenv("BOT_CONFIG_PATH", path)
    with pytest.raises(BridgeError, match="BOT_CONFIG_PATH"):
        handle(request)


@pytest.mark.parametrize("target", ["agent", "instance.yaml", "profile", "shared"])
def test_private_sandbox_rejects_escaping_symlinks(baked_profile_request, tmp_path, target):
    from bot.coordinator_bridge import BridgeError

    request, agent, shared = baked_profile_request
    outside = tmp_path.parent / (tmp_path.name + "-outside")
    outside.mkdir()
    if target == "instance.yaml":
        config = agent / "instance.yaml"
        config.unlink()
        (outside / "instance.yaml").write_text("runtime: opencode\n")
        config.symlink_to(outside / "instance.yaml")
    else:
        import shutil

        path = {"agent": agent, "profile": agent.parent, "shared": shared}[target]
        shutil.rmtree(path)
        path.symlink_to(outside, target_is_directory=True)
    with pytest.raises(BridgeError, match="BOT_CONFIG_PATH"):
        handle(request)


@pytest.mark.parametrize("missing", ["agent", "instance.yaml"])
def test_private_sandbox_rejects_incomplete_profile(baked_profile_request, missing):
    import shutil

    from bot.coordinator_bridge import BridgeError

    request, agent, _ = baked_profile_request
    if missing == "agent":
        shutil.rmtree(agent)
    else:
        (agent / "instance.yaml").unlink()
    with pytest.raises(BridgeError, match="BOT_CONFIG_PATH"):
        handle(request)


@pytest.mark.parametrize("source,private", [("legacy", "1"), ("sandbox", "0"), ("legacy", "0")])
def test_non_private_sandbox_keeps_legacy_remote_sync(baked_profile_request, monkeypatch, source, private):
    import bot.run as runner

    request, agent, shared = baked_profile_request
    monkeypatch.setenv("REHOR_INPUT_SOURCE", source)
    monkeypatch.setenv("REHOR_PRIVATE_RUNTIME", private)
    calls = []
    monkeypatch.setattr(runner, "sync_config_repo", lambda label: calls.append(label) or (agent, shared))
    result = handle(request)
    assert calls == ["fleetshift"]
    assert result["remoteAgentDir"] == str(agent)


@pytest.mark.parametrize("path", [None, ""])
def test_private_sandbox_without_profile_path_fails_closed(baked_profile_request, monkeypatch, path):
    from bot.coordinator_bridge import BridgeError

    request, _, _ = baked_profile_request
    if path is None:
        monkeypatch.delenv("BOT_CONFIG_PATH")
    else:
        monkeypatch.setenv("BOT_CONFIG_PATH", path)
    with pytest.raises(BridgeError, match="BOT_CONFIG_PATH is required"):
        handle(request)


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


def test_optional_mcp_servers_come_from_persona_and_all_env_manifests(tmp_path):
    from pathlib import Path

    from bot.config import discover_optional_mcp_servers

    (tmp_path / "personas" / "frontend").mkdir(parents=True)
    (tmp_path / "personas" / "frontend" / "mcp.json").write_text(
        '{"mcpServers": {"persona-mcp": {"command": "persona-mcp"}}}'
    )
    for env, server in (("browser", "browser-mcp"), ("patternfly", "patternfly-mcp")):
        env_dir = tmp_path / "presets" / "envs" / env
        env_dir.mkdir(parents=True)
        (env_dir / "manifest.yaml").write_text(f"provides:\n  mcp_servers:\n    {server}:\n      type: stdio\n")

    assert discover_optional_mcp_servers(tmp_path) == ["browser-mcp", "patternfly-mcp", "persona-mcp"]

    repository_root = Path(__file__).resolve().parents[2]
    assert "chrome-devtools" in discover_optional_mcp_servers(repository_root)


def test_allowed_mcp_wildcards_are_configured_or_optional_without_envs():
    """An instance with no envs (onboarding runs envs: [_none]) must still render
    an OpenCode config: every MCP server named in ALLOWED_TOOLS has to be either
    configured by the project .mcp.json or optional (REHOR-167)."""
    from pathlib import Path

    from bot.config import ALLOWED_TOOLS, discover_optional_mcp_servers, load_mcp_servers

    repository_root = Path(__file__).resolve().parents[2]
    configured = set(load_mcp_servers(repository_root, resolve_env=False, include_project=True))
    optional = set(discover_optional_mcp_servers(repository_root))
    referenced = {tool.split("__")[1] for tool in ALLOWED_TOOLS if tool.startswith("mcp__")}

    assert referenced - configured - optional == set()


def test_bridge_maintenance_operations_preserve_idle_and_cleanup_hooks(tmp_path, monkeypatch):
    import bot.idle_reminder as idle_reminder
    import bot.run as runner

    monkeypatch.setattr(runner, "SCRIPT_DIR", tmp_path)
    calls = []
    monkeypatch.setattr(runner, "_try_slack_digest", lambda: calls.append(("digest",)))
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

    def cleanup_between_cycles(script_dir):
        calls.append(("cleanup", script_dir))
        return 4096

    monkeypatch.setattr(runner, "cleanup_between_cycles", cleanup_between_cycles)

    request_base = {"protocolVersion": 1, "scriptDir": str(tmp_path), "instanceId": "instance-1"}
    handle({"protocolVersion": 1, "scriptDir": str(tmp_path), "operation": "scheduled_maintenance"})
    handle(
        {
            **request_base,
            "operation": "idle_skip",
            "idleCycleLimit": 4,
            "cooldownSeconds": 3600,
        }
    )
    handle({**request_base, "operation": "idle_start"})
    cleanup = handle({"protocolVersion": 1, "operation": "cleanup", "scriptDir": str(tmp_path)})

    assert cleanup == {"diskFreeMb": 4096}
    assert calls == [
        ("digest",),
        ("skip", ("instance-1",), {"idle_cycle_limit": 4, "cooldown_seconds": 3600}),
        ("start", ("instance-1",), {}),
        ("cleanup", tmp_path),
    ]


def test_bridge_rejects_unknown_operation():
    try:
        handle({"protocolVersion": 1, "operation": "unknown"})
    except ValueError as exc:
        assert (
            str(exc) == "operation must be preflight, prepare, scheduled_maintenance, idle_skip, idle_start, or cleanup"
        )
    else:
        raise AssertionError("unknown operation should fail")


def test_scheduled_maintenance_keeps_bridge_stdout_machine_readable(tmp_path, monkeypatch, capsys):
    import io
    import json
    import sys

    import bot.run as runner
    from bot import coordinator_bridge

    monkeypatch.setattr(runner, "SCRIPT_DIR", tmp_path)
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://example.invalid/slack")
    monkeypatch.setenv("SLACK_DIGEST_HOUR", "99")
    request = {
        "protocolVersion": 1,
        "operation": "scheduled_maintenance",
        "scriptDir": str(tmp_path),
    }
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(request)))

    assert coordinator_bridge.main() == 0
    assert json.loads(capsys.readouterr().out) == {
        "protocolVersion": 1,
        "ok": True,
        "result": None,
    }


def test_bridge_drops_httpx_request_logs_but_keeps_warnings(monkeypatch, capsys):
    import io
    import json
    import logging
    import sys

    from bot import coordinator_bridge

    def fake_handle(_request):
        logging.getLogger("httpx").info('HTTP Request: GET http://memory/instances/x "HTTP/1.1 200 OK"')
        logging.getLogger("httpx").warning("httpx warning")
        return None

    monkeypatch.setattr(coordinator_bridge, "handle", fake_handle)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"protocolVersion": 1})))

    assert coordinator_bridge.main() == 0
    records = [json.loads(line) for line in capsys.readouterr().err.splitlines()]
    assert [r["message"] for r in records if r["logger"] == "httpx"] == ["httpx warning"]
