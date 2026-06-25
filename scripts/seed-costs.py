#!/usr/bin/env python3
"""Seed the cycles table from an existing costs.jsonl file."""

import json
import sys
from pathlib import Path

import httpx

API = "http://localhost:8080/api/costs"


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("costs.jsonl")
    if not path.exists():
        print(f"File not found: {path}")
        sys.exit(1)

    entries = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    print(f"Found {len(entries)} entries in {path}")

    ok = 0
    for entry in entries:
        try:
            r = httpx.post(API, json=entry, timeout=10.0)
            if r.status_code == 201:
                ok += 1
            else:
                print(f"  Failed ({r.status_code}): {r.text[:100]}")
        except Exception as e:
            print(f"  Error: {e}")

    print(f"Seeded {ok}/{len(entries)} entries")


if __name__ == "__main__":
    main()
