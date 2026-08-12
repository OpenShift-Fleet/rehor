"""Tests for bot/config.py secret sanitization (REHOR-123)."""

import os

from bot.config import SECRET_ENV_VARS, sanitize_env


def test_slack_webhook_url_is_a_secret_env_var():
    assert "SLACK_WEBHOOK_URL" in SECRET_ENV_VARS


def test_sanitize_env_removes_slack_webhook_url(monkeypatch):
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")
    sanitize_env()
    assert os.environ.get("SLACK_WEBHOOK_URL") is None
