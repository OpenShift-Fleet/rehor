"""Tests for multi-profile config repo support (REHOR-19).

Covers sync_config_repo shared dir discovery, apply_merged_config
layering (shared → profile), and assemble_claude_md shared layer.

Note: bot.run imports claude_agent_sdk (not available locally), so we
import sync_config_repo and assemble_claude_md via importlib with the
heavy dependency mocked out.
"""

import importlib
import json
import os
import sys
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _mock_sdk():
    """Mock claude_agent_sdk so bot.run can be imported locally."""
    sdk = MagicMock()
    sentinel = object()
    prev = sys.modules.get("claude_agent_sdk", sentinel)
    sys.modules["claude_agent_sdk"] = sdk
    # Force re-import of bot.agent and bot.run so they pick up the mock
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


def _import_run():
    """Import bot.run after SDK is mocked."""
    import bot.run as run_mod

    return run_mod


@pytest.fixture()
def config_repo(tmp_path):
    """Create a mock multi-profile config repo layout."""
    repo = tmp_path / "remote-config"
    repo.mkdir()
    (repo / ".git").mkdir()

    # Profile: internal
    internal = repo / "internal" / "agent"
    internal.mkdir(parents=True)
    (internal / "instance.yaml").write_text("workflow: jira-sprint\n")
    (internal / "CLAUDE.md").write_text("# Internal profile instructions\n")
    (internal / "settings.json").write_text(json.dumps({"env": {"FOO": "from-internal"}}))

    # Profile: community
    community = repo / "community" / "agent"
    community.mkdir(parents=True)
    (community / "instance.yaml").write_text("workflow: jira-kanban\n")

    # Shared
    shared = repo / "shared" / "agent"
    shared.mkdir(parents=True)
    (shared / "CLAUDE.md").write_text("# Shared instructions\n")
    (shared / "settings.json").write_text(json.dumps({"env": {"BAR": "from-shared"}}))
    personas = shared / "personas" / "default"
    personas.mkdir(parents=True)
    (personas / "persona.md").write_text("I am the shared persona.\n")

    return repo


@pytest.fixture()
def single_profile_repo(tmp_path):
    """Create a single-profile config repo (no shared/ dir)."""
    repo = tmp_path / "remote-config"
    repo.mkdir()
    (repo / ".git").mkdir()

    profile = repo / "my-config" / "agent"
    profile.mkdir(parents=True)
    (profile / "instance.yaml").write_text("workflow: jira-sprint\n")
    (profile / "CLAUDE.md").write_text("# Single profile\n")

    return repo


class TestSyncConfigRepoSharedDiscovery:
    """Test that sync_config_repo discovers the shared/agent/ sibling."""

    def test_returns_both_dirs_when_shared_exists(self, config_repo):
        run_mod = _import_run()
        with patch.dict(
            os.environ,
            {
                "BOT_CONFIG_REPO": "https://example.com/config.git",
                "BOT_CONFIG_PATH": "internal",
            },
        ):
            with patch.object(run_mod, "REMOTE_CONFIG_DIR", config_repo):
                profile_dir, shared_dir = run_mod.sync_config_repo()

        assert profile_dir is not None
        assert shared_dir is not None
        assert profile_dir == config_repo / "internal" / "agent"
        assert shared_dir == config_repo / "shared" / "agent"

    def test_returns_none_shared_when_no_shared_dir(self, single_profile_repo):
        run_mod = _import_run()
        with patch.dict(
            os.environ,
            {
                "BOT_CONFIG_REPO": "https://example.com/config.git",
                "BOT_CONFIG_PATH": "my-config",
            },
        ):
            with patch.object(run_mod, "REMOTE_CONFIG_DIR", single_profile_repo):
                profile_dir, shared_dir = run_mod.sync_config_repo()

        assert profile_dir is not None
        assert shared_dir is None

    def test_returns_none_tuple_when_no_repo_url(self):
        run_mod = _import_run()
        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("BOT_CONFIG_REPO", None)
            profile_dir, shared_dir = run_mod.sync_config_repo()

        assert profile_dir is None
        assert shared_dir is None

    def test_returns_none_tuple_when_profile_missing(self, config_repo):
        run_mod = _import_run()
        with patch.dict(
            os.environ,
            {
                "BOT_CONFIG_REPO": "https://example.com/config.git",
                "BOT_CONFIG_PATH": "nonexistent",
            },
        ):
            with patch.object(run_mod, "REMOTE_CONFIG_DIR", config_repo):
                profile_dir, shared_dir = run_mod.sync_config_repo()

        assert profile_dir is None
        assert shared_dir is None


