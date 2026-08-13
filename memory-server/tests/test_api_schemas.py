"""Validate that API serializer output conforms to OpenAPI component schemas.

These tests catch drift between the backend response shape and the
shared contract in shared/openapi.yaml.  If a serializer field is added,
removed, or renamed, these tests fail until the spec is updated —
which in turn breaks the dashboard fixture tests, enforcing cross-side
consistency.
"""

import json
from datetime import UTC, datetime
from pathlib import Path

import jsonschema
import pytest
import yaml
from bot_memory_server.api import _cycle, _cycle_run, _memory, _task

OPENAPI_PATH = Path(__file__).resolve().parent.parent.parent / "shared" / "openapi.yaml"


def _load_schemas() -> dict[str, dict]:
    spec = yaml.safe_load(OPENAPI_PATH.read_text())
    return spec["components"]["schemas"]


_SCHEMAS = _load_schemas()


def _validate(instance, schema_name: str):
    schema = _resolve_refs(_SCHEMAS[schema_name], _SCHEMAS)
    jsonschema.validate(instance, schema)


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


# --------------- fake row builders ---------------


def _fake_task_row(**overrides):
    now = datetime.now(UTC)
    row = {
        "id": 1,
        "external_key": "TEST-001",
        "source_type": "jira",
        "source_url": "https://issues.redhat.com/browse/TEST-001",
        "artifacts": json.dumps([{"name": "PR #1", "url": "https://github.com/test/pull/1", "type": "pr"}]),
        "status": "in_progress",
        "repo": "test-repo",
        "branch": "main",
        "title": "Test task",
        "summary": "A test task",
        "created_at": now,
        "last_addressed": now,
        "paused_reason": None,
        "instance_id": "dev-bot",
        "metadata": json.dumps({"priority": "high"}),
    }
    row.update(overrides)
    return row


def _fake_memory_row(**overrides):
    now = datetime.now(UTC)
    row = {
        "id": 1,
        "category": "bug",
        "repo": "test-repo",
        "external_key": "TEST-001",
        "source_type": "jira",
        "title": "Test memory",
        "content": "Some content",
        "tags": ["tag1", "tag2"],
        "created_at": now,
        "metadata": json.dumps({"key": "value"}),
    }
    row.update(overrides)
    return row


def _fake_cycle_run_row(**overrides):
    now = datetime.now(UTC)
    row = {
        "id": 1,
        "task_id": 42,
        "cycle_type": "task_work",
        "instance_id": "test-instance",
        "started_at": now,
        "finished_at": now,
        "tool_calls": 50,
        "tokens_used": 100000,
        "progress": json.dumps({"last_step": "implemented"}),
        "input_prompt": "Fix the bug",
        "created_at": now,
        "has_transcript": False,
    }
    row.update(overrides)
    return row


def _fake_cycle_row(**overrides):
    now = datetime.now(UTC)
    row = {
        "id": 1,
        "timestamp": now,
        "label": "impl-TEST-001",
        "session_id": "session-1",
        "num_turns": 8,
        "duration_ms": 300000,
        "cost_usd": 0.15,
        "input_tokens": 10000,
        "output_tokens": 5000,
        "cache_read_tokens": 2000,
        "cache_write_tokens": 1000,
        "model": "claude-sonnet-4",
        "is_error": False,
        "no_work": False,
        "external_key": "TEST-001",
        "source_type": "jira",
        "repo": "test-repo",
        "work_type": "implementation",
        "summary": "Completed work",
    }
    row.update(overrides)
    return row


# --------------- item schema tests ---------------


class TestTaskItemSchema:
    def test_basic_task(self):
        result = _task(_fake_task_row())
        _validate(result, "TaskItem")

    def test_task_with_slack_notification(self):
        notif = {"event_type": "task_started", "message": "Started", "sent_at": "2026-07-01T10:00:00Z"}
        result = _task(_fake_task_row(), slack_notif=notif)
        _validate(result, "TaskItem")
        assert result["slack_notification"] == notif

    def test_task_with_null_optionals(self):
        result = _task(
            _fake_task_row(
                source_url=None,
                title=None,
                summary=None,
                last_addressed=datetime.now(UTC),
                instance_id=None,
            )
        )
        _validate(result, "TaskItem")

    def test_task_jira_key_matches_external_key(self):
        result = _task(_fake_task_row(external_key="RHCLOUD-999"))
        assert result["jira_key"] == result["external_key"] == "RHCLOUD-999"

    def test_task_with_multiple_artifacts(self):
        artifacts = [
            {"name": "PR #1", "url": "https://github.com/pull/1", "type": "pr"},
            {"name": "Branch", "url": "https://github.com/tree/main", "type": "branch"},
            {"name": "Build", "url": "https://ci.example.com/1", "type": "ci"},
        ]
        result = _task(_fake_task_row(artifacts=json.dumps(artifacts)))
        _validate(result, "TaskItem")
        assert len(result["artifacts"]) == 3

    def test_task_with_empty_artifacts(self):
        result = _task(_fake_task_row(artifacts=None))
        _validate(result, "TaskItem")
        assert result["artifacts"] == []

    def test_task_metadata_as_dict(self):
        result = _task(_fake_task_row(metadata={"key": "val"}))
        _validate(result, "TaskItem")

    def test_extra_field_rejected(self):
        result = _task(_fake_task_row())
        result["unexpected_field"] = "boom"
        with pytest.raises(jsonschema.ValidationError, match="Additional properties"):
            _validate(result, "TaskItem")


