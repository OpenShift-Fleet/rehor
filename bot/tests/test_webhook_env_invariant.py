"""Integration-style regression test for the REHOR-123 webhook invariant.

The individual pieces are each tested elsewhere in isolation:
  - SLACK_WEBHOOK_URL is in SECRET_ENV_VARS (test_sanitize_env.py)
  - sanitize_env() removes it from os.environ (test_sanitize_env.py)
  - try_slack_digest()/cmd_digest() use an explicit param when passed, and
    fail closed when both the param and the env are unset
    (test_slack_digest_runner.py, test_slack_digest_cmd.py)

None of those, on their own, prove the thing that actually matters: once
bot/run.py has run sanitize_env(), no downstream Slack code path can
recover the webhook from the environment — it only flows through the
value captured before sanitization. This composes the real capture-then-
sanitize sequence from bot/run.py so a future refactor that drops the
explicit threading (e.g. someone "simplifies" _try_slack_digest back to
reading os.environ directly) is caught here even if it doesn't break any
of the unit tests above in isolation.
"""

import os
from unittest.mock import patch

from bot import idle_reminder
from bot.config import sanitize_env
from bot.run import _try_slack_digest


def test_webhook_survives_sanitize_env_only_via_explicit_capture(monkeypatch):
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")

    # Mirrors bot/run.py: capture before sanitizing, exactly as run.py does.
    slack_webhook_url = os.environ.get("SLACK_WEBHOOK_URL")
    sanitize_env()

    # The invariant: nothing downstream can recover it from the environment
    # anymore, deliberately or by accident.
    assert os.environ.get("SLACK_WEBHOOK_URL") is None

    with patch("bot.slack_digest.cmd_digest") as mock_cmd:
        _try_slack_digest(slack_webhook_url)

    # Yet the digest still fires, using only the pre-sanitize capture.
    mock_cmd.assert_called_once_with("https://hooks.slack.com/test")


def test_omitting_the_captured_value_fails_closed_after_sanitize(monkeypatch):
    """If a future change forgot to thread the captured value through,
    this must fail closed (skip the digest) — never silently recover the
    webhook from a source that would reintroduce the original leak."""
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")
    sanitize_env()

    with patch("bot.slack_digest.cmd_digest") as mock_cmd:
        _try_slack_digest(None)

    mock_cmd.assert_not_called()


def test_idle_reminder_webhook_survives_sanitize_env_only_via_explicit_capture(monkeypatch):
    """Same invariant, for the idle-reminder path (on_preflight_skip)."""
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")

    slack_webhook_url = os.environ.get("SLACK_WEBHOOK_URL")
    sanitize_env()

    assert os.environ.get("SLACK_WEBHOOK_URL") is None

    with (
        patch("bot.idle_reminder.fetch_idle_state", return_value=(9, None)),
        patch("bot.idle_reminder.send_reminder", return_value=None) as mock_send,
        patch("bot.idle_reminder.update_idle_state"),
    ):
        idle_reminder.on_preflight_skip(
            "bot-x",
            idle_cycle_limit=10,
            cooldown_seconds=172800,
            slack_webhook_url=slack_webhook_url,
        )

    mock_send.assert_called_once_with(
        10, instance_id="bot-x", memory_api_base=None, slack_webhook_url="https://hooks.slack.com/test"
    )
