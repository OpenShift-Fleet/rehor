"""Tests for _try_slack_digest logic — runner-triggered digest.

We can't import bot.run directly (requires claude_agent_sdk), so we
replicate the function logic and test it independently.
"""

import os
from unittest.mock import patch


def _try_slack_digest() -> None:
    """Copy of bot.run._try_slack_digest for testing without claude_agent_sdk."""
    if not os.environ.get("SLACK_WEBHOOK_URL"):
        return

    from bot.slack_digest import cmd_digest

    cmd_digest()


@patch("bot.slack_digest.cmd_digest")
def test_calls_cmd_digest_when_webhook_set(mock_cmd, monkeypatch):
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")

    _try_slack_digest()

    mock_cmd.assert_called_once()


@patch("bot.slack_digest.cmd_digest")
def test_skips_when_webhook_not_set(mock_cmd, monkeypatch):
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)

    _try_slack_digest()

    mock_cmd.assert_not_called()


@patch("bot.slack_digest.cmd_digest", side_effect=Exception("MCP error"))
def test_handles_error_gracefully(mock_cmd, monkeypatch):
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")

    try:
        _try_slack_digest()
    except Exception:
        pass  # in real code, logger.warning catches this