class TestApplyMergedConfigLayering:
    """Test that calling apply_merged_config twice gives correct layering."""

    def test_shared_then_profile_gives_profile_priority(self, config_repo, tmp_path):
        from bot.merge import apply_merged_config

        script_dir = tmp_path / "app"
        script_dir.mkdir()
        (script_dir / ".claude").mkdir()
        (script_dir / "data").mkdir()
        (script_dir / "bot").mkdir()

        shared_dir = config_repo / "shared" / "agent"
        profile_dir = config_repo / "internal" / "agent"

        apply_merged_config(script_dir, shared_dir)
        apply_merged_config(script_dir, profile_dir)

        settings = json.loads((script_dir / ".claude" / "settings.json").read_text())
        assert settings["env"]["BAR"] == "from-shared"
        assert settings["env"]["FOO"] == "from-internal"

    def test_shared_persona_present_without_profile_override(self, config_repo, tmp_path):
        from bot.merge import apply_merged_config

        script_dir = tmp_path / "app"
        script_dir.mkdir()
        (script_dir / "personas").mkdir()

        shared_dir = config_repo / "shared" / "agent"
        profile_dir = config_repo / "internal" / "agent"

        apply_merged_config(script_dir, shared_dir)
        apply_merged_config(script_dir, profile_dir)

        persona_file = script_dir / "personas" / "default" / "persona.md"
        assert persona_file.exists()
        assert "shared persona" in persona_file.read_text()

    def test_profile_persona_overrides_shared(self, config_repo, tmp_path):
        from bot.merge import apply_merged_config

        profile_personas = config_repo / "internal" / "agent" / "personas" / "default"
        profile_personas.mkdir(parents=True)
        (profile_personas / "persona.md").write_text("I am the internal persona.\n")

        script_dir = tmp_path / "app"
        script_dir.mkdir()
        (script_dir / "personas").mkdir()

        shared_dir = config_repo / "shared" / "agent"
        profile_dir = config_repo / "internal" / "agent"

        apply_merged_config(script_dir, shared_dir)
        apply_merged_config(script_dir, profile_dir)

        persona_file = script_dir / "personas" / "default" / "persona.md"
        assert "internal persona" in persona_file.read_text()


