#!/usr/bin/env python3
"""Generate fixtures.json for TypeScript test helpers.

Exports all default datasets from api_payloads.py as a single JSON file
so that Python and TypeScript tests share the same fixture data.

Usage:
    python3 dashboard/tests/fixtures/generate_json.py
"""

import json
import sys
from pathlib import Path

from api_payloads import (
    ANALYTICS,
    BOT_STATUS,
    COSTS,
    CYCLE_RUNS,
    DAILY_COSTS,
    EMBEDDINGS,
    MEMORIES,
    TAGS,
    TASK_CYCLE_GROUPS,
    TASKS,
)

OUTPUT = Path(__file__).resolve().parent.parent.parent / "src" / "test" / "fixtures.json"
OPENAPI_PATH = Path(__file__).resolve().parent.parent.parent.parent / "shared" / "openapi.yaml"


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


def _validate_fixtures(data):
    """Validate fixture data against OpenAPI component schemas."""
    import jsonschema
    import yaml

    spec = yaml.safe_load(OPENAPI_PATH.read_text())
    all_schemas = spec["components"]["schemas"]

    def resolve(name):
        return _resolve_refs(all_schemas[name], all_schemas)

    task_schema = resolve("TaskItem")
    memory_schema = resolve("MemoryItem")
    cycle_run_schema = resolve("CycleRunItem")
    cycle_entry_schema = resolve("CycleEntryItem")
    paginated_schema = resolve("PaginatedResponse")
    costs_resp_schema = resolve("CostsResponse")

    errors = []

    for key, t in data["tasks"].items():
        try:
            jsonschema.validate(t, task_schema)
        except jsonschema.ValidationError as e:
            errors.append(f"task {key}: {e.message}")

    for i, m in enumerate(data["memories"]):
        try:
            jsonschema.validate(m, memory_schema)
        except jsonschema.ValidationError as e:
            errors.append(f"memory {i}: {e.message}")

    for i, cr in enumerate(data["cycleRuns"]):
        try:
            jsonschema.validate(cr, cycle_run_schema)
        except jsonschema.ValidationError as e:
            errors.append(f"cycleRun {i}: {e.message}")

    for i, c in enumerate(data["costs"]):
        try:
            jsonschema.validate(c, cycle_entry_schema)
        except jsonschema.ValidationError as e:
            errors.append(f"cost {i}: {e.message}")

    envelope = {"items": list(data["tasks"].values()), "total": len(data["tasks"]), "limit": 20, "offset": 0}
    try:
        jsonschema.validate(envelope, paginated_schema)
    except jsonschema.ValidationError as e:
        errors.append(f"paginated envelope: {e.message}")

    costs_envelope = {"items": data["costs"], "daily": data["dailyCosts"]}
    try:
        jsonschema.validate(costs_envelope, costs_resp_schema)
    except jsonschema.ValidationError as e:
        errors.append(f"costs response: {e.message}")

    if errors:
        print("Schema validation errors:")
        for err in errors:
            print(f"  - {err}")
        raise SystemExit(1)

    print(
        f"Validated {len(data['tasks'])} tasks, {len(data['memories'])} memories, "
        f"{len(data['cycleRuns'])} cycle runs, {len(data['costs'])} costs against OpenAPI schemas"
    )


def main():
    data = {
        "tasks": TASKS,
        "memories": MEMORIES,
        "cycleRuns": CYCLE_RUNS,
        "costs": COSTS,
        "dailyCosts": DAILY_COSTS,
        "embeddings": EMBEDDINGS,
        "tags": TAGS,
        "analytics": ANALYTICS,
        "botStatus": BOT_STATUS,
        "taskCycleGroups": TASK_CYCLE_GROUPS,
    }

    _validate_fixtures(data)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(data, indent=2) + "\n")
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    sys.exit(main() or 0)
