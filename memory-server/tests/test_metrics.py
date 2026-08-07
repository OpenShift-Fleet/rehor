"""Tests for custom Prometheus cycle metrics."""

import os

import pytest
from prometheus_client import CollectorRegistry

os.environ.setdefault("JIRA_URL", "https://redhat.atlassian.net")


@pytest.fixture(autouse=True)
def _fresh_registry(monkeypatch):
    """Patch metrics module to use a fresh registry so tests don't clash."""
    import bot_memory_server.metrics as m
    from prometheus_client import Counter, Gauge

    registry = CollectorRegistry()

    def _counter(name, doc, labels):
        return Counter(name, doc, labels, registry=registry)

    def _gauge(name, doc, labels):
        return Gauge(name, doc, labels, registry=registry)

    monkeypatch.setattr(m, "CYCLE_COST_USD_TOTAL", _counter("devbot_cycle_cost_usd_total", "", ["model", "label"]))
    monkeypatch.setattr(
        m, "CYCLE_INPUT_TOKENS_TOTAL", _counter("devbot_cycle_input_tokens_total", "", ["model", "label"])
    )
    monkeypatch.setattr(
        m, "CYCLE_OUTPUT_TOKENS_TOTAL", _counter("devbot_cycle_output_tokens_total", "", ["model", "label"])
    )
    monkeypatch.setattr(
        m, "CYCLE_CACHE_READ_TOKENS_TOTAL", _counter("devbot_cycle_cache_read_tokens_total", "", ["model", "label"])
    )
    monkeypatch.setattr(
        m, "CYCLE_CACHE_WRITE_TOKENS_TOTAL", _counter("devbot_cycle_cache_write_tokens_total", "", ["model", "label"])
    )
    monkeypatch.setattr(m, "CYCLES_TOTAL", _counter("devbot_cycles_total", "", ["model", "label", "status"]))
    monkeypatch.setattr(
        m, "CYCLE_DURATION_SECONDS_TOTAL", _counter("devbot_cycle_duration_seconds_total", "", ["model", "label"])
    )
    monkeypatch.setattr(m, "DB_COST_USD", _gauge("devbot_db_cost_usd", "", ["model", "label"]))
    monkeypatch.setattr(m, "DB_INPUT_TOKENS", _gauge("devbot_db_input_tokens", "", ["model", "label"]))
    monkeypatch.setattr(m, "DB_OUTPUT_TOKENS", _gauge("devbot_db_output_tokens", "", ["model", "label"]))
    monkeypatch.setattr(m, "DB_CACHE_READ_TOKENS", _gauge("devbot_db_cache_read_tokens", "", ["model", "label"]))
    monkeypatch.setattr(m, "DB_CACHE_WRITE_TOKENS", _gauge("devbot_db_cache_write_tokens", "", ["model", "label"]))
    monkeypatch.setattr(m, "DB_CYCLES", _gauge("devbot_db_cycles", "", ["model", "label"]))


