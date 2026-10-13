"""Tests for instance.yaml loading, env var fallback, and validation."""

import os
from unittest.mock import patch

import pytest
import yaml

from bot.config import (
    Config,
    InstanceConfig,
    load_instance_config,
    resolve_active_envs,
    resolve_cycle_model,
    validate_instance_config,
)
from bot.run import validate_python_runner_selection


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
                    "runtime": "opencode-v1",
                    "provider": "rehor-openai",
                }
            )
        )
        ic = InstanceConfig.from_yaml(agent_dir / "instance.yaml")
        assert ic.workflow == "reviewer"
        assert ic.source == "github"
        assert ic.envs == ["browser"]
        assert ic.claude_md_strategy == "append"
        assert ic.runtime == "opencode-v1"
        assert ic.provider == "rehor-openai"

    def test_opencode_runtime_defaults_to_native_provider(self, agent_dir):
        (agent_dir / "instance.yaml").write_text("runtime: opencode-v1\n")
        with patch.dict(os.environ, {}, clear=True):
            ic = InstanceConfig.from_yaml(agent_dir / "instance.yaml")
        assert ic.runtime == "opencode-v1"
        assert ic.provider == "rehor-openai"

    def test_minimal_config(self, agent_dir):
        (agent_dir / "instance.yaml").write_text("workflow: jira-sprint\n")
        ic = InstanceConfig.from_yaml(agent_dir / "instance.yaml")
        assert ic.workflow == "jira-sprint"
        assert ic.source == "jira"
        assert ic.envs is None
        assert ic.claude_md_strategy == "ignore"
        assert ic.idle_cycle_limit == 0
        assert ic.model is None
        assert ic.runtime == "claude"
        assert ic.provider == "vertex"

    def test_with_model(self, agent_dir):
        (agent_dir / "instance.yaml").write_text(yaml.dump({"workflow": "jira-sprint", "model": "claude-sonnet-4-6"}))
        ic = InstanceConfig.from_yaml(agent_dir / "instance.yaml")
        assert ic.model == "claude-sonnet-4-6"

    def test_model_empty_and_whitespace(self, agent_dir):
        (agent_dir / "instance.yaml").write_text(yaml.dump({"workflow": "jira-sprint", "model": "   "}))
        ic = InstanceConfig.from_yaml(agent_dir / "instance.yaml")
        assert ic.model is None

        (agent_dir / "instance.yaml").write_text(yaml.dump({"workflow": "jira-sprint", "model": ""}))
        ic = InstanceConfig.from_yaml(agent_dir / "instance.yaml")
        assert ic.model is None

    def test_model_non_string(self, agent_dir):
        (agent_dir / "instance.yaml").write_text(yaml.dump({"workflow": "jira-sprint", "model": True}))
        ic = InstanceConfig.from_yaml(agent_dir / "instance.yaml")
        assert ic.model is None

        (agent_dir / "instance.yaml").write_text(yaml.dump({"workflow": "jira-sprint", "model": 123}))
        ic = InstanceConfig.from_yaml(agent_dir / "instance.yaml")
        assert ic.model is None

    def test_idle_cycle_limit(self, agent_dir):
        (agent_dir / "instance.yaml").write_text(yaml.dump({"workflow": "jira-sprint", "idle_cycle_limit": 10}))
        ic = InstanceConfig.from_yaml(agent_dir / "instance.yaml")
        assert ic.idle_cycle_limit == 10

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
        assert ic.model is None

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

    def test_bot_model_env(self):
        with patch.dict(os.environ, {"BOT_MODEL": "claude-haiku-4-5"}, clear=True):
            ic = InstanceConfig.from_env()
        assert ic.model == "claude-haiku-4-5"

    def test_bot_model_empty_and_whitespace(self):
        with patch.dict(os.environ, {"BOT_MODEL": "   "}, clear=True):
            ic = InstanceConfig.from_env()
        assert ic.model is None

    def test_runtime_and_provider_env(self):
        with patch.dict(
            os.environ,
            {"BOT_RUNTIME": "opencode-v1", "BOT_PROVIDER": "rehor-openai"},
            clear=True,
        ):
            ic = InstanceConfig.from_env()
        assert ic.runtime == "opencode-v1"
        assert ic.provider == "rehor-openai"

    def test_opencode_runtime_defaults_to_native_openai_provider(self):
        with patch.dict(os.environ, {"BOT_RUNTIME": "opencode-v1"}, clear=True):
            ic = InstanceConfig.from_env()
        assert ic.runtime == "opencode-v1"
        assert ic.provider == "rehor-openai"


