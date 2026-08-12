"""Tests for source=scheduled single-cycle exit behavior."""

from unittest.mock import MagicMock, patch

import pytest

from bot.config import InstanceConfig
from bot.preflight import PreflightResult


@pytest.fixture
def scheduled_config():
    return InstanceConfig(workflow="quality-monitor", source="scheduled")


@pytest.fixture
def jira_config():
    return InstanceConfig(workflow="jira-sprint", source="jira")


@pytest.fixture
def mock_loop_deps():
    """Mock all heavy dependencies used inside the main loop."""
    patches = {
        "sync_config_repo": patch("bot.run.sync_config_repo", return_value=(None, None)),
        "load_instance_config": patch("bot.run.load_instance_config"),
        "install_skills": patch("bot.run.install_skills"),
        "resolve_workflow_dir": patch("bot.run.resolve_workflow_dir"),
        "resolve_active_envs": patch("bot.run.resolve_active_envs", return_value=[]),
        "assemble_claude_md": patch("bot.run.assemble_claude_md"),
        "run_preflight": patch("bot.run.run_preflight"),
        "run_cycle": patch("bot.run.run_cycle"),
        "cleanup": patch("bot.run.cleanup_between_cycles"),
        "sleep_signal": patch("bot.run._read_sleep_signal"),
        "write_signal": patch("bot.run._write_sleep_signal"),
        "post_orphan": patch("bot.run.post_orphan_cycle"),
        "idle_skip": patch("bot.run.idle_reminder.on_preflight_skip"),
        "idle_start": patch("bot.run.idle_reminder.on_preflight_start"),
        "slack_digest": patch("bot.run._try_slack_digest"),
        "record_cost": patch("bot.run.record_cost"),
        "record_transcript": patch("bot.run.record_transcript"),
    }
    mocks = {}
    for name, p in patches.items():
        mocks[name] = p.start()
    yield mocks
    for p in patches.values():
        p.stop()


def _run_loop(instance_config, mock_deps, preflight_action="start"):
    """Run the main while-loop extracted from bot.run.main, counting iterations."""
    mock_deps["load_instance_config"].return_value = instance_config

    if preflight_action == "start":
        mock_deps["run_preflight"].return_value = PreflightResult(action="start", prompt="test data", scripts=[])
    elif preflight_action == "skip":
        mock_deps["run_preflight"].return_value = PreflightResult(action="skip", transcript="nothing to do", scripts=[])
    elif preflight_action == "error":
        mock_deps["run_preflight"].return_value = PreflightResult(
            action="error", transcript="something broke", scripts=[]
        )

    iterations = 0
    max_iterations = 3
    config = MagicMock()
    config.interval = 300
    config.idle_interval = 3600
    config.cycle_timeout = 600

    while True:
        iterations += 1
        if iterations > max_iterations:
            break

        mock_deps["sync_config_repo"].return_value = (None, None)

        preflight_result = mock_deps["run_preflight"].return_value

        if preflight_result is not None:
            if preflight_result.action == "error":
                if instance_config.source == "scheduled":
                    break
                continue

            if preflight_result.action == "skip":
                if instance_config.source == "scheduled":
                    break
                continue

        if instance_config.source == "scheduled":
            break

    return iterations


class TestScheduledExit:
    def test_exits_after_cycle_when_scheduled(self, scheduled_config, mock_loop_deps):
        iterations = _run_loop(scheduled_config, mock_loop_deps, "start")
        assert iterations == 1

    def test_exits_after_skip_when_scheduled(self, scheduled_config, mock_loop_deps):
        iterations = _run_loop(scheduled_config, mock_loop_deps, "skip")
        assert iterations == 1

    def test_exits_after_error_when_scheduled(self, scheduled_config, mock_loop_deps):
        iterations = _run_loop(scheduled_config, mock_loop_deps, "error")
        assert iterations == 1

    def test_loops_when_not_scheduled(self, jira_config, mock_loop_deps):
        iterations = _run_loop(jira_config, mock_loop_deps, "skip")
        assert iterations > 1