class TestRecordCycle:
    def test_increments_all_counters(self):
        from bot_memory_server.metrics import (
            CYCLE_COST_USD_TOTAL,
            CYCLE_DURATION_SECONDS_TOTAL,
            CYCLE_INPUT_TOKENS_TOTAL,
            CYCLE_OUTPUT_TOKENS_TOTAL,
            CYCLES_TOTAL,
            record_cycle,
        )

        record_cycle(
            model="claude-opus-4",
            label="test-label",
            status="ok",
            cost_usd=1.50,
            input_tokens=100,
            output_tokens=50,
            cache_read_tokens=20,
            cache_write_tokens=10,
            duration_seconds=60.0,
        )

        assert CYCLE_COST_USD_TOTAL.labels(model="claude-opus-4", label="test-label")._value.get() == 1.50
        assert CYCLE_INPUT_TOKENS_TOTAL.labels(model="claude-opus-4", label="test-label")._value.get() == 100
        assert CYCLE_OUTPUT_TOKENS_TOTAL.labels(model="claude-opus-4", label="test-label")._value.get() == 50
        assert CYCLES_TOTAL.labels(model="claude-opus-4", label="test-label", status="ok")._value.get() == 1
        assert CYCLE_DURATION_SECONDS_TOTAL.labels(model="claude-opus-4", label="test-label")._value.get() == 60.0

    def test_none_values_default_to_zero(self):
        from bot_memory_server.metrics import (
            CYCLE_COST_USD_TOTAL,
            CYCLE_INPUT_TOKENS_TOTAL,
            record_cycle,
        )

        record_cycle(
            model="claude-opus-4",
            label="test-label",
            status="ok",
            cost_usd=None,
            input_tokens=None,
            output_tokens=None,
            cache_read_tokens=None,
            cache_write_tokens=None,
            duration_seconds=None,
        )

        assert CYCLE_COST_USD_TOTAL.labels(model="claude-opus-4", label="test-label")._value.get() == 0
        assert CYCLE_INPUT_TOKENS_TOTAL.labels(model="claude-opus-4", label="test-label")._value.get() == 0

    def test_none_model_and_label_default_to_unknown(self):
        from bot_memory_server.metrics import CYCLES_TOTAL, record_cycle

        record_cycle(
            model=None,
            label=None,
            status="error",
            cost_usd=0,
            input_tokens=0,
            output_tokens=0,
            cache_read_tokens=0,
            cache_write_tokens=0,
            duration_seconds=0,
        )

        assert CYCLES_TOTAL.labels(model="unknown", label="unknown", status="error")._value.get() == 1

    def test_accumulates_across_calls(self):
        from bot_memory_server.metrics import CYCLE_COST_USD_TOTAL, record_cycle

        for _ in range(3):
            record_cycle(
                model="claude-opus-4",
                label="test-label",
                status="ok",
                cost_usd=1.0,
                input_tokens=10,
                output_tokens=5,
                cache_read_tokens=2,
                cache_write_tokens=1,
                duration_seconds=30.0,
            )

        assert CYCLE_COST_USD_TOTAL.labels(model="claude-opus-4", label="test-label")._value.get() == 3.0


class TestRefreshDbGauges:
    @pytest.mark.asyncio
    async def test_populates_gauges_from_db(self, db):
        from conftest import SCHEMA_PATH

        await db.execute(SCHEMA_PATH.read_text())

        await db.execute(
            """
            INSERT INTO cycles (label, session_id, num_turns, duration_ms, cost_usd,
                                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                                model, is_error, no_work)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            """,
            "test-label",
            "sess-1",
            10,
            60000,
            1.50,
            100,
            50,
            20,
            10,
            "claude-opus-4",
            False,
            False,
        )
        await db.execute(
            """
            INSERT INTO cycles (label, session_id, num_turns, duration_ms, cost_usd,
                                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                                model, is_error, no_work)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            """,
            "test-label",
            "sess-2",
            5,
            30000,
            0.75,
            50,
            25,
            10,
            5,
            "claude-opus-4",
            False,
            False,
        )

        from unittest.mock import patch

        from bot_memory_server.metrics import (
            DB_COST_USD,
            DB_CYCLES,
            DB_INPUT_TOKENS,
            DB_OUTPUT_TOKENS,
            refresh_db_gauges,
        )

        class FakePool:
            async def fetch(self, query):
                return await db.fetch(query)

        with patch("bot_memory_server.db.get_pool", return_value=FakePool()):
            await refresh_db_gauges()

        labels = {"model": "claude-opus-4", "label": "test-label"}
        assert DB_COST_USD.labels(**labels)._value.get() == pytest.approx(2.25)
        assert DB_INPUT_TOKENS.labels(**labels)._value.get() == 150
        assert DB_OUTPUT_TOKENS.labels(**labels)._value.get() == 75
        assert DB_CYCLES.labels(**labels)._value.get() == 2
