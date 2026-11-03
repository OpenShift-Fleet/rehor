"""Tests for global config defaults, validation, and environment overrides."""

import json

import pytest

from bot.config import Config, load_config


@pytest.fixture(autouse=True)
def _clear_opencode_budget_env(monkeypatch):
    monkeypatch.delenv("REHOR_OPENCODE_MAX_TOOL_CALLS", raising=False)


def _write_config(tmp_path, polling_extra=None, claude_extra=None, opencode_extra=None):
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
                "opencode": opencode_extra or {},
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


def test_load_config_open_code_model_default(tmp_path):
    _write_config(tmp_path)
    cfg = load_config(tmp_path)
    assert cfg.opencode_model == "gpt-6-luna"


def test_load_config_open_code_model_override(tmp_path):
    _write_config(tmp_path, opencode_extra={"model": "gpt-6-sol"})
    cfg = load_config(tmp_path)
    assert cfg.opencode_model == "gpt-6-sol"


def test_config_positional_constructor_preserves_defaults():
    cfg = Config("claude-test", 50, 300, 3600, 1800, "TEST", 172800, "test-model", {"light": "test"})
    assert cfg.max_turns == 50
    assert cfg.model_tiers == {"light": "test"}
    assert cfg.opencode_max_tool_calls == 200
    assert cfg.budget_usd == 5.0


def test_load_config_budget_usd_default(tmp_path):
    _write_config(tmp_path)
    cfg = load_config(tmp_path)
    assert cfg.budget_usd == 5.0


@pytest.mark.parametrize("budget", [1, 2.5, 20])
def test_load_config_budget_usd_json(tmp_path, budget):
    _write_config(tmp_path, claude_extra={"budgetUsd": budget})
    cfg = load_config(tmp_path)
    assert cfg.budget_usd == budget


def test_load_config_open_code_budget_without_section(tmp_path):
    _write_config(tmp_path)
    path = tmp_path / "config.json"
    raw = json.loads(path.read_text())
    del raw["opencode"]
    path.write_text(json.dumps(raw))
    cfg = load_config(tmp_path)
    assert cfg.opencode_max_tool_calls == 200
    assert cfg.max_turns == 50


@pytest.mark.parametrize("budget", [1, 200, 375])
def test_load_config_open_code_budget_json(tmp_path, budget):
    _write_config(tmp_path, opencode_extra={"maxToolCalls": budget})
    cfg = load_config(tmp_path)
    assert cfg.opencode_max_tool_calls == budget
    assert cfg.max_turns == 50


@pytest.mark.parametrize("env_budget", [None, ""])
@pytest.mark.parametrize("json_budget, expected", [({}, 200), ({"maxToolCalls": 275}, 275)])
def test_load_config_open_code_budget_unset_or_empty_env(tmp_path, monkeypatch, env_budget, json_budget, expected):
    _write_config(tmp_path, opencode_extra=json_budget)
    if env_budget is not None:
        monkeypatch.setenv("REHOR_OPENCODE_MAX_TOOL_CALLS", env_budget)
    cfg = load_config(tmp_path)
    assert cfg.opencode_max_tool_calls == expected
    assert cfg.max_turns == 50


@pytest.mark.parametrize("env_budget, expected", [("1", 1), ("450", 450), ("000250", 250)])
@pytest.mark.parametrize("json_budget", [{}, {"maxToolCalls": 275}])
def test_load_config_open_code_budget_env_precedence(tmp_path, monkeypatch, env_budget, expected, json_budget):
    _write_config(tmp_path, opencode_extra=json_budget)
    monkeypatch.setenv("REHOR_OPENCODE_MAX_TOOL_CALLS", env_budget)
    cfg = load_config(tmp_path)
    assert cfg.opencode_max_tool_calls == expected
    assert cfg.max_turns == 50


@pytest.mark.parametrize("budget", [True, False, 1.0, 1.5, 0, -1, "200", None, [], {}])
@pytest.mark.parametrize("env_budget", [None, "450"])
def test_load_config_rejects_invalid_open_code_json_budget(tmp_path, monkeypatch, budget, env_budget):
    _write_config(tmp_path, opencode_extra={"maxToolCalls": budget})
    if env_budget is not None:
        monkeypatch.setenv("REHOR_OPENCODE_MAX_TOOL_CALLS", env_budget)
    with pytest.raises(ValueError, match=r"opencode\.maxToolCalls must be a positive integer"):
        load_config(tmp_path)


@pytest.mark.parametrize(
    "budget", ["0", "000", "-1", "+200", "1.0", "2e2", "0xC8", "1_000", "true", " ", " 200", "200\n", "٢٠٠"]
)
def test_load_config_rejects_invalid_open_code_env_budget(tmp_path, monkeypatch, budget):
    _write_config(tmp_path, opencode_extra={"maxToolCalls": 275})
    monkeypatch.setenv("REHOR_OPENCODE_MAX_TOOL_CALLS", budget)
    with pytest.raises(ValueError, match="REHOR_OPENCODE_MAX_TOOL_CALLS must be a positive base-10 integer"):
        load_config(tmp_path)


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
