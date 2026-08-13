"""Tests for source=scheduled single-cycle exit behavior.

Calls the actual main() function with mocked dependencies to verify
the real production loop exits after one iteration for scheduled sources.
"""

from unittest.mock import MagicMock, patch

import pytest

from bot.config import InstanceConfig
from bot.preflight import PreflightResult


def _mock_config():
    config = MagicMock()
    config.interval = 300
    config.idle_interval = 3600
    config.cycle_timeout = 600
    config.idle_reminder_cooldown_seconds = 0
    return config


async def _fake_run_cycle(**kwargs):
    result = MagicMock()
    ctx = MagicMock()
    ctx.work_type = "scan"
    return result, ctx


@pytest.fixture
def main_patches():
    """Patch all main() dependencies so it can run in a test."""
    instance_config = InstanceConfig(workflow="quality-monitor", source="keda_scheduled")

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
        "run_cycle": patch("bot.run.run_cycle", side_effect=_fake_run_cycle),
        "cleanup": patch("bot.run.cleanup_between_cycles"),
        "sleep_signal": patch("bot.run._read_sleep_signal"),
        "write_signal": patch("bot.run._write_sleep_signal"),
        "post_orphan": patch("bot.run.post_orphan_cycle"),
        "idle_reminder": patch("bot.run.idle_reminder"),
        "slack_digest": patch("bot.run._try_slack_digest"),
        "record_cost": patch("bot.run.record_cost"),
        "record_transcript": patch("bot.run.record_transcript"),
    }
    mocks = {}
    for name, p in all_patches.items():
        mocks[name] = p.start()
    yield mocks
    for p in all_patches.values():
        p.stop()


def _run_main():
    """Import and call main() inside the patched context."""
    from bot.run import main

    main()


def _loop_call_count(main_patches):
    """Count how many times the loop body ran (sync_config_repo is called once
    before the loop and once per iteration, so loop iterations = total - 1)."""
    return main_patches["sync_config_repo"].call_count - 1


class TestScheduledExit:
    """Verify main() exits after a single loop iteration when source=keda_scheduled."""

    def test_exits_after_preflight_start(self, main_patches):
        main_patches["run_preflight"].return_value = PreflightResult(action="start", prompt="test data", scripts=[])

        _run_main()

        assert _loop_call_count(main_patches) == 1

    def test_exits_after_preflight_skip(self, main_patches):
        main_patches["run_preflight"].return_value = PreflightResult(
            action="skip", transcript="nothing to do", scripts=[]
        )

        _run_main()

        assert _loop_call_count(main_patches) == 1

    @patch("bot.run.time.sleep")
    def test_retries_then_exits_after_preflight_errors(self, mock_sleep, main_patches):
        main_patches["run_preflight"].return_value = PreflightResult(
            action="error", transcript="something broke", scripts=[]
        )

        _run_main()

        assert _loop_call_count(main_patches) == 3
        assert mock_sleep.call_count == 2
        mock_sleep.assert_called_with(30)

    @patch("bot.run.time.sleep")
    def test_recovers_from_transient_preflight_error(self, mock_sleep, main_patches):
        call_count = 0

        def error_then_skip(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return PreflightResult(action="error", transcript="transient", scripts=[])
            return PreflightResult(action="skip", transcript="ok now", scripts=[])

        main_patches["run_preflight"].side_effect = error_then_skip

        _run_main()

        assert _loop_call_count(main_patches) == 2
        mock_sleep.assert_called_once_with(30)

    def test_non_scheduled_loops(self, main_patches):
        main_patches["load_instance_config"].return_value = InstanceConfig(workflow="jira-sprint", source="jira")
        main_patches["run_preflight"].return_value = PreflightResult(
            action="skip", transcript="nothing to do", scripts=[]
        )

        call_count = 0

        def counting_sync(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count > 3:
                raise SystemExit(0)
            return (None, None)

        main_patches["sync_config_repo"].side_effect = counting_sync

        from bot.run import main

        with pytest.raises(SystemExit):
            main()

        loop_iterations = call_count - 1
        assert loop_iterations >= 2
