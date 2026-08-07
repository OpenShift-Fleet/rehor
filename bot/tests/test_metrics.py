"""Smoke tests for bot.metrics — verify all metrics register without conflicts."""

import contextlib

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
        bot.metrics.WAKE_SIGNAL_TOTAL,
        bot.metrics.DISK_FREE_MB,
    ]
    for c in collectors:
        with contextlib.suppress(Exception):
            prometheus_client.REGISTRY.unregister(c)
    importlib.reload(bot.metrics)
    yield


def test_all_metrics_importable():
    from bot.metrics import (
        CONFIG_SYNC_TOTAL,
        CYCLE_TIMEOUT_TOTAL,
        DISK_FREE_MB,
        MCP_SERVER_STATUS_TOTAL,
        PREFLIGHT_CONSECUTIVE_ERRORS,
        PREFLIGHT_OUTCOME_TOTAL,
        TRANSCRIPT_UPLOAD_TOTAL,
        TURN_BUDGET_EVENT_TOTAL,
        WAKE_SIGNAL_TOTAL,
        WORK_TYPE_TOTAL,
    )

    assert CONFIG_SYNC_TOTAL is not None
    assert CYCLE_TIMEOUT_TOTAL is not None
    assert DISK_FREE_MB is not None
    assert MCP_SERVER_STATUS_TOTAL is not None
    assert PREFLIGHT_CONSECUTIVE_ERRORS is not None
    assert PREFLIGHT_OUTCOME_TOTAL is not None
    assert TRANSCRIPT_UPLOAD_TOTAL is not None
    assert TURN_BUDGET_EVENT_TOTAL is not None
    assert WAKE_SIGNAL_TOTAL is not None
    assert WORK_TYPE_TOTAL is not None


def test_counter_labels_match():
    from bot.metrics import CONFIG_SYNC_TOTAL, PREFLIGHT_OUTCOME_TOTAL, WORK_TYPE_TOTAL

    PREFLIGHT_OUTCOME_TOTAL.labels(label="test", action="start").inc()
    CONFIG_SYNC_TOTAL.labels(label="test", outcome="ok").inc()
    WORK_TYPE_TOTAL.labels(label="test", work_type="idle").inc()


def test_gauge_set():
    from bot.metrics import DISK_FREE_MB, PREFLIGHT_CONSECUTIVE_ERRORS

    DISK_FREE_MB.set(1024)
    PREFLIGHT_CONSECUTIVE_ERRORS.labels(label="test").set(3)


def test_metric_names_have_devbot_prefix():
    from bot import metrics

    for attr in dir(metrics):
        obj = getattr(metrics, attr)
        if isinstance(obj, (prometheus_client.Counter, prometheus_client.Gauge)):
            desc = obj.describe()[0]
            assert desc.name.startswith("devbot_"), f"{attr} missing devbot_ prefix"
