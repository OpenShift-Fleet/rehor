"""Tests for instance.yaml loading, env var fallback, and validation."""

import os
from unittest.mock import patch

import pytest
import yaml

from bot.config import InstanceConfig, load_instance_config, resolve_active_envs, validate_instance_config


@pytest.fixture
def preset_tree(tmp_path):
    """Minimal preset tree with workflow + env presets."""
    wf = tmp_path / "presets" / "workflows" / "jira-sprint"
    wf.mkdir(parents=True)
    (wf / "CLAUDE.md").write_text("# Jira Sprint Workflow\n")

    for env_name, manifest in [
        ("browser", {"name": "browser", "requires": {"env_vars": ["PLAYWRIGHT_BROWSERS_PATH"]}}),
        ("slack", {"name": "slack", "requires": {"env_vars": ["SLACK_WEBHOOK_URL"]}}),
        ("container-scan", {"name": "container-scan"}),
    ]:
        d = tmp_path / "presets" / "envs" / env_name
        d.mkdir(parents=True)
        (d / "manifest.yaml").write_text(yaml.dump(manifest))

    return tmp_path


@pytest.fixture
def agent_dir(tmp_path):
    """Remote agent dir with instance.yaml."""
    d = tmp_path / "agent"
    d.mkdir()
    return d


class TestInstanceConfigFromYaml:
    def test_full_config(self, agent_dir):
        (agent_dir / "instance.yaml").write_text(
            yaml.dump(
                {
                    "workflow": "reviewer",
                    "source": "github",
                    "envs": ["browser"],
                    "claude_md": {"strategy": "append"},
                }
            )
        )
        ic = InstanceConfig.from_yaml(agent_dir / "instance.yaml")
        assert ic.workflow == "reviewer"
        assert ic.source == "github"
        assert ic.envs == ["browser"]
        assert ic.claude_md_strategy == "append"

    def test_minimal_config(self, agent_dir):
        (agent_dir / "instance.yaml").write_text("workflow: jira-sprint\n")
        ic = InstanceConfig.from_yaml(agent_dir / "instance.yaml")
        assert ic.workflow == "jira-sprint"
        assert ic.source == "jira"
        assert ic.envs is None
        assert ic.claude_md_strategy == "ignore"

    def test_empty_envs(self, agent_dir):
        (agent_dir / "instance.yaml").write_text(yaml.dump({"workflow": "jira-sprint", "envs": []}))
        ic = InstanceConfig.from_yaml(agent_dir / "instance.yaml")
        assert ic.envs == []

    def test_empty_file(self, agent_dir):
        (agent_dir / "instance.yaml").write_text("")
        ic = InstanceConfig.from_yaml(agent_dir / "instance.yaml")
        assert ic.workflow == "jira-sprint"
        assert ic.envs is None

    def test_replace_strategy(self, agent_dir):
        (agent_dir / "instance.yaml").write_text(yaml.dump({"claude_md": {"strategy": "replace"}}))
        ic = InstanceConfig.from_yaml(agent_dir / "instance.yaml")
        assert ic.claude_md_strategy == "replace"


class TestInstanceConfigFromEnv:
    def test_defaults(self):
        with patch.dict(os.environ, {}, clear=True):
            ic = InstanceConfig.from_env()
        assert ic.workflow == "jira-sprint"
        assert ic.envs is None

    def test_custom_workflow(self):
        with patch.dict(os.environ, {"BOT_WORKFLOW_PRESET": "reviewer"}, clear=True):
            ic = InstanceConfig.from_env()
        assert ic.workflow == "reviewer"

    def test_env_presets_list(self):
        with patch.dict(os.environ, {"BOT_ENV_PRESETS": "browser,slack"}, clear=True):
            ic = InstanceConfig.from_env()
        assert ic.envs == ["browser", "slack"]

    def test_env_presets_empty_string(self):
        with patch.dict(os.environ, {"BOT_ENV_PRESETS": ""}, clear=True):
            ic = InstanceConfig.from_env()
        assert ic.envs == []

    def test_env_presets_with_spaces(self):
        with patch.dict(os.environ, {"BOT_ENV_PRESETS": " browser , slack "}, clear=True):
            ic = InstanceConfig.from_env()
        assert ic.envs == ["browser", "slack"]


