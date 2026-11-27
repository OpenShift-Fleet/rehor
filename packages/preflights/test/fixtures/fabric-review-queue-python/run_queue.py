#!/usr/bin/env python3
"""Run the vendored Fabric review_queue.main() against a stubbed world.

Usage: python3 run_queue.py <scenario.json>

The scenario file describes one queue cycle: memory tasks, the labeled PR
listing, issue comments, label events, organization membership, and what the
tracked review restores. Every external boundary (Bot Memory, the gh CLI,
organization membership) is replaced; the candidate ladder, command scans,
approval and ledger-recovery decisions, and restore ordering are the real
Fabric code. Output on stdout is one JSON object:

    {"status": <start|skip|error>, "content": <result content>,
     "writes": [{"method", "path", "fields"}]}

`writes` records the gh api mutations the Python preflight issued.
"""

from __future__ import annotations

import json
import os
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESTORE_FIXTURE = HERE.parent / "fabric-restore-review-ledger"
sys.path.insert(0, str(RESTORE_FIXTURE))
sys.path.insert(0, str(HERE))

import review_queue as queue  # noqa: E402


class FakeCompleted:
    def __init__(self):
        self.returncode = 0
        self.stdout = "HTTP/1.1 200 OK\n\n{}"
        self.stderr = ""


def fake_subprocess(writes):
    def run(cmd, **kwargs):
        if cmd[:2] == ["gh", "api"]:
            method = "GET"
            if "--method" in cmd:
                method = cmd[cmd.index("--method") + 1]
            path = next(
                part for part in cmd[2:] if part.startswith(("repos/", "orgs/"))
            )
            fields = {}
            for index, part in enumerate(cmd):
                if part == "--field" and index + 1 < len(cmd):
                    name, _, value = cmd[index + 1].partition("=")
                    fields[name] = value
            if method in ("POST", "PATCH", "DELETE"):
                writes.append({"method": method, "path": path, "fields": fields})
        return FakeCompleted()

    return types.SimpleNamespace(run=run)


def main() -> None:
    scenario = json.loads(Path(sys.argv[1]).read_text())
    writes: list[dict] = []
    os.environ["GH_USER_NAME"] = ""
    queue.subprocess = fake_subprocess(writes)
    queue.load_config = lambda: {"review_label": "dev-bot-review"}
    queue.load_project_repos = lambda: {"repo": {"upstream": "https://github.com/org/repo.git"}}
    queue.load_tasks = lambda: scenario["tasks"]
    queue._bot_login = lambda: "review-bot"
    queue.list_prs = lambda repo, label: scenario["prs"]
    members = scenario.get("members", {})

    def fake_member(org, login):
        if login in members:
            return members[login]
        raise RuntimeError(f"unexpected member check: {login}")

    queue._is_org_member = fake_member

    def fake_api_items(endpoint, since=None):
        if endpoint.endswith("/events"):
            return scenario.get("events", [])
        return []

    queue._api_items = fake_api_items
    queue.fetch_comments = lambda repo, number, since=None: scenario["comments"]

    restore = scenario["restore"]

    def fake_restore(repo, pr, review_id, bot_login, expected_head=None):
        mode = restore["mode"]
        if mode == "payload":
            return restore["payload"]
        if mode == "missing":
            raise queue.LedgerPayloadMissing("no embedded ledger payload")
        exc = queue.EmptyPendingReview("empty pending draft")
        exc.reusable = bool(restore.get("reusable", True))
        raise exc

    queue.restore_from_review = fake_restore
    queue.write_cycle_ledger = (
        lambda repo_key, pr, head, base, ledger:
        "data/review-context/restored-ledgers/stub.json"
    )
    results: list[tuple[str, str]] = []
    queue.output_result = lambda status, content: results.append((status, content))
    queue.main()
    status, content = results[0]
    print(json.dumps({"status": status, "content": content, "writes": writes}))


if __name__ == "__main__":
    main()
