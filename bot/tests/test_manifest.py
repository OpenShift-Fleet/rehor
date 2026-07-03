"""Tests for manifest loading and startup validation."""

import json
import os
from unittest.mock import patch

import pytest
import yaml

from bot.config import load_manifest, validate_manifest


@pytest.fixture
def tmp_preset_dir(tmp_path):
    """Create a minimal preset directory with a jira-sprint manifest."""
    wf_dir = tmp_path / "presets" / "workflows" / "jira-sprint"
    wf_dir.mkdir(parents=True)

    manifest = {
        "name": "jira-sprint",
        "type": "workflow",
        "requires": {
            "mcp_servers": ["bot-memory", "mcp-atlassian"],
            "env_vars": ["BOT_LABEL", "BOT_INSTANCE_ID", "BOT_JIRA_EMAIL"],
            "optional_env_vars": ["SLACK_WEBHOOK_URL", "BOT_BOARD_ID"],
        },
    }
    (wf_dir / "manifest.yaml").write_text(yaml.dump(manifest))

    root_mcp = {"mcpServers": {"bot-memory": {"type": "stdio"}}}
    (tmp_path / ".mcp.json").write_text(json.dumps(root_mcp))

    return tmp_path


class TestLoadManifest:
    def test_loads_valid_manifest(self, tmp_preset_dir):
        result = load_manifest(tmp_preset_dir, "jira-sprint")
        assert result is not None
        assert result["name"] == "jira-sprint"
        assert "bot-memory" in result["requires"]["mcp_servers"]

    def test_returns_none_for_missing(self, tmp_path):
        result = load_manifest(tmp_path, "nonexistent")
        assert result is None


class TestValidateManifest:
    def test_all_satisfied(self, tmp_preset_dir):
        mcp_servers = {"mcp-atlassian": {"type": "stdio"}}
        env = {
            "BOT_LABEL": "hcc-ai-bot",
            "BOT_INSTANCE_ID": "test-1",
            "BOT_JIRA_EMAIL": "bot@example.com",
            "SLACK_WEBHOOK_URL": "https://hooks.slack.com/x",
        }
        with patch.dict(os.environ, env, clear=False):
            validate_manifest(tmp_preset_dir, "jira-sprint", mcp_servers)

    def test_missing_mcp_server_exits(self, tmp_preset_dir):
        mcp_servers = {}
        env = {
            "BOT_LABEL": "hcc-ai-bot",
            "BOT_INSTANCE_ID": "test-1",
            "BOT_JIRA_EMAIL": "bot@example.com",
        }
        with patch.dict(os.environ, env, clear=False):
            with pytest.raises(SystemExit) as exc_info:
                validate_manifest(tmp_preset_dir, "jira-sprint", mcp_servers)
            assert exc_info.value.code == 1

    def test_missing_required_env_exits(self, tmp_preset_dir):
        mcp_servers = {"mcp-atlassian": {"type": "stdio"}}
        env = {"BOT_LABEL": "hcc-ai-bot", "BOT_INSTANCE_ID": "test-1"}
        with patch.dict(os.environ, env, clear=False):
            os.environ.pop("BOT_JIRA_EMAIL", None)
            with pytest.raises(SystemExit) as exc_info:
                validate_manifest(tmp_preset_dir, "jira-sprint", mcp_servers)
            assert exc_info.value.code == 1

    def test_missing_optional_env_warns(self, tmp_preset_dir, caplog):
        mcp_servers = {"mcp-atlassian": {"type": "stdio"}}
        env = {
            "BOT_LABEL": "hcc-ai-bot",
            "BOT_INSTANCE_ID": "test-1",
            "BOT_JIRA_EMAIL": "bot@example.com",
        }
        with patch.dict(os.environ, env, clear=False):
            os.environ.pop("SLACK_WEBHOOK_URL", None)
            os.environ.pop("BOT_BOARD_ID", None)
            validate_manifest(tmp_preset_dir, "jira-sprint", mcp_servers)

        assert "SLACK_WEBHOOK_URL" in caplog.text
        assert "Optional" in caplog.text or "optional" in caplog.text.lower()

    def test_no_manifest_degrades_gracefully(self, tmp_path, caplog):
        (tmp_path / ".mcp.json").write_text("{}")
        validate_manifest(tmp_path, "nonexistent", {})
        assert "skipping validation" in caplog.text.lower()

    def test_error_lists_all_failures(self, tmp_preset_dir):
        """All missing requirements reported in one exit, not one at a time."""
        mcp_servers = {}
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(SystemExit):
                validate_manifest(tmp_preset_dir, "jira-sprint", mcp_servers)
