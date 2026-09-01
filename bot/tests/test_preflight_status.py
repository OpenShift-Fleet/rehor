"""Preflight skip/error POST bot status so the dashboard check-in time is fresh."""

import sys
from unittest.mock import MagicMock, patch

import pytest

from bot.config import InstanceConfig
from bot.preflight import PreflightResult


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
    config = MagicMock()
    config.interval = 300
    config.idle_interval = 3600
    config.cycle_timeout = 600
    config.idle_reminder_cooldown_seconds = 0
    return config


@pytest.fixture
def main_patches():
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
        "run_preflight": patch("bot.run.run_preflight"),
        "run_cycle": patch("bot.run.run_cycle"),
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


def test_skip_pushes_idle_status(main_patches):
    main_patches["run_preflight"].return_value = PreflightResult(action="skip", transcript="nothing to do", scripts=[])

    with pytest.raises(SystemExit):
        _run_main()

    main_patches["push_status"].assert_called_once_with(
        "idle", "No work found. Sleeping...", instance_id="test-instance"
    )


def test_preflight_error_pushes_error_status(main_patches):
    main_patches["run_preflight"].return_value = PreflightResult(
        action="error", transcript="something broke", scripts=[]
    )

    with pytest.raises(SystemExit):
        _run_main()

    main_patches["push_status"].assert_called_once_with(
        "error", "Preflight failed — check bot.log", instance_id="test-instance"
    )
