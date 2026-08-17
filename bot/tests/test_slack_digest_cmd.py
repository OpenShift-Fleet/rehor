"""Tests for bot/slack_digest.py — hour check, weekend check, and digest triggering."""

import json
from datetime import UTC, datetime
from unittest.mock import patch

from bot import slack_digest


class TestDigestWeekendCheck:
    def test_skips_on_saturday(self, monkeypatch, capsys):
        monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")
        saturday = datetime(2026, 7, 18, 9, 0, tzinfo=UTC)

        with patch.object(slack_digest, "datetime") as mock_dt:
            mock_dt.now.return_value = saturday
            slack_digest.cmd_digest()

        output = json.loads(capsys.readouterr().out.strip())
        assert output["sent"] is False
        assert "Weekend" in output["reason"]

    def test_skips_on_sunday(self, monkeypatch, capsys):
        monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")
        sunday = datetime(2026, 7, 19, 9, 0, tzinfo=UTC)

        with patch.object(slack_digest, "datetime") as mock_dt:
            mock_dt.now.return_value = sunday
            slack_digest.cmd_digest()

        output = json.loads(capsys.readouterr().out.strip())
        assert output["sent"] is False
        assert "Weekend" in output["reason"]


class TestDigestHourCheck:
    def test_skips_before_digest_hour(self, monkeypatch, capsys):
        monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")
        monkeypatch.setenv("SLACK_DIGEST_HOUR", "9")
        wednesday_7 = datetime(2026, 7, 15, 7, 0, tzinfo=UTC)

        with patch.object(slack_digest, "datetime") as mock_dt:
            mock_dt.now.return_value = wednesday_7
            slack_digest.cmd_digest()

        output = json.loads(capsys.readouterr().out.strip())
        assert output["sent"] is False
        assert "Before digest hour" in output["reason"]

    def test_proceeds_at_exact_hour(self, monkeypatch, capsys):
        monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")
        monkeypatch.setenv("SLACK_DIGEST_HOUR", "9")
        wednesday_9 = datetime(2026, 7, 15, 9, 0, tzinfo=UTC)

        with (
            patch.object(slack_digest, "datetime") as mock_dt,
            patch.object(slack_digest, "memory_call", return_value={"sent": True, "count": 3}),
            patch.object(slack_digest, "memory_cleanup"),
        ):
            mock_dt.now.return_value = wednesday_9
            slack_digest.cmd_digest()

        output = json.loads(capsys.readouterr().out.strip())
        assert output["sent"] is True

    def test_proceeds_after_digest_hour(self, monkeypatch, capsys):
        """If cycle missed 9:00, digest still fires at 10:01."""
        monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")
        monkeypatch.setenv("SLACK_DIGEST_HOUR", "9")
        wednesday_10 = datetime(2026, 7, 15, 10, 1, tzinfo=UTC)

        with (
            patch.object(slack_digest, "datetime") as mock_dt,
            patch.object(slack_digest, "memory_call", return_value={"sent": True, "count": 1}),
            patch.object(slack_digest, "memory_cleanup"),
        ):
            mock_dt.now.return_value = wednesday_10
            slack_digest.cmd_digest()

        output = json.loads(capsys.readouterr().out.strip())
        assert output["sent"] is True

    def test_skips_when_digest_hour_not_set(self, monkeypatch, capsys):
        """Opt-in: no SLACK_DIGEST_HOUR means digest is disabled."""
        monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")
        monkeypatch.delenv("SLACK_DIGEST_HOUR", raising=False)
        wednesday_9 = datetime(2026, 7, 15, 9, 0, tzinfo=UTC)

        with patch.object(slack_digest, "datetime") as mock_dt:
            mock_dt.now.return_value = wednesday_9
            slack_digest.cmd_digest()

        output = capsys.readouterr().out.strip()
        assert output == ""


class TestDigestNoWebhook:
    def test_skips_when_webhook_not_set(self, monkeypatch, capsys):
        monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)

        slack_digest.cmd_digest()

        output = json.loads(capsys.readouterr().out.strip())
        assert output["sent"] is False
        assert "SLACK_WEBHOOK_URL" in output["reason"]
