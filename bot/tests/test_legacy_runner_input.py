"""Legacy polling still runs preflight before starting a Python agent cycle."""

import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _mock_sdk():
    sdk = MagicMock()
    sentinel = object()
    prev = sys.modules.get("claude_agent_sdk", sentinel)
    sys.modules["claude_agent_sdk"] = sdk
    for mod_name in list(sys.modules):
        if mod_name.startswith("bot.agent") or mod_name == "bot.run":
            sys.modules.pop(mod_name, None)
    yield
    if prev is sentinel:
        sys.modules.pop("claude_agent_sdk", None)
    else:
        sys.modules["claude_agent_sdk"] = prev
    for mod_name in list(sys.modules):
        if mod_name.startswith("bot.agent") or mod_name == "bot.run":
            sys.modules.pop(mod_name, None)


def _mock_config():
    config = SimpleNamespace()
    config.interval = 300
    config.idle_interval = 3600
    config.cycle_timeout = 600
    config.idle_reminder_cooldown_seconds = 0
    config.model_tiers = {}
    return config


@pytest.fixture
def main_patches():
    from bot.config import InstanceConfig

    instance_config = InstanceConfig(workflow="jira-sprint", source="jira")
    all_patches = {
        "argv": patch("sys.argv", ["dev-bot", "--label", "test", "--instance-id", "test-instance"]),
        "dotenv": patch("bot.run.load_dotenv"),
        "setup_git": patch("bot.run.setup_git"),
        "setup_logging": patch("bot.run.setup_logging"),
        "load_config": patch("bot.run.load_config", return_value=_mock_config()),
        "load_mcp_servers": patch("bot.run.load_mcp_servers", return_value={}),
        "sync_config_repo": patch("bot.run.sync_config_repo", return_value=(None, None)),
        "apply_merged_config": patch("bot.run.apply_merged_config"),
        "load_instance_config": patch("bot.run.load_instance_config", return_value=instance_config),
        "install_skills": patch("bot.run.install_skills"),
        "resolve_workflow_dir": patch("bot.run.resolve_workflow_dir"),
        "resolve_active_envs": patch("bot.run.resolve_active_envs", return_value=[]),
        "validate_manifest": patch("bot.run.validate_manifest"),
        "validate_instance_config": patch("bot.run.validate_instance_config"),
        "sanitize_env": patch("bot.run.sanitize_env"),
        "file_lock": patch("bot.run.FileLock"),
        "signal": patch("bot.run.signal.signal"),
        "metrics_server": patch("bot.run.start_http_server"),
        "assemble_claude_md": patch("bot.run.assemble_claude_md"),
        "resolve_cycle_model": patch("bot.run.resolve_cycle_model", return_value="test-model"),
        "run_preflight": patch("bot.run.run_preflight"),
        "run_cycle": patch("bot.run.run_cycle"),
        "record_cost": patch("bot.run.record_cost"),
        "record_transcript": patch("bot.run.record_transcript"),
        "cleanup": patch("bot.run.cleanup_between_cycles"),
        "sleep_signal": patch("bot.run._read_sleep_signal", side_effect=SystemExit(0)),
        "write_signal": patch("bot.run._write_sleep_signal"),
        "post_orphan": patch("bot.run.post_orphan_cycle"),
        "idle_reminder": patch("bot.run.idle_reminder"),
        "slack_digest": patch("bot.run._try_slack_digest"),
        "push_status": patch("bot.run.push_status"),
    }
    mocks = {}
    for name, p in all_patches.items():
        mocks[name] = p.start()
    yield mocks
    for p in all_patches.values():
        p.stop()


def _run_main():
    from bot.run import main

    main()


def _cycle_result():
    ctx = SimpleNamespace(
        timed_out=False,
        work_type="code",
        jira_key=None,
        started_at=None,
        session_id="session-1",
    )
    result = SimpleNamespace(total_cost_usd=None)
    return result, ctx


async def _fake_cycle(*args, **kwargs):
    return _cycle_result()


@pytest.mark.parametrize("source", [None, "legacy"])
def test_legacy_mode_unchanged(main_patches, monkeypatch, source):
    from bot.preflight import PreflightResult

    if source is None:
        monkeypatch.delenv("REHOR_INPUT_SOURCE", raising=False)
    else:
        monkeypatch.setenv("REHOR_INPUT_SOURCE", source)
    main_patches["run_preflight"].return_value = PreflightResult(action="start", prompt="preflight data", scripts=[])
    main_patches["run_cycle"].side_effect = _fake_cycle

    with pytest.raises(SystemExit):
        _run_main()

    main_patches["run_preflight"].assert_called_once()
    main_patches["run_cycle"].assert_called_once()
    _, kwargs = main_patches["run_cycle"].call_args
    assert kwargs["preflight_prompt"] == "preflight data"