class TestLoadInstanceConfig:
    def test_from_yaml(self, agent_dir):
        (agent_dir / "instance.yaml").write_text(yaml.dump({"workflow": "reviewer", "envs": ["browser"]}))
        ic = load_instance_config(agent_dir)
        assert ic.workflow == "reviewer"
        assert ic.envs == ["browser"]
        assert ic.model is None

    def test_from_yaml_with_model(self, agent_dir):
        (agent_dir / "instance.yaml").write_text(yaml.dump({"workflow": "reviewer", "model": "claude-sonnet-4-6"}))
        ic = load_instance_config(agent_dir)
        assert ic.workflow == "reviewer"
        assert ic.model == "claude-sonnet-4-6"

    def test_from_yaml_model_wins_over_bot_model_env(self, agent_dir):
        (agent_dir / "instance.yaml").write_text(yaml.dump({"workflow": "reviewer", "model": "claude-yaml-pin"}))
        with patch.dict(os.environ, {"BOT_MODEL": "claude-env-overlay"}, clear=True):
            ic = load_instance_config(agent_dir)
        assert ic.model == "claude-yaml-pin"

    def test_from_yaml_omits_model_overlays_bot_model(self, agent_dir):
        (agent_dir / "instance.yaml").write_text(yaml.dump({"workflow": "reviewer"}))
        with patch.dict(os.environ, {"BOT_MODEL": "claude-env-overlay"}, clear=True):
            ic = load_instance_config(agent_dir)
        assert ic.model == "claude-env-overlay"

    def test_from_yaml_runtime_and_provider_win_over_env(self, agent_dir):
        (agent_dir / "instance.yaml").write_text(
            yaml.dump({"workflow": "reviewer", "runtime": "claude", "provider": "vertex"})
        )
        with patch.dict(
            os.environ,
            {"BOT_RUNTIME": "opencode-v1", "BOT_PROVIDER": "rehor-openai"},
            clear=True,
        ):
            ic = load_instance_config(agent_dir)
        assert ic.runtime == "claude"
        assert ic.provider == "vertex"

    def test_from_yaml_omits_runtime_and_provider_overlays_env(self, agent_dir):
        (agent_dir / "instance.yaml").write_text(yaml.dump({"workflow": "reviewer"}))
        with patch.dict(
            os.environ,
            {"BOT_RUNTIME": "opencode-v1", "BOT_PROVIDER": "rehor-openai"},
            clear=True,
        ):
            ic = load_instance_config(agent_dir)
        assert ic.runtime == "opencode-v1"
        assert ic.provider == "rehor-openai"

    def test_no_yaml_falls_back_to_env(self, agent_dir):
        with patch.dict(os.environ, {"BOT_WORKFLOW_PRESET": "kanban", "BOT_MODEL": "claude-opus-4-6"}, clear=True):
            ic = load_instance_config(agent_dir)
        assert ic.workflow == "kanban"
        assert ic.model == "claude-opus-4-6"

    def test_no_agent_dir(self):
        with patch.dict(os.environ, {}, clear=True):
            ic = load_instance_config(None)
        assert ic.workflow == "jira-sprint"
        assert ic.envs is None
        assert ic.model is None


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

    @pytest.mark.parametrize("runtime", ["unknown", "opencode_v1", ""])
    def test_invalid_runtime_exits(self, preset_tree, runtime):
        ic = InstanceConfig(runtime=runtime)
        with pytest.raises(SystemExit) as exc_info:
            validate_instance_config(preset_tree, ic)
        assert exc_info.value.code == 1

    @pytest.mark.parametrize("provider", ["unknown", "openai", ""])
    def test_invalid_provider_exits(self, preset_tree, provider):
        ic = InstanceConfig(provider=provider)
        with pytest.raises(SystemExit) as exc_info:
            validate_instance_config(preset_tree, ic)
        assert exc_info.value.code == 1

    def test_claude_runtime_rejects_non_vertex_provider(self, preset_tree):
        ic = InstanceConfig(runtime="claude", provider="rehor-openai")
        with pytest.raises(SystemExit) as exc_info:
            validate_instance_config(preset_tree, ic)
        assert exc_info.value.code == 1

    def test_opencode_runtime_accepts_chat_completions_provider(self, preset_tree):
        ic = InstanceConfig(runtime="opencode-v1", provider="rehor-openai-chat")
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
        with caplog.at_level(logging.INFO), patch.dict(os.environ, env, clear=False):
            validate_instance_config(preset_tree, ic)
        assert "browser" in caplog.text
        assert "container-scan" in caplog.text


