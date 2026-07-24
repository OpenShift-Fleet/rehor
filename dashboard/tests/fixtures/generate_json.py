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
    EMBEDDINGS,
    MEMORIES,
    TAGS,
    TASK_CYCLE_GROUPS,
    TASKS,
)

OUTPUT = Path(__file__).resolve().parent.parent.parent / "src" / "test" / "fixtures.json"


def main():
    data = {
        "tasks": TASKS,
        "memories": MEMORIES,
        "cycleRuns": CYCLE_RUNS,
        "costs": COSTS,
        "embeddings": EMBEDDINGS,
        "tags": TAGS,
        "analytics": ANALYTICS,
        "botStatus": BOT_STATUS,
        "taskCycleGroups": TASK_CYCLE_GROUPS,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(data, indent=2) + "\n")
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    sys.exit(main() or 0)