class TestMemoryItemSchema:
    def test_basic_memory(self):
        result = _memory(_fake_memory_row())
        _validate(result, "MemoryItem")

    def test_memory_with_null_optionals(self):
        result = _memory(_fake_memory_row(external_key=None, source_type=None))
        _validate(result, "MemoryItem")

    def test_memory_with_empty_tags(self):
        result = _memory(_fake_memory_row(tags=[]))
        _validate(result, "MemoryItem")
        assert result["tags"] == []

    def test_memory_metadata_as_dict(self):
        result = _memory(_fake_memory_row(metadata={"nested": {"key": "val"}}))
        _validate(result, "MemoryItem")

    def test_extra_field_rejected(self):
        result = _memory(_fake_memory_row())
        result["unexpected"] = True
        with pytest.raises(jsonschema.ValidationError, match="Additional properties"):
            _validate(result, "MemoryItem")


class TestCycleRunItemSchema:
    def test_basic_cycle_run(self):
        result = _cycle_run(_fake_cycle_run_row())
        _validate(result, "CycleRunItem")

    def test_cycle_run_with_null_task(self):
        result = _cycle_run(_fake_cycle_run_row(task_id=None))
        _validate(result, "CycleRunItem")
        assert result["task_id"] is None

    def test_cycle_run_with_null_timestamps(self):
        result = _cycle_run(_fake_cycle_run_row(started_at=None, finished_at=None))
        _validate(result, "CycleRunItem")

    def test_cycle_run_with_null_input_prompt(self):
        result = _cycle_run(_fake_cycle_run_row(input_prompt=None))
        _validate(result, "CycleRunItem")

    def test_cycle_run_without_input_prompt_key(self):
        row = _fake_cycle_run_row()
        del row["input_prompt"]
        result = _cycle_run(row)
        _validate(result, "CycleRunItem")
        assert result["input_prompt"] is None

    def test_extra_field_rejected(self):
        result = _cycle_run(_fake_cycle_run_row())
        result["extra"] = 123
        with pytest.raises(jsonschema.ValidationError, match="Additional properties"):
            _validate(result, "CycleRunItem")


class TestCycleEntryItemSchema:
    def test_basic_cycle_entry(self):
        result = _cycle(_fake_cycle_row())
        _validate(result, "CycleEntryItem")

    def test_cycle_entry_with_null_optionals(self):
        result = _cycle(
            _fake_cycle_row(
                external_key=None,
                source_type=None,
                repo=None,
                work_type=None,
                summary=None,
            )
        )
        _validate(result, "CycleEntryItem")

    def test_cycle_entry_cost_is_float(self):
        result = _cycle(_fake_cycle_row(cost_usd=0))
        _validate(result, "CycleEntryItem")
        assert isinstance(result["cost_usd"], float)

    def test_extra_field_rejected(self):
        result = _cycle(_fake_cycle_row())
        result["extra"] = "field"
        with pytest.raises(jsonschema.ValidationError, match="Additional properties"):
            _validate(result, "CycleEntryItem")


# --------------- envelope schema tests ---------------


class TestPaginatedEnvelopeSchema:
    def test_valid_envelope(self):
        envelope = {
            "items": [_task(_fake_task_row())],
            "total": 1,
            "limit": 20,
            "offset": 0,
        }
        _validate(envelope, "PaginatedResponse")

    def test_empty_items(self):
        envelope = {"items": [], "total": 0, "limit": 20, "offset": 0}
        _validate(envelope, "PaginatedResponse")

    def test_missing_total_rejected(self):
        envelope = {"items": [], "limit": 20, "offset": 0}
        with pytest.raises(jsonschema.ValidationError, match="'total' is a required"):
            _validate(envelope, "PaginatedResponse")

    def test_missing_limit_rejected(self):
        envelope = {"items": [], "total": 0, "offset": 0}
        with pytest.raises(jsonschema.ValidationError, match="'limit' is a required"):
            _validate(envelope, "PaginatedResponse")

    def test_extra_field_rejected(self):
        envelope = {"items": [], "total": 0, "limit": 20, "offset": 0, "extra": True}
        with pytest.raises(jsonschema.ValidationError, match="Additional properties"):
            _validate(envelope, "PaginatedResponse")

    def test_negative_total_rejected(self):
        envelope = {"items": [], "total": -1, "limit": 20, "offset": 0}
        with pytest.raises(jsonschema.ValidationError):
            _validate(envelope, "PaginatedResponse")

    def test_zero_limit_rejected(self):
        envelope = {"items": [], "total": 0, "limit": 0, "offset": 0}
        with pytest.raises(jsonschema.ValidationError):
            _validate(envelope, "PaginatedResponse")


class TestCostsResponseSchema:
    def test_valid_costs_response(self):
        response = {
            "items": [_cycle(_fake_cycle_row())],
            "daily": [
                {
                    "day": "2026-07-01",
                    "cycles": 2,
                    "total_cost": 0.20,
                    "input_tokens": 20000,
                    "output_tokens": 10000,
                    "cache_read": 4000,
                    "cache_write": 2000,
                    "total_duration": 600000,
                    "total_turns": 16,
                    "idle_cycles": 0,
                    "error_cycles": 0,
                }
            ],
        }
        _validate(response, "CostsResponse")

    def test_empty_costs_response(self):
        response = {"items": [], "daily": []}
        _validate(response, "CostsResponse")

    def test_costs_with_paginated_fields_rejected(self):
        response = {"items": [], "daily": [], "total": 0, "limit": 20, "offset": 0}
        with pytest.raises(jsonschema.ValidationError, match="Additional properties"):
            _validate(response, "CostsResponse")

    def test_missing_daily_rejected(self):
        response = {"items": []}
        with pytest.raises(jsonschema.ValidationError, match="'daily' is a required"):
            _validate(response, "CostsResponse")