class TestValidatePythonRunnerSelection:
    def test_default_selection_is_supported(self):
        validate_python_runner_selection(InstanceConfig())

    @pytest.mark.parametrize(
        "selection",
        [
            {"runtime": "opencode-v1", "provider": "rehor-openai"},
            {"runtime": "opencode-v1", "provider": "vertex"},
        ],
    )
    def test_non_default_selection_fails_closed(self, selection):
        with pytest.raises(SystemExit) as exc_info:
            validate_python_runner_selection(InstanceConfig(**selection))
        assert exc_info.value.code == 1


@pytest.fixture
def global_config():
    return Config(
        model="claude-global-default",
        max_turns=10,
        interval=300,
        idle_interval=300,
        cycle_timeout=600,
        board_key="RHCLOUD",
        opencode_model="gpt-6-luna",
        model_tiers={"light": "claude-sonnet-4-6", "heavy": "claude-opus-4-6"},
    )


class TestResolveCycleModel:
    def test_instance_pin_wins(self, preset_tree, global_config):
        """Tier 1: instance.yaml model overrides workflow tier and global config."""
        ic = InstanceConfig(workflow="jira-sprint", model="claude-instance-pin")
        wf_manifest = preset_tree / "presets" / "workflows" / "jira-sprint" / "manifest.yaml"
        wf_manifest.write_text(yaml.dump({"name": "jira-sprint", "model_tier": "light"}))

        resolved = resolve_cycle_model(preset_tree, ic, global_config)
        assert resolved == "claude-instance-pin"

    def test_workflow_model_tier_resolution(self, preset_tree, global_config):
        """Tier 3: workflow model_tier is mapped through config.json claude.modelTiers."""
        ic = InstanceConfig(workflow="jira-sprint", model=None)
        wf_manifest = preset_tree / "presets" / "workflows" / "jira-sprint" / "manifest.yaml"
        wf_manifest.write_text(yaml.dump({"name": "jira-sprint", "model_tier": "light"}))

        resolved = resolve_cycle_model(preset_tree, ic, global_config)
        assert resolved == "claude-sonnet-4-6"

    def test_workflow_model_tier_heavy(self, preset_tree, global_config):
        ic = InstanceConfig(workflow="jira-sprint", model=None)
        wf_manifest = preset_tree / "presets" / "workflows" / "jira-sprint" / "manifest.yaml"
        wf_manifest.write_text(yaml.dump({"name": "jira-sprint", "model_tier": "heavy"}))

        resolved = resolve_cycle_model(preset_tree, ic, global_config)
        assert resolved == "claude-opus-4-6"

    def test_workflow_unknown_tier_logs_error_and_falls_back(self, preset_tree, global_config, caplog):
        """Unknown tier falls back to global default and logs an error."""
        import logging

        ic = InstanceConfig(workflow="jira-sprint", model=None)
        wf_manifest = preset_tree / "presets" / "workflows" / "jira-sprint" / "manifest.yaml"
        wf_manifest.write_text(yaml.dump({"name": "jira-sprint", "model_tier": "ultra"}))

        with caplog.at_level(logging.ERROR):
            resolved = resolve_cycle_model(preset_tree, ic, global_config)
        assert resolved == "claude-global-default"
        assert "requests model tier 'ultra' not defined in config.json" in caplog.text

    def test_global_fallback_when_all_unset(self, preset_tree, global_config):
        """Tier 4: fallback to global config.json claude.model when no overrides exist."""
        ic = InstanceConfig(workflow="jira-sprint", model=None)
        wf_manifest = preset_tree / "presets" / "workflows" / "jira-sprint" / "manifest.yaml"
        wf_manifest.write_text(yaml.dump({"name": "jira-sprint"}))

        resolved = resolve_cycle_model(preset_tree, ic, global_config)
        assert resolved == "claude-global-default"

    def test_opencode_runtime_uses_its_own_default_model(self, preset_tree, global_config):
        ic = InstanceConfig(
            workflow="jira-sprint",
            model=None,
            runtime="opencode-v1",
            provider="rehor-openai",
        )
        wf_manifest = preset_tree / "presets" / "workflows" / "jira-sprint" / "manifest.yaml"
        wf_manifest.write_text(yaml.dump({"name": "jira-sprint"}))

        resolved = resolve_cycle_model(preset_tree, ic, global_config)
        assert resolved == "gpt-6-luna"

    def test_opencode_vertex_keeps_claude_model_default(self, preset_tree, global_config):
        ic = InstanceConfig(runtime="opencode-v1", provider="vertex")
        wf_manifest = preset_tree / "presets" / "workflows" / "jira-sprint" / "manifest.yaml"
        wf_manifest.write_text(yaml.dump({"name": "jira-sprint"}))

        resolved = resolve_cycle_model(preset_tree, ic, global_config)
        assert resolved == "claude-global-default"

    def test_opencode_chat_provider_requires_explicit_model(self, preset_tree, global_config):
        ic = InstanceConfig(runtime="opencode-v1", provider="rehor-openai-chat")
        wf_manifest = preset_tree / "presets" / "workflows" / "jira-sprint" / "manifest.yaml"
        wf_manifest.write_text(yaml.dump({"name": "jira-sprint"}))

        with pytest.raises(ValueError, match="requires an explicit model"):
            resolve_cycle_model(preset_tree, ic, global_config)

    @pytest.mark.parametrize("provider", ["rehor-openai", "rehor-openai-chat"])
    def test_opencode_openai_provider_rejects_claude_model_tier(self, preset_tree, global_config, provider):
        ic = InstanceConfig(runtime="opencode-v1", provider=provider)
        wf_manifest = preset_tree / "presets" / "workflows" / "jira-sprint" / "manifest.yaml"
        wf_manifest.write_text(yaml.dump({"name": "jira-sprint", "model_tier": "light"}))

        with pytest.raises(ValueError, match="has no model-tier mapping"):
            resolve_cycle_model(preset_tree, ic, global_config)

    def test_opencode_vertex_resolves_claude_model_tier(self, preset_tree, global_config):
        ic = InstanceConfig(runtime="opencode-v1", provider="vertex")
        wf_manifest = preset_tree / "presets" / "workflows" / "jira-sprint" / "manifest.yaml"
        wf_manifest.write_text(yaml.dump({"name": "jira-sprint", "model_tier": "light"}))

        resolved = resolve_cycle_model(preset_tree, ic, global_config)
        assert resolved == "claude-sonnet-4-6"

    def test_custom_remote_workflow_model_tier(self, tmp_path, global_config):
        """Custom workflow (./workflows/custom) model_tier resolves via remote_agent_dir."""
        remote_agent_dir = tmp_path / "agent"
        custom_wf = remote_agent_dir / "workflows" / "custom"
        custom_wf.mkdir(parents=True)
        (custom_wf / "manifest.yaml").write_text(yaml.dump({"name": "custom", "model_tier": "light"}))

        ic = InstanceConfig(workflow="./workflows/custom", model=None)
        resolved = resolve_cycle_model(tmp_path, ic, global_config, remote_agent_dir=remote_agent_dir)
        assert resolved == "claude-sonnet-4-6"

    def test_missing_manifest_falls_back_to_global(self, preset_tree, global_config):
        """When manifest.yaml does not exist, resolve_cycle_model falls back to global config."""
        ic = InstanceConfig(workflow="jira-sprint", model=None)
        resolved = resolve_cycle_model(preset_tree, ic, global_config)
        assert resolved == "claude-global-default"

    def test_empty_or_whitespace_falls_through(self, preset_tree, global_config):
        """Empty strings and whitespace at each tier are treated as unset."""
        ic = InstanceConfig(workflow="jira-sprint", model="   ")
        wf_manifest = preset_tree / "presets" / "workflows" / "jira-sprint" / "manifest.yaml"
        wf_manifest.write_text(yaml.dump({"name": "jira-sprint", "model_tier": ""}))

        resolved = resolve_cycle_model(preset_tree, ic, global_config)
        assert resolved == "claude-global-default"

    def test_non_string_manifest_tier_falls_through(self, preset_tree, global_config):
        """Non-string model_tier in manifest (e.g. YAML boolean or int) falls through."""
        ic = InstanceConfig(workflow="jira-sprint", model=None)
        wf_manifest = preset_tree / "presets" / "workflows" / "jira-sprint" / "manifest.yaml"
        wf_manifest.write_text(yaml.dump({"name": "jira-sprint", "model_tier": 123}))

        resolved = resolve_cycle_model(preset_tree, ic, global_config)
        assert resolved == "claude-global-default"
