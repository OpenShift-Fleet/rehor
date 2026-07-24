"""Tests for slack_cmd.py — hour check, weekend check, and digest triggering."""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import slack_digest as slack_cmd


class TestDigestWeekendCheck:
    def test_skips_on_saturday(self, monkeypatch, capsys):
        monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")
        saturday = datetime(2026, 7, 18, 9, 0, tzinfo=timezone.utc)

        with patch.object(slack_cmd, "datetime") as mock_dt:
            mock_dt.now.return_value = saturday
            slack_cmd.cmd_digest()

        output = json.loads(capsys.readouterr().out.strip())
        assert output["sent"] is False
        assert "Weekend" in output["reason"]

    def test_skips_on_sunday(self, monkeypatch, capsys):
        monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")
        sunday = datetime(2026, 7, 19, 9, 0, tzinfo=timezone.utc)

        with patch.object(slack_cmd, "datetime") as mock_dt:
            mock_dt.now.return_value = sunday
            slack_cmd.cmd_digest()

        output = json.loads(capsys.readouterr().out.strip())
        assert output["sent"] is False
        assert "Weekend" in output["reason"]


class TestDigestHourCheck:
    def test_skips_when_wrong_hour(self, monkeypatch, capsys):
        monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")
        monkeypatch.setenv("SLACK_DIGEST_HOUR", "9")
        wednesday_14 = datetime(2026, 7, 15, 14, 0, tzinfo=timezone.utc)

        with patch.object(slack_cmd, "datetime") as mock_dt:
            mock_dt.now.return_value = wednesday_14
            slack_cmd.cmd_digest()

        output = json.loads(capsys.readouterr().out.strip())
        assert output["sent"] is False
        assert "Not digest hour" in output["reason"]
        assert "14" in output["reason"]
        assert "9" in output["reason"]

    def test_proceeds_at_correct_hour(self, monkeypatch, capsys):
        monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")
        monkeypatch.setenv("SLACK_DIGEST_HOUR", "9")
        wednesday_9 = datetime(2026, 7, 15, 9, 0, tzinfo=timezone.utc)

        with (
            patch.object(slack_cmd, "datetime") as mock_dt,
            patch.object(slack_cmd, "memory_call", return_value={"sent": True, "count": 3}),
            patch.object(slack_cmd, "memory_cleanup"),
        ):
            mock_dt.now.return_value = wednesday_9
            slack_cmd.cmd_digest()

        output = json.loads(capsys.readouterr().out.strip())
        assert output["sent"] is True

    def test_default_hour_is_9(self, monkeypatch, capsys):
        monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")
        monkeypatch.delenv("SLACK_DIGEST_HOUR", raising=False)
        wednesday_9 = datetime(2026, 7, 15, 9, 0, tzinfo=timezone.utc)

        with (
            patch.object(slack_cmd, "datetime") as mock_dt,
            patch.object(slack_cmd, "memory_call", return_value={"sent": False, "count": 0}),
            patch.object(slack_cmd, "memory_cleanup"),
        ):
            mock_dt.now.return_value = wednesday_9
            slack_cmd.cmd_digest()

        output = json.loads(capsys.readouterr().out.strip())
        # Should not skip — hour 9 matches default 9
        assert "Not digest hour" not in output.get("reason", "")


class TestDigestNoWebhook:
    def test_skips_when_webhook_not_set(self, monkeypatch, capsys):
        monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)

        slack_cmd.cmd_digest()

        output = json.loads(capsys.readouterr().out.strip())
        assert output["sent"] is False
        assert "SLACK_WEBHOOK_URL" in output["reason"]