class TestLoadInstanceConfig:
    def test_from_yaml(self, agent_dir):
        (agent_dir / "instance.yaml").write_text(yaml.dump({"workflow": "reviewer", "envs": ["browser"]}))
        ic = load_instance_config(agent_dir)
        assert ic.workflow == "reviewer"
        assert ic.envs == ["browser"]

    def test_no_yaml_falls_back_to_env(self, agent_dir):
        with patch.dict(os.environ, {"BOT_WORKFLOW_PRESET": "kanban"}, clear=True):
            ic = load_instance_config(agent_dir)
        assert ic.workflow == "kanban"

    def test_no_agent_dir(self):
        with patch.dict(os.environ, {}, clear=True):
            ic = load_instance_config(None)
        assert ic.workflow == "jira-sprint"
        assert ic.envs is None


class TestResolveActiveEnvs:
    def test_explicit_list(self, preset_tree):
        ic = InstanceConfig(envs=["browser", "slack"])
        assert resolve_active_envs(preset_tree, ic) == ["browser", "slack"]

    def test_none_returns_all(self, preset_tree):
        ic = InstanceConfig(envs=None)
        result = resolve_active_envs(preset_tree, ic)
        assert "browser" in result
        assert "slack" in result
        assert "container-scan" in result

    def test_empty_list(self, preset_tree):
        ic = InstanceConfig(envs=[])
        assert resolve_active_envs(preset_tree, ic) == []

    def test_no_envs_dir(self, tmp_path):
        (tmp_path / "presets" / "workflows" / "jira-sprint").mkdir(parents=True)
        ic = InstanceConfig(envs=None)
        assert resolve_active_envs(tmp_path, ic) == []


class TestValidateInstanceConfig:
    def test_valid_config(self, preset_tree):
        ic = InstanceConfig(envs=["browser"])
        env = {"PLAYWRIGHT_BROWSERS_PATH": "/opt/pw"}
        with patch.dict(os.environ, env, clear=False):
            validate_instance_config(preset_tree, ic)

    def test_missing_workflow_exits(self, preset_tree):
        ic = InstanceConfig(workflow="nonexistent")
        with pytest.raises(SystemExit) as exc_info:
            validate_instance_config(preset_tree, ic)
        assert exc_info.value.code == 1

    def test_missing_env_preset_warns(self, preset_tree, caplog):
        ic = InstanceConfig(envs=["browser", "nonexistent"])
        env = {"PLAYWRIGHT_BROWSERS_PATH": "/opt/pw"}
        with patch.dict(os.environ, env, clear=False):
            validate_instance_config(preset_tree, ic)
        assert "nonexistent" in caplog.text
        assert "not found" in caplog.text

    def test_missing_env_var_warns(self, preset_tree, caplog):
        ic = InstanceConfig(envs=["slack"])
        with patch.dict(os.environ, {}, clear=True):
            validate_instance_config(preset_tree, ic)
        assert "SLACK_WEBHOOK_URL" in caplog.text

    def test_all_envs_default(self, preset_tree, caplog):
        import logging

        ic = InstanceConfig(envs=None)
        env = {"PLAYWRIGHT_BROWSERS_PATH": "/opt/pw", "SLACK_WEBHOOK_URL": "https://hooks.slack.com/x"}
        with caplog.at_level(logging.INFO):
            with patch.dict(os.environ, env, clear=False):
                validate_instance_config(preset_tree, ic)
        assert "browser" in caplog.text
        assert "container-scan" in caplog.text