class TestAssembleClaudeMdSharedLayer:
    """Test that assemble_claude_md inserts shared CLAUDE.md between core and workflow."""

    def test_shared_layer_inserted_between_core_and_workflow(self, tmp_path):
        run_mod = _import_run()
        script_dir = tmp_path / "app"
        presets = script_dir / "presets"
        (presets / "core").mkdir(parents=True)
        (presets / "core" / "CLAUDE.md").write_text("[CORE]")
        wf = presets / "workflows" / "jira-sprint"
        wf.mkdir(parents=True)
        (wf / "CLAUDE.md").write_text("[WORKFLOW]")
        (wf / "manifest.yaml").write_text("name: jira-sprint\n")

        shared_dir = tmp_path / "shared" / "agent"
        shared_dir.mkdir(parents=True)
        (shared_dir / "CLAUDE.md").write_text("[SHARED]")

        from bot.config import InstanceConfig

        ic = InstanceConfig(workflow="jira-sprint")
        run_mod.assemble_claude_md(script_dir, ic, shared_agent_dir=shared_dir)

        result = (script_dir / "CLAUDE.md").read_text()
        assert result == "[CORE][SHARED][WORKFLOW]"

    def test_no_shared_layer_when_no_shared_dir(self, tmp_path):
        run_mod = _import_run()
        script_dir = tmp_path / "app"
        presets = script_dir / "presets"
        (presets / "core").mkdir(parents=True)
        (presets / "core" / "CLAUDE.md").write_text("[CORE]")
        wf = presets / "workflows" / "jira-sprint"
        wf.mkdir(parents=True)
        (wf / "CLAUDE.md").write_text("[WORKFLOW]")
        (wf / "manifest.yaml").write_text("name: jira-sprint\n")

        from bot.config import InstanceConfig

        ic = InstanceConfig(workflow="jira-sprint")
        run_mod.assemble_claude_md(script_dir, ic, shared_agent_dir=None)

        result = (script_dir / "CLAUDE.md").read_text()
        assert result == "[CORE][WORKFLOW]"

    def test_shared_layer_with_append_strategy(self, tmp_path):
        run_mod = _import_run()
        script_dir = tmp_path / "app"
        presets = script_dir / "presets"
        (presets / "core").mkdir(parents=True)
        (presets / "core" / "CLAUDE.md").write_text("[CORE]")
        wf = presets / "workflows" / "jira-sprint"
        wf.mkdir(parents=True)
        (wf / "CLAUDE.md").write_text("[WORKFLOW]")
        (wf / "manifest.yaml").write_text("name: jira-sprint\n")

        shared_dir = tmp_path / "shared" / "agent"
        shared_dir.mkdir(parents=True)
        (shared_dir / "CLAUDE.md").write_text("[SHARED]")

        instance_dir = tmp_path / "instance" / "agent"
        instance_dir.mkdir(parents=True)
        (instance_dir / "CLAUDE.md").write_text("[INSTANCE]")

        from bot.config import InstanceConfig

        ic = InstanceConfig(workflow="jira-sprint", claude_md_strategy="append")
        run_mod.assemble_claude_md(script_dir, ic, remote_agent_dir=instance_dir, shared_agent_dir=shared_dir)

        result = (script_dir / "CLAUDE.md").read_text()
        assert result == "[CORE][SHARED][WORKFLOW][INSTANCE]"

    def test_shared_layer_with_replace_strategy(self, tmp_path):
        run_mod = _import_run()
        script_dir = tmp_path / "app"
        presets = script_dir / "presets"
        (presets / "core").mkdir(parents=True)
        (presets / "core" / "CLAUDE.md").write_text("[CORE]")
        wf = presets / "workflows" / "jira-sprint"
        wf.mkdir(parents=True)
        (wf / "CLAUDE.md").write_text("[WORKFLOW]")
        (wf / "manifest.yaml").write_text("name: jira-sprint\n")

        shared_dir = tmp_path / "shared" / "agent"
        shared_dir.mkdir(parents=True)
        (shared_dir / "CLAUDE.md").write_text("[SHARED]")

        instance_dir = tmp_path / "instance" / "agent"
        instance_dir.mkdir(parents=True)
        (instance_dir / "CLAUDE.md").write_text("[INSTANCE]")

        from bot.config import InstanceConfig

        ic = InstanceConfig(workflow="jira-sprint", claude_md_strategy="replace")
        run_mod.assemble_claude_md(script_dir, ic, remote_agent_dir=instance_dir, shared_agent_dir=shared_dir)

        result = (script_dir / "CLAUDE.md").read_text()
        assert result == "[CORE][SHARED][INSTANCE]"

    def test_shared_claude_md_missing_file_is_skipped(self, tmp_path):
        run_mod = _import_run()
        script_dir = tmp_path / "app"
        presets = script_dir / "presets"
        (presets / "core").mkdir(parents=True)
        (presets / "core" / "CLAUDE.md").write_text("[CORE]")
        wf = presets / "workflows" / "jira-sprint"
        wf.mkdir(parents=True)
        (wf / "CLAUDE.md").write_text("[WORKFLOW]")
        (wf / "manifest.yaml").write_text("name: jira-sprint\n")

        shared_dir = tmp_path / "shared" / "agent"
        shared_dir.mkdir(parents=True)

        from bot.config import InstanceConfig

        ic = InstanceConfig(workflow="jira-sprint")
        run_mod.assemble_claude_md(script_dir, ic, shared_agent_dir=shared_dir)

        result = (script_dir / "CLAUDE.md").read_text()
        assert result == "[CORE][WORKFLOW]"
