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
        "workflow: test-workflow\nsource: github\nenvs: [github]\nclaude_md:\n  strategy: append\n"
    )
    workflow_dir = tmp_path / "presets" / "workflows" / "test-workflow"
    workflow_dir.mkdir(parents=True)
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
    assert result["activeEnvs"] == ["github"]
    assert result["claudeMdStrategy"] == "append"
    assert result["remoteAgentDir"] == str(profile_dir)
    assert result["sharedAgentDir"] == str(shared_dir)


def test_prepare_bridge_reports_resolved_cycle_model(tmp_path, monkeypatch):
    """The bridge must hand the coordinator the same model run.py would pass to run_cycle."""
    import bot.merge as merge
    import bot.run as runner

    profile_dir = tmp_path / "profile" / "agent"
    profile_dir.mkdir(parents=True)
    (profile_dir / "instance.yaml").write_text("workflow: test-workflow\n")
    workflow_dir = tmp_path / "presets" / "workflows" / "test-workflow"
    workflow_dir.mkdir(parents=True)
    (workflow_dir / "manifest.yaml").write_text("name: test-workflow\ndefault_model: workflow-model\n")
    (tmp_path / "config.json").write_text(
        '{"claude": {"model": "global-model", "maxTurns": 10}, '
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


def test_bridge_rejects_unknown_operation():
    try:
        handle({"protocolVersion": 1, "operation": "unknown"})
    except ValueError as exc:
        assert str(exc) == "operation must be 'preflight' or 'prepare'"
    else:
        raise AssertionError("unknown operation should fail")
