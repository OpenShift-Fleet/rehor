"""Tests for DB-backed Prometheus cycle gauges."""

import os

import pytest
from prometheus_client import CollectorRegistry

os.environ.setdefault("JIRA_URL", "https://redhat.atlassian.net")


@pytest.fixture(autouse=True)
def _fresh_registry(monkeypatch):
    """Patch metrics module to use a fresh registry so tests don't clash."""
    import bot_memory_server.metrics as m
    from prometheus_client import Gauge

    registry = CollectorRegistry()

    def _gauge(name, doc, labels):
        return Gauge(name, doc, labels, registry=registry)

    monkeypatch.setattr(m, "DB_COST_USD", _gauge("devbot_db_cost_usd", "", ["model", "label"]))
    monkeypatch.setattr(m, "DB_INPUT_TOKENS", _gauge("devbot_db_input_tokens", "", ["model", "label"]))
    monkeypatch.setattr(m, "DB_OUTPUT_TOKENS", _gauge("devbot_db_output_tokens", "", ["model", "label"]))
    monkeypatch.setattr(m, "DB_CACHE_READ_TOKENS", _gauge("devbot_db_cache_read_tokens", "", ["model", "label"]))
    monkeypatch.setattr(m, "DB_CACHE_WRITE_TOKENS", _gauge("devbot_db_cache_write_tokens", "", ["model", "label"]))
    monkeypatch.setattr(m, "DB_CYCLES", _gauge("devbot_db_cycles", "", ["model", "label"]))


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
