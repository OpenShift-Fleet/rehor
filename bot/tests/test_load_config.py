"""Tests for load_config idle-reminder polling fields."""

import json

from bot.config import load_config


def _write_config(tmp_path, polling_extra=None):
    polling = {
        "intervalSeconds": 300,
        "idleIntervalSeconds": 3600,
    }
    if polling_extra:
        polling.update(polling_extra)
    (tmp_path / "config.json").write_text(
        json.dumps(
            {
                "jira": {"boardKey": "TEST"},
                "claude": {"maxTurns": 50, "model": "claude-test"},
                "polling": polling,
            }
        )
    )


def test_load_config_idle_reminder_cooldown_default(tmp_path):
    _write_config(tmp_path)
    cfg = load_config(tmp_path)
    assert cfg.idle_reminder_cooldown_seconds == 172800
    assert cfg.idle_interval == 3600


def test_load_config_idle_reminder_cooldown_override(tmp_path):
    _write_config(tmp_path, {"idleReminderCooldownSeconds": 3600})
    cfg = load_config(tmp_path)
    assert cfg.idle_reminder_cooldown_seconds == 3600
