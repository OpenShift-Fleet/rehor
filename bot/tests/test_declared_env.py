"""Declared environment-name collection for OpenCode child forwarding.

The bridge must carry NAMES only — never values — from the selected agent's
workflow/env-preset manifests and profile instance.yaml to the coordinator,
which reads values from its own process environment.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from bot.config import (
    InstanceConfig,
    active_env_declared_env_names,
    declared_environment_names,
    profile_declared_env_names,
    workflow_declared_env_names,
)

REPO_ROOT = Path(__file__).resolve().parents[2]


def _write_workflow(root: Path, name: str, requires: dict) -> Path:
    workflow_dir = root / "presets" / "workflows" / name
    workflow_dir.mkdir(parents=True, exist_ok=True)
    (workflow_dir / "manifest.yaml").write_text(
        f"name: {name}\ntype: workflow\nrequires:\n"
        + "".join(f"  {key}:\n" + "".join(f"    - {value}\n" for value in values) for key, values in requires.items())
    )
    return workflow_dir


def _write_env_preset(root: Path, name: str, requires: dict) -> None:
    env_dir = root / "presets" / "envs" / name
    env_dir.mkdir(parents=True, exist_ok=True)
    (env_dir / "manifest.yaml").write_text(
        f"name: {name}\ntype: env\nrequires:\n"
        + "".join(f"  {key}:\n" + "".join(f"    - {value}\n" for value in values) for key, values in requires.items())
    )


def _instance_config(workflow: str = "test-workflow", envs: list[str] | None = None) -> InstanceConfig:
    return InstanceConfig(workflow=workflow, envs=envs)


class TestWorkflowManifestDeclarations:
    def test_collects_required_and_optional_manifest_names(self, tmp_path):
        _write_workflow(
            tmp_path,
            "test-workflow",
            {
                "env_vars": ["BOT_LABEL", "ACME_WIDGET_BOARD"],
                "optional_env_vars": ["WIDGET_CACHE_DIR", "SLACK_DIGEST_HOUR"],
            },
        )
        names = workflow_declared_env_names(tmp_path, _instance_config())
        assert names == {"BOT_LABEL", "ACME_WIDGET_BOARD", "WIDGET_CACHE_DIR", "SLACK_DIGEST_HOUR"}

    def test_skips_invalid_manifest_entries_without_failing(self, tmp_path, caplog):
        workflow_dir = tmp_path / "presets" / "workflows" / "test-workflow"
        workflow_dir.mkdir(parents=True)
        (workflow_dir / "manifest.yaml").write_text(
            "requires:\n"
            "  env_vars:\n"
            "    - GOOD_NAME\n"
            "    - not-a-name!\n"
            "    - 42\n"
            "  optional_env_vars:\n"
            "    - ALSO_GOOD\n"
        )
        names = workflow_declared_env_names(tmp_path, _instance_config())
        assert names == {"GOOD_NAME", "ALSO_GOOD"}
        assert "Skipping invalid declared env var name" in caplog.text

    def test_missing_manifest_yields_nothing(self, tmp_path):
        assert workflow_declared_env_names(tmp_path, _instance_config()) == set()


class TestEnvPresetDeclarations:
    def test_collects_active_preset_names_only(self, tmp_path):
        _write_env_preset(
            tmp_path,
            "slackish",
            {
                "env_vars": ["SLACK_WEBHOOK_URL"],
                "optional_env_vars": ["SLACK_NOTIFY_MODE", "SLACK_DIGEST_HOUR"],
            },
        )
        _write_env_preset(
            tmp_path,
            "other",
            {"env_vars": ["OTHER_PRESET_VALUE"]},
        )
        active = active_env_declared_env_names(tmp_path, ["slackish"])
        assert active == {"SLACK_WEBHOOK_URL", "SLACK_NOTIFY_MODE", "SLACK_DIGEST_HOUR"}

    def test_real_slack_preset_declares_digest_hour(self):
        # Regression: the fixed operational allowlist dropped SLACK_DIGEST_HOUR
        # even when configured; the declared mechanism must carry it.
        names = active_env_declared_env_names(REPO_ROOT, ["slack"])
        assert names == {"SLACK_WEBHOOK_URL", "SLACK_NOTIFY_MODE", "SLACK_DIGEST_HOUR"}


class TestProfileDeclarations:
    def test_collects_env_category_names_without_values(self, tmp_path):
        profile = tmp_path / "agent"
        profile.mkdir()
        (profile / "instance.yaml").write_text(
            "workflow: test-workflow\nenv:\n  BOT_ACME_QUEUE_DEPTH: '7'\n  ACME_TEAM_UUID: team-uuid-value\n"
        )
        env_names, sandbox_names = profile_declared_env_names(profile)
        assert env_names == {"BOT_ACME_QUEUE_DEPTH", "ACME_TEAM_UUID"}
        assert sandbox_names == set()

    def test_collects_legacy_preflight_env_category(self, tmp_path):
        profile = tmp_path / "agent"
        profile.mkdir()
        (profile / "instance.yaml").write_text(
            "workflow: test-workflow\npreflight:\n  env:\n    BOT_LEGACY_SETTING: legacy-value\n"
        )
        env_names, _ = profile_declared_env_names(profile)
        assert env_names == {"BOT_LEGACY_SETTING"}

    def test_collects_sandbox_env_names_in_a_separate_provenance(self, tmp_path):
        profile = tmp_path / "agent"
        profile.mkdir()
        (profile / "instance.yaml").write_text(
            "workflow: test-workflow\n"
            "sandbox:\n"
            "  env:\n"
            "    TEAM_SERVICE_TOKEN: secret-render-placeholder\n"
            "    FABRIC_JIRA_PROJECT: PROJ\n"
        )
        env_names, sandbox_names = profile_declared_env_names(profile)
        assert env_names == set()
        assert sandbox_names == {"TEAM_SERVICE_TOKEN", "FABRIC_JIRA_PROJECT"}

    def test_conflicting_env_and_preflight_categories_are_skipped(self, tmp_path, caplog):
        profile = tmp_path / "agent"
        profile.mkdir()
        (profile / "instance.yaml").write_text(
            "workflow: test-workflow\nenv:\n  BOT_ONE: one\npreflight:\n  env:\n    BOT_TWO: two\n"
        )
        env_names, _ = profile_declared_env_names(profile)
        assert env_names == set()
        assert "both env and preflight.env" in caplog.text

    def test_malformed_categories_are_skipped(self, tmp_path, caplog):
        profile = tmp_path / "agent"
        profile.mkdir()
        (profile / "instance.yaml").write_text("workflow: test-workflow\nenv: not-a-mapping\nsandbox: not-a-mapping\n")
        env_names, sandbox_names = profile_declared_env_names(profile)
        assert env_names == set()
        assert sandbox_names == set()

    def test_missing_profile_yields_nothing(self, tmp_path):
        assert profile_declared_env_names(None) == (set(), set())
        assert profile_declared_env_names(tmp_path) == (set(), set())

    def test_invalid_names_are_skipped(self, tmp_path, caplog):
        profile = tmp_path / "agent"
        profile.mkdir()
        (profile / "instance.yaml").write_text("workflow: test-workflow\nenv:\n  ? 42\n  : value\n")
        env_names, _ = profile_declared_env_names(profile)
        assert env_names == set()
        assert "Skipping invalid declared env var name" in caplog.text

    def test_profile_specific_isolation(self, tmp_path):
        first = tmp_path / "first" / "agent"
        second = tmp_path / "second" / "agent"
        first.mkdir(parents=True)
        second.mkdir(parents=True)
        (first / "instance.yaml").write_text("workflow: w\nenv:\n  FIRST_ONLY: a\n")
        (second / "instance.yaml").write_text("workflow: w\nenv:\n  SECOND_ONLY: b\n")
        assert profile_declared_env_names(first)[0] == {"FIRST_ONLY"}
        assert profile_declared_env_names(second)[0] == {"SECOND_ONLY"}


class TestDeclaredEnvironmentNames:
    def test_unions_all_sources_sorted_and_deduplicated(self, tmp_path):
        _write_workflow(
            tmp_path,
            "test-workflow",
            {"env_vars": ["BOT_LABEL"], "optional_env_vars": ["SLACK_DIGEST_HOUR"]},
        )
        _write_env_preset(tmp_path, "slackish", {"optional_env_vars": ["SLACK_DIGEST_HOUR", "EXTRA"]})
        profile = tmp_path / "agent"
        profile.mkdir()
        (profile / "instance.yaml").write_text(
            "workflow: test-workflow\n"
            "envs: [slackish]\n"
            "env:\n"
            "  BOT_ACME_QUEUE_DEPTH: '7'\n"
            "sandbox:\n"
            "  env:\n"
            "    TEAM_SERVICE_TOKEN: secret-render\n"
        )
        declared, declared_sandbox = declared_environment_names(tmp_path, _instance_config(envs=["slackish"]), profile)
        assert declared == [
            "BOT_ACME_QUEUE_DEPTH",
            "BOT_LABEL",
            "EXTRA",
            "SLACK_DIGEST_HOUR",
        ]
        assert declared_sandbox == ["TEAM_SERVICE_TOKEN"]

    def test_inactive_env_preset_names_are_not_declared(self, tmp_path):
        _write_workflow(tmp_path, "test-workflow", {"optional_env_vars": ["BOT_LABEL"]})
        _write_env_preset(tmp_path, "slackish", {"optional_env_vars": ["SLACK_DIGEST_HOUR"]})
        profile = tmp_path / "agent"
        profile.mkdir()
        (profile / "instance.yaml").write_text("workflow: test-workflow\nenvs: []\n")
        declared, _ = declared_environment_names(tmp_path, _instance_config(envs=[]), profile)
        assert declared == ["BOT_LABEL"]

    def test_per_cycle_change_and_removal(self, tmp_path):
        _write_workflow(tmp_path, "test-workflow", {})
        profile = tmp_path / "agent"
        profile.mkdir()
        instance = profile / "instance.yaml"
        instance.write_text("workflow: test-workflow\nenv:\n  FIRST_SETTING: a\n")
        config = _instance_config()
        assert declared_environment_names(tmp_path, config, profile)[0] == ["FIRST_SETTING"]
        instance.write_text("workflow: test-workflow\nenv:\n  FIRST_SETTING: a\n  SECOND_SETTING: b\n")
        assert declared_environment_names(tmp_path, config, profile)[0] == [
            "FIRST_SETTING",
            "SECOND_SETTING",
        ]
        instance.write_text("workflow: test-workflow\nenv:\n  SECOND_SETTING: b\n")
        assert declared_environment_names(tmp_path, config, profile)[0] == ["SECOND_SETTING"]


@pytest.fixture
def prepare_environment(tmp_path, monkeypatch):
    import bot.merge as merge
    import bot.run as runner

    _write_workflow(
        tmp_path,
        "test-workflow",
        {
            "env_vars": ["BOT_LABEL"],
            "optional_env_vars": ["BOT_BOARD_ID", "SLACK_WEBHOOK_URL"],
        },
    )
    _write_env_preset(
        tmp_path,
        "slackish",
        {"optional_env_vars": ["SLACK_NOTIFY_MODE", "SLACK_DIGEST_HOUR"]},
    )
    profile_dir = tmp_path / "profile" / "agent"
    profile_dir.mkdir(parents=True)
    (profile_dir / "instance.yaml").write_text(
        "workflow: test-workflow\n"
        "source: github\n"
        "envs: [slackish]\n"
        "runtime: opencode\n"
        "provider: rehor-openai\n"
        "env:\n"
        "  BOT_ACME_QUEUE_DEPTH: queue-depth-sentinel\n"
        "sandbox:\n"
        "  env:\n"
        "    TEAM_SERVICE_TOKEN: tier-2-sentinel\n"
        "    FABRIC_JIRA_PROJECT: project-name-sentinel\n"
    )
    (tmp_path / "config.json").write_text(
        '{"claude": {"model": "claude-test-model", "maxTurns": 10}, '
        '"opencode": {"model": "test-model"}, '
        '"polling": {"intervalSeconds": 300, "idleIntervalSeconds": 60, '
        '"idleReminderCooldownSeconds": 3600}, "jira": {"boardKey": "TEST"}}'
    )
    bot_dir = tmp_path / "bot"
    bot_dir.mkdir()
    (bot_dir / "mcp.json").write_text("{}")
    (tmp_path / ".mcp.json").write_text("{}")
    monkeypatch.setattr(runner, "SCRIPT_DIR", tmp_path)
    monkeypatch.setenv("BOT_LABEL", "test-label")
    monkeypatch.setattr(runner, "setup_git", lambda script_dir: None)
    monkeypatch.setattr(runner, "sync_config_repo", lambda label: (profile_dir, None))
    monkeypatch.setattr(runner, "assemble_claude_md", lambda *args: None)
    monkeypatch.setattr(merge, "apply_merged_config", lambda *args: None)
    monkeypatch.setattr(merge, "install_skills", lambda *args: [])
    return tmp_path, profile_dir


class TestBridgePreparation:
    def test_prepare_returns_declared_names_without_values(self, prepare_environment):
        from bot.coordinator_bridge import handle

        tmp_path, _ = prepare_environment
        result = handle(
            {
                "protocolVersion": 1,
                "operation": "prepare",
                "scriptDir": str(tmp_path),
                "label": "test-label",
            }
        )
        assert result["declaredEnvVars"] == [
            "BOT_ACME_QUEUE_DEPTH",
            "BOT_BOARD_ID",
            "BOT_LABEL",
            "SLACK_DIGEST_HOUR",
            "SLACK_NOTIFY_MODE",
            "SLACK_WEBHOOK_URL",
        ]
        assert result["declaredSandboxEnvVars"] == ["FABRIC_JIRA_PROJECT", "TEAM_SERVICE_TOKEN"]
        # Names only: no declared or tier-2 value may cross the bridge boundary.
        serialized = json.dumps(result)
        for value in ("queue-depth-sentinel", "tier-2-sentinel", "project-name-sentinel"):
            assert value not in serialized

    def test_prepare_tracks_per_cycle_profile_changes(self, prepare_environment):
        from bot.coordinator_bridge import handle

        tmp_path, profile_dir = prepare_environment
        request = {
            "protocolVersion": 1,
            "operation": "prepare",
            "scriptDir": str(tmp_path),
            "label": "test-label",
        }
        first = handle(request)
        assert first["declaredSandboxEnvVars"] == ["FABRIC_JIRA_PROJECT", "TEAM_SERVICE_TOKEN"]
        (profile_dir / "instance.yaml").write_text(
            "workflow: test-workflow\n"
            "source: github\n"
            "envs: [slackish]\n"
            "runtime: opencode\n"
            "provider: rehor-openai\n"
            "sandbox:\n"
            "  env:\n"
            "    FABRIC_JIRA_PROJECT: PROJ\n"
        )
        second = handle(request)
        assert second["declaredSandboxEnvVars"] == ["FABRIC_JIRA_PROJECT"]
        assert "BOT_ACME_QUEUE_DEPTH" not in second["declaredEnvVars"]
