"""Smoke tests for bot.metrics — verify all metrics register without conflicts."""

import contextlib
from pathlib import Path
from types import SimpleNamespace

import prometheus_client
import pytest


@pytest.fixture(autouse=True)
def _clean_registry():
    """Use a fresh Prometheus registry so metrics don't collide across tests."""
    import importlib

    import bot.metrics

    # Unregister all bot metrics from the default registry, reload to
    # re-register them (proves no duplicate-name panics).
    collectors = [
        bot.metrics.PREFLIGHT_OUTCOME_TOTAL,
        bot.metrics.PREFLIGHT_CONSECUTIVE_ERRORS,
        bot.metrics.CYCLE_TIMEOUT_TOTAL,
        bot.metrics.CONFIG_SYNC_TOTAL,
        bot.metrics.WORK_TYPE_TOTAL,
        bot.metrics.TURN_BUDGET_EVENT_TOTAL,
        bot.metrics.TRANSCRIPT_UPLOAD_TOTAL,
        bot.metrics.MCP_SERVER_STATUS_TOTAL,
        bot.metrics.CYCLE_DURATION_SECONDS,
        bot.metrics.DISK_FREE_MB,
        bot.metrics.CYCLE_COST_USD_TOTAL,
        bot.metrics.CYCLE_INPUT_TOKENS_TOTAL,
        bot.metrics.CYCLE_OUTPUT_TOKENS_TOTAL,
        bot.metrics.CYCLE_CACHE_READ_TOKENS_TOTAL,
        bot.metrics.CYCLE_CACHE_WRITE_TOKENS_TOTAL,
        bot.metrics.CYCLES_TOTAL,
        bot.metrics.IDLE_WITH_TOKENS_TOTAL,
    ]
    for c in collectors:
        with contextlib.suppress(Exception):
            prometheus_client.REGISTRY.unregister(c)
    importlib.reload(bot.metrics)
    yield


def test_all_metrics_importable():
    from bot.metrics import (
        CONFIG_SYNC_TOTAL,
        CYCLE_COST_USD_TOTAL,
        CYCLE_DURATION_SECONDS,
        CYCLE_TIMEOUT_TOTAL,
        CYCLES_TOTAL,
        DISK_FREE_MB,
        IDLE_WITH_TOKENS_TOTAL,
        MCP_SERVER_STATUS_TOTAL,
        PREFLIGHT_CONSECUTIVE_ERRORS,
        PREFLIGHT_OUTCOME_TOTAL,
        TRANSCRIPT_UPLOAD_TOTAL,
        TURN_BUDGET_EVENT_TOTAL,
        WORK_TYPE_TOTAL,
    )

    assert CONFIG_SYNC_TOTAL is not None
    assert CYCLE_COST_USD_TOTAL is not None
    assert CYCLE_DURATION_SECONDS is not None
    assert CYCLE_TIMEOUT_TOTAL is not None
    assert CYCLES_TOTAL is not None
    assert DISK_FREE_MB is not None
    assert IDLE_WITH_TOKENS_TOTAL is not None
    assert MCP_SERVER_STATUS_TOTAL is not None
    assert PREFLIGHT_CONSECUTIVE_ERRORS is not None
    assert PREFLIGHT_OUTCOME_TOTAL is not None
    assert TRANSCRIPT_UPLOAD_TOTAL is not None
    assert TURN_BUDGET_EVENT_TOTAL is not None
    assert WORK_TYPE_TOTAL is not None


def test_counter_labels_match():
    from bot.metrics import CONFIG_SYNC_TOTAL, PREFLIGHT_OUTCOME_TOTAL, WORK_TYPE_TOTAL

    PREFLIGHT_OUTCOME_TOTAL.labels(label="test", action="start").inc()
    CONFIG_SYNC_TOTAL.labels(label="test", outcome="ok").inc()
    WORK_TYPE_TOTAL.labels(label="test", work_type="idle").inc()


def test_histogram_observe():
    from bot.metrics import CYCLE_DURATION_SECONDS

    CYCLE_DURATION_SECONDS.labels(label="test", work_type="triage_only").observe(42.5)


def test_gauge_set():
    from bot.metrics import DISK_FREE_MB, PREFLIGHT_CONSECUTIVE_ERRORS

    DISK_FREE_MB.set(1024)
    PREFLIGHT_CONSECUTIVE_ERRORS.labels(label="test").set(3)


def test_metric_names_have_devbot_prefix():
    from bot import metrics

    for attr in dir(metrics):
        obj = getattr(metrics, attr)
        if isinstance(obj, (prometheus_client.Counter, prometheus_client.Gauge, prometheus_client.Histogram)):
            desc = obj.describe()[0]
            assert desc.name.startswith("devbot_"), f"{attr} missing devbot_ prefix"


def test_record_cycle_metrics_increments_counters():
    from bot.metrics import (
        CYCLE_COST_USD_TOTAL,
        CYCLE_INPUT_TOKENS_TOTAL,
        CYCLES_TOTAL,
        IDLE_WITH_TOKENS_TOTAL,
        record_cycle_metrics,
    )

    record_cycle_metrics(
        model="claude-opus-4",
        label="test-label",
        workflow="jira-sprint",
        status="ok",
        cost_usd=1.5,
        input_tokens=100,
        output_tokens=50,
        cache_read_tokens=20,
        cache_write_tokens=10,
    )

    labels = {"model": "claude-opus-4", "label": "test-label", "workflow": "jira-sprint"}
    assert CYCLE_COST_USD_TOTAL.labels(**labels)._value.get() == 1.5
    assert CYCLE_INPUT_TOKENS_TOTAL.labels(**labels)._value.get() == 100
    assert CYCLES_TOTAL.labels(**labels, status="ok")._value.get() == 1
    assert IDLE_WITH_TOKENS_TOTAL.labels(label="test-label", workflow="jira-sprint")._value.get() == 0


def test_idle_with_tokens_increments():
    from bot.metrics import IDLE_WITH_TOKENS_TOTAL, record_cycle_metrics

    record_cycle_metrics(
        model="claude-opus-4",
        label="test-label",
        workflow="jira-sprint",
        status="idle",
        cost_usd=0.1,
        input_tokens=50,
        output_tokens=10,
        cache_read_tokens=0,
        cache_write_tokens=0,
    )

    assert IDLE_WITH_TOKENS_TOTAL.labels(label="test-label", workflow="jira-sprint")._value.get() == 1


def test_record_cost_emits_metrics(tmp_path, monkeypatch):
    from bot import costs
    from bot.metrics import CYCLE_COST_USD_TOTAL, CYCLES_TOTAL, IDLE_WITH_TOKENS_TOTAL

    monkeypatch.setattr(costs.httpx, "post", lambda *a, **k: SimpleNamespace(is_success=True, text=""))

    result = SimpleNamespace(
        usage={"input_tokens": 40, "output_tokens": 5, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
        result="NO_WORK_FOUND",
        model_usage={"claude-opus-4": {}},
        session_id="sess",
        num_turns=1,
        duration_ms=1000,
        total_cost_usd=0.25,
        subtype="success",
    )
    costs.record_cost(Path(tmp_path) / "costs.jsonl", "bot-a", result, workflow="onboarding")

    labels = {"model": "claude-opus-4", "label": "bot-a", "workflow": "onboarding"}
    assert CYCLE_COST_USD_TOTAL.labels(**labels)._value.get() == 0.25
    assert CYCLES_TOTAL.labels(**labels, status="idle")._value.get() == 1
    assert IDLE_WITH_TOKENS_TOTAL.labels(label="bot-a", workflow="onboarding")._value.get() == 1
