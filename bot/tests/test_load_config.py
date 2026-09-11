"""Tests for load_config idle-reminder polling fields."""

import json

from bot.config import load_config


def _write_config(tmp_path, polling_extra=None, claude_extra=None):
    polling = {
        "intervalSeconds": 300,
        "idleIntervalSeconds": 3600,
    }
    if polling_extra:
        polling.update(polling_extra)
    claude = {"maxTurns": 50, "model": "claude-test"}
    if claude_extra:
        claude.update(claude_extra)
    (tmp_path / "config.json").write_text(
        json.dumps(
            {
                "jira": {"boardKey": "TEST"},
                "claude": claude,
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


def test_load_config_model_tiers_default(tmp_path):
    _write_config(tmp_path)
    cfg = load_config(tmp_path)
    assert cfg.model_tiers == {}


def test_load_config_model_tiers_valid(tmp_path):
    _write_config(
        tmp_path,
        claude_extra={"modelTiers": {"light": "claude-sonnet-4-6", "heavy": "claude-opus-4-6"}},
    )
    cfg = load_config(tmp_path)
    assert cfg.model_tiers == {"light": "claude-sonnet-4-6", "heavy": "claude-opus-4-6"}


def test_load_config_model_tiers_filters_invalid_entries(tmp_path, caplog):
    _write_config(
        tmp_path,
        claude_extra={
            "modelTiers": {
                "light": "claude-sonnet-4-6",
                "empty": "   ",
                "blank": "",
                "non_str": 123,
                "   ": "claude-invalid-tier",
            }
        },
    )
    cfg = load_config(tmp_path)
    assert cfg.model_tiers == {"light": "claude-sonnet-4-6"}
    assert "Dropping invalid or empty model" in caplog.text


def test_load_config_model_tiers_non_dict(tmp_path):
    _write_config(tmp_path, claude_extra={"modelTiers": "not-a-dict"})
    cfg = load_config(tmp_path)
    assert cfg.model_tiers == {}
