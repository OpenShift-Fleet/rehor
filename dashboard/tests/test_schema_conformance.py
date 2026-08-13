"""Validate dashboard test fixtures against OpenAPI component schemas.

If a backend serializer changes the response shape and the OpenAPI spec
is updated, these tests fail until the fixtures are updated to match —
preventing frontend/backend drift.
"""

from pathlib import Path

import jsonschema
import pytest
import yaml
from fixtures.api_payloads import (
    COSTS,
    CYCLE_RUNS,
    DAILY_COSTS,
    MEMORIES,
    TASKS,
    cycle_entry,
    cycle_run,
    memory,
    task,
)

OPENAPI_PATH = Path(__file__).resolve().parent.parent.parent / "shared" / "openapi.yaml"


def _load_schemas() -> dict[str, dict]:
    spec = yaml.safe_load(OPENAPI_PATH.read_text())
    return spec["components"]["schemas"]


_SCHEMAS = _load_schemas()


def _resolve_refs(schema: dict, all_schemas: dict) -> dict:
    """Recursively resolve $ref pointers within an OpenAPI component schema."""
    if isinstance(schema, dict):
        if "$ref" in schema:
            ref_name = schema["$ref"].split("/")[-1]
            return _resolve_refs(all_schemas[ref_name], all_schemas)
        result = {}
        for k, v in schema.items():
            if k == "nullable" and v is True:
                continue
            result[k] = _resolve_refs(v, all_schemas)
        if schema.get("nullable"):
            if "type" in result:
                result["type"] = [result["type"], "null"]
            elif "allOf" in result:
                result["oneOf"] = [*result.pop("allOf"), {"type": "null"}]
        return result
    if isinstance(schema, list):
        return [_resolve_refs(item, all_schemas) for item in schema]
    return schema


def _validate(instance, schema_name: str):
    schema = _resolve_refs(_SCHEMAS[schema_name], _SCHEMAS)
    jsonschema.validate(instance, schema)


# --------------- item factory conformance ---------------


class TestTaskFixtureConformance:
    def test_basic_task_fixture(self):
        t = task(1, "TEST-001", "Test", "in_progress")
        _validate(t, "TaskItem")

    def test_task_has_jira_key(self):
        t = task(1, "TEST-001", "Test", "in_progress")
        assert "jira_key" in t
        assert t["jira_key"] == t["external_key"]

    def test_task_paused_fixture(self):
        t = task(1, "TEST-001", "Test", "paused", paused_reason="Blocked")
        _validate(t, "TaskItem")

    def test_task_done_fixture(self):
        t = task(1, "TEST-001", "Test", "done")
        _validate(t, "TaskItem")

    @pytest.mark.parametrize("key", list(TASKS.keys()))
    def test_all_default_tasks(self, key):
        _validate(TASKS[key], "TaskItem")


class TestMemoryFixtureConformance:
    def test_basic_memory_fixture(self):
        m = memory(1, "bug", "Title", "Content")
        _validate(m, "MemoryItem")

    def test_memory_with_tags(self):
        m = memory(1, "bug", "Title", "Content", tags=["a", "b"])
        _validate(m, "MemoryItem")

    @pytest.mark.parametrize("idx", range(len(MEMORIES)))
    def test_all_default_memories(self, idx):
        _validate(MEMORIES[idx], "MemoryItem")


class TestCycleRunFixtureConformance:
    def test_basic_cycle_run_fixture(self):
        cr = cycle_run(1, 42, "implementation")
        _validate(cr, "CycleRunItem")

    def test_cycle_run_null_task(self):
        cr = cycle_run(1, None, "idle_check")
        _validate(cr, "CycleRunItem")

    @pytest.mark.parametrize("idx", range(len(CYCLE_RUNS)))
    def test_all_default_cycle_runs(self, idx):
        _validate(CYCLE_RUNS[idx], "CycleRunItem")


class TestCycleEntryFixtureConformance:
    def test_basic_cycle_entry_fixture(self):
        c = cycle_entry(1, "test-label")
        _validate(c, "CycleEntryItem")

    def test_cycle_entry_with_optionals(self):
        c = cycle_entry(1, "test", external_key="KEY-1", repo="myrepo")
        _validate(c, "CycleEntryItem")

    @pytest.mark.parametrize("idx", range(len(COSTS)))
    def test_all_default_costs(self, idx):
        _validate(COSTS[idx], "CycleEntryItem")


# --------------- envelope conformance ---------------


class TestPaginatedEnvelopeConformance:
    def test_tasks_envelope(self):
        envelope = {
            "items": list(TASKS.values()),
            "total": len(TASKS),
            "limit": 20,
            "offset": 0,
        }
        _validate(envelope, "PaginatedResponse")

    def test_memories_envelope(self):
        envelope = {
            "items": MEMORIES,
            "total": len(MEMORIES),
            "limit": 20,
            "offset": 0,
        }
        _validate(envelope, "PaginatedResponse")

    def test_cycle_runs_envelope(self):
        envelope = {
            "items": CYCLE_RUNS,
            "total": len(CYCLE_RUNS),
            "limit": 50,
            "offset": 0,
        }
        _validate(envelope, "PaginatedResponse")


class TestCostsResponseConformance:
    def test_costs_envelope(self):
        response = {"items": COSTS, "daily": DAILY_COSTS}
        _validate(response, "CostsResponse")

    def test_costs_not_paginated(self):
        response = {
            "items": COSTS,
            "daily": DAILY_COSTS,
            "total": len(COSTS),
            "limit": 200,
            "offset": 0,
        }
        with pytest.raises(jsonschema.ValidationError, match="Additional properties"):
            _validate(response, "CostsResponse")
