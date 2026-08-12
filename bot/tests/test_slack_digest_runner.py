"""Tests for try_slack_digest — runner-triggered digest."""

from unittest.mock import patch

from bot.slack_digest import try_slack_digest


@patch("bot.slack_digest.cmd_digest")
def test_calls_cmd_digest_when_webhook_set(mock_cmd, monkeypatch):
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")

    try_slack_digest()

    mock_cmd.assert_called_once()


@patch("bot.slack_digest.cmd_digest")
def test_skips_when_webhook_not_set(mock_cmd, monkeypatch):
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)

    try_slack_digest()

    mock_cmd.assert_not_called()


@patch("bot.slack_digest.cmd_digest", side_effect=Exception("MCP error"))
def test_handles_error_gracefully(mock_cmd, monkeypatch):
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")

    try_slack_digest()  # should not raise


@patch("bot.slack_digest.cmd_digest")
def test_explicit_webhook_param_used_without_touching_env(mock_cmd, monkeypatch):
    """bot/run.py passes the webhook captured before sanitize_env() stripped it (REHOR-123)."""
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)

    try_slack_digest("https://hooks.slack.com/test")

    mock_cmd.assert_called_once_with("https://hooks.slack.com/test")


@patch("bot.slack_digest.cmd_digest")
def test_explicit_none_param_skips_when_env_also_unset(mock_cmd, monkeypatch):
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)

    try_slack_digest(None)

    mock_cmd.assert_not_called()
