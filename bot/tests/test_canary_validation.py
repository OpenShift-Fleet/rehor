"""Canary validation test.

Proves CI catches known-bad input. If this test passes, it means the
pipeline correctly validates manifests and detects invalid configurations.
If CI ever silently ignores test failures, this file's absence from results
is the signal.
"""

import pytest
import yaml

from bot.config import validate_manifest


class TestCanaryManifestValidation:
    """CI must detect invalid preset manifests."""

    def test_invalid_manifest_missing_required_fields(self, tmp_path):
        """A manifest without required mcp_servers must fail validation."""
        wf_dir = tmp_path / "presets" / "workflows" / "broken"
        wf_dir.mkdir(parents=True)

        bad_manifest = {
            "name": "broken",
            "type": "workflow",
            "requires": {
                "mcp_servers": ["nonexistent-server-that-does-not-exist"],
                "env_vars": ["MISSING_VAR_THAT_DOES_NOT_EXIST"],
            },
        }
        (wf_dir / "manifest.yaml").write_text(yaml.dump(bad_manifest))
        (tmp_path / ".mcp.json").write_text("{}")

        with pytest.raises(SystemExit) as exc_info:
            validate_manifest(tmp_path, "broken", {})

        assert exc_info.value.code == 1

    def test_valid_manifest_does_not_fail(self, tmp_path):
        """Sanity check: a valid manifest passes validation."""
        import os
        from unittest.mock import patch

        wf_dir = tmp_path / "presets" / "workflows" / "good"
        wf_dir.mkdir(parents=True)

        manifest = {
            "name": "good",
            "type": "workflow",
            "requires": {
                "mcp_servers": ["bot-memory"],
                "env_vars": ["BOT_LABEL"],
            },
        }
        (wf_dir / "manifest.yaml").write_text(yaml.dump(manifest))
        (tmp_path / ".mcp.json").write_text('{"mcpServers": {"bot-memory": {"type": "stdio"}}}')

        env = {"BOT_LABEL": "test-label"}
        with patch.dict(os.environ, env, clear=False):
            validate_manifest(tmp_path, "good", {})
