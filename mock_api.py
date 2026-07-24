#!/usr/bin/env python3
"""Minimal mock API server for testing pause/unpause UI."""

import base64
import hashlib
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# Add dashboard/tests to path so we can import fixtures
sys.path.insert(0, str(Path(__file__).parent / "dashboard" / "tests"))

from fixtures.api_payloads import (
    ACTIVE_STATUSES,
    ANALYTICS,
    BOT_STATUS,
    COSTS,
    CYCLE_RUNS,
    EMBEDDINGS,
    MAX_ACTIVE,
    MEMORIES,
    TAGS,
    TASK_CYCLE_GROUPS,
    TASKS,
)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"  {self.command} {self.path} → {args[1]}")

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.headers.get("Upgrade", "").lower() == "websocket":
            key = self.headers.get("Sec-WebSocket-Key", "")
            accept = base64.b64encode(
                hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
            ).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            try:
                while True:
                    self.rfile.read(1)
            except Exception:
                pass
            return

        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/api/tasks":
            status_filter = qs.get("status", [None])[0]
            exclude = qs.get("exclude_status", [None])[0]
            instance_filter = qs.get("instance_id", [None])[0]
            limit = int(qs.get("limit", ["20"])[0])
            offset = int(qs.get("offset", ["0"])[0])

            tasks = list(TASKS.values())
            if status_filter:
                tasks = [t for t in tasks if t["status"] == status_filter]
            elif exclude:
                tasks = [t for t in tasks if t["status"] != exclude]
            if instance_filter:
                tasks = [t for t in tasks if t.get("instance_id") == instance_filter]

            total = len(tasks)
            tasks = tasks[offset : offset + limit]
            self.send_json({"items": tasks, "total": total, "limit": limit, "offset": offset})

        elif path == "/api/stats":
            task_counts: dict = {}
            for t in TASKS.values():
                task_counts[t["status"]] = task_counts.get(t["status"], 0) + 1
            self.send_json(
                {
                    "tasks": task_counts,
                    "memories": {"total": len(MEMORIES)},
                }
            )

        elif path == "/api/bot-status":
            self.send_json(BOT_STATUS)

        elif path == "/api/instances":
            self.send_json(
                [
                    {
                        "instance_id": BOT_STATUS["instance_id"],
                        "state": BOT_STATUS["state"],
                        "message": BOT_STATUS["message"],
                        "external_key": BOT_STATUS["external_key"],
                        "source_type": "jira",
                        "source_url": None,
                        "repo": BOT_STATUS["repo"],
                        "cycle_start": BOT_STATUS["cycle_start"],
                        "updated_at": BOT_STATUS["updated_at"],
                        "active_tasks": sum(1 for t in TASKS.values() if t["status"] in ACTIVE_STATUSES),
                        "max_tasks": MAX_ACTIVE,
                    }
                ]
            )

        elif path == "/api/memories":
            category = qs.get("category", [None])[0]
            repo = qs.get("repo", [None])[0]
            tag = qs.get("tag", [None])[0]
            limit = int(qs.get("limit", ["20"])[0])
            offset = int(qs.get("offset", ["0"])[0])

            memories = MEMORIES[:]
            if category:
                memories = [m for m in memories if m["category"] == category]
            if repo:
                memories = [m for m in memories if m["repo"] == repo]
            if tag:
                memories = [m for m in memories if tag in m["tags"]]

            total = len(memories)
            memories = memories[offset : offset + limit]
            self.send_json({"items": memories, "total": total, "limit": limit, "offset": offset})

        elif (
            path.startswith("/api/memories/") and path != "/api/memories/search" and path != "/api/memories/embeddings"
        ):
            mem_id = int(path.split("/")[-1])
            memory = next((m for m in MEMORIES if m["id"] == mem_id), None)
            if memory:
                self.send_json(memory)
            else:
                self.send_json({"error": "not found"}, 404)

        elif path == "/api/memories/search":
            query = qs.get("q", [""])[0]
            category = qs.get("category", [None])[0]
            repo = qs.get("repo", [None])[0]
            tag = qs.get("tag", [None])[0]
            limit = int(qs.get("limit", ["20"])[0])

            memories = MEMORIES[:]
            if query:
                q = query.lower()
                memories = [m for m in memories if q in m["title"].lower() or q in m["content"].lower()]
            if category:
                memories = [m for m in memories if m["category"] == category]
            if repo:
                memories = [m for m in memories if m["repo"] == repo]
            if tag:
                memories = [m for m in memories if tag in m["tags"]]

            for m in memories:
                m["similarity"] = 0.85

            memories = memories[:limit]
            self.send_json({"items": memories, "total": len(memories)})

        elif path == "/api/memories/embeddings":
            self.send_json({"items": EMBEDDINGS, "total": len(EMBEDDINGS)})

        elif path == "/api/tags":
            self.send_json(TAGS)

        elif path == "/api/costs":
            limit = int(qs.get("limit", ["200"])[0])

            costs = COSTS[:limit]
            self.send_json({"items": costs, "total": len(costs), "limit": limit, "offset": 0})

        elif path == "/api/cycle-runs":
            task_id = qs.get("task_id", [None])[0]
            instance_id = qs.get("instance_id", [None])[0]
            cycle_type = qs.get("cycle_type", [None])[0]
            limit = int(qs.get("limit", ["50"])[0])
            offset = int(qs.get("offset", ["0"])[0])

            runs = CYCLE_RUNS[:]
            if task_id is not None:
                if task_id == "none":
                    runs = [r for r in runs if r["task_id"] is None]
                else:
                    runs = [r for r in runs if r["task_id"] == int(task_id)]
            if instance_id:
                runs = [r for r in runs if r.get("instance_id") == instance_id]
            if cycle_type:
                runs = [r for r in runs if r["cycle_type"] == cycle_type]

            total = len(runs)
            runs = runs[offset : offset + limit]
            self.send_json({"items": runs, "total": total, "limit": limit, "offset": offset})

        elif path == "/api/cycle-runs/by-task":
            instance_id = qs.get("instance_id", [None])[0]
            groups = TASK_CYCLE_GROUPS[:]
            if instance_id:
                # In real impl would filter, here just return all
                pass
            self.send_json({"items": groups, "total": len(groups)})

        elif path.startswith("/api/cycle-runs/") and "/transcript" in path:
            run_id = int(path.split("/")[3])
            transcript = (
                f"# Transcript for cycle run {run_id}\n\n"
                "This is a mock transcript.\n\n"
                "## Turn 1\nUser: Fix the bug\nAssistant: I'll help fix that.\n"
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(transcript.encode())

        elif path == "/api/analytics":
            self.send_json(ANALYTICS)

        else:
            self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        parts = path.strip("/").split("/")

        if len(parts) == 4 and parts[0] == "api" and parts[1] == "tasks" and parts[3] == "pause":
            key = parts[2]
            if key not in TASKS:
                return self.send_json({"error": f"Task {key} not found"}, 404)
            body = self.read_body()
            TASKS[key]["status"] = "paused"
            TASKS[key]["paused_reason"] = body.get("paused_reason") or None
            print(f"  Paused {key} — reason: {TASKS[key]['paused_reason']}")
            return self.send_json({"paused": True, "external_key": key, "task": TASKS[key]})

        if len(parts) == 4 and parts[0] == "api" and parts[1] == "tasks" and parts[3] == "unpause":
            key = parts[2]
            if key not in TASKS:
                return self.send_json({"error": f"Task {key} not found"}, 404)
            active = sum(1 for t in TASKS.values() if t["status"] in ACTIVE_STATUSES)
            if active >= MAX_ACTIVE:
                msg = f"Cannot unpause task: {active} active tasks (max {MAX_ACTIVE}). Pause or complete a task first."
                return self.send_json({"error": msg}, 409)
            TASKS[key]["status"] = "in_progress"
            TASKS[key]["paused_reason"] = None
            print(f"  Unpaused {key}")
            return self.send_json({"unpaused": True, "external_key": key, "task": TASKS[key]})

        if path == "/api/bot-status":
            body = self.read_body()
            BOT_STATUS.update(
                {
                    "state": body.get("state", BOT_STATUS["state"]),
                    "message": body.get("message", BOT_STATUS["message"]),
                    "external_key": body.get("external_key", BOT_STATUS["external_key"]),
                    "repo": body.get("repo", BOT_STATUS["repo"]),
                }
            )
            print(f"  bot-status → state={BOT_STATUS['state']} key={BOT_STATUS['external_key']}")
            return self.send_json({"ok": True})

        if len(parts) == 4 and parts[0] == "api" and parts[1] == "instances" and parts[3] == "wake":
            print(f"  Wake requested for {parts[2]}")
            BOT_STATUS["state"] = "working"
            BOT_STATUS["message"] = "Starting cycle..."
            return self.send_json({"ok": True})

        if len(parts) == 4 and parts[3] == "unarchive":
            key = parts[2]
            if key not in TASKS:
                return self.send_json({"error": "not found"}, 404)
            TASKS[key]["status"] = "in_progress"
            return self.send_json({"task": TASKS[key]})

        self.send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        parts = urlparse(self.path).path.strip("/").split("/")

        if len(parts) == 3 and parts[0] == "api" and parts[1] == "tasks":
            key = parts[2]
            if key in TASKS:
                TASKS[key]["status"] = "archived"
                print(f"  Archived {key}")
            return self.send_json({"archived": True})

        if len(parts) == 3 and parts[0] == "api" and parts[1] == "memories":
            mem_id = int(parts[2])
            global MEMORIES
            MEMORIES = [m for m in MEMORIES if m["id"] != mem_id]
            print(f"  Deleted memory {mem_id}")
            return self.send_json({"deleted": True})

        self.send_json({"error": "not found"}, 404)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
    print("=" * 60)
    print("Mock API Server for Dev Bot Dashboard")
    print("=" * 60)
    print("\nServer running at http://localhost:8080\n")
    print("Available Routes:")
    print("  GET  /api/tasks             - List tasks (with filters)")
    print("  GET  /api/stats             - Task & memory stats")
    print("  GET  /api/bot-status        - Bot status")
    print("  GET  /api/instances         - Bot instances")
    print("  GET  /api/memories          - List memories (with filters)")
    print("  GET  /api/memories/:id      - Get memory by ID")
    print("  GET  /api/memories/search   - Search memories")
    print("  GET  /api/memories/embeddings - Get embedding data")
    print("  GET  /api/tags              - List all tags")
    print("  GET  /api/costs             - Cost tracking data")
    print("  GET  /api/cycle-runs        - Cycle run history")
    print("  GET  /api/cycle-runs/by-task - Cycle runs grouped by task")
    print("  GET  /api/cycle-runs/:id/transcript - Cycle run transcript")
    print("  GET  /api/analytics         - Analytics summary")
    print("  POST /api/tasks/:key/pause  - Pause a task")
    print("  POST /api/tasks/:key/unpause - Unpause a task")
    print("  POST /api/tasks/:key/unarchive - Unarchive a task")
    print("  POST /api/instances/:id/wake - Wake an instance")
    print("  POST /api/bot-status        - Update bot status")
    print("  DELETE /api/tasks/:key      - Archive a task")
    print("  DELETE /api/memories/:id    - Delete a memory")
    print("\nMock Data:")
    print(f"  Tasks: {len(TASKS)} ({', '.join(TASKS.keys())})")
    print(f"  Memories: {len(MEMORIES)} (categories: bug, architecture, decision, workaround)")
    print(f"  Cycle Runs: {len(CYCLE_RUNS)}")
    print(f"  Cost Entries: {len(COSTS)}")
    print(f"  Embeddings: {len(EMBEDDINGS)}")
    print(f"  Tags: {len(TAGS)}")
    print("=" * 60)
    print()
    server.serve_forever()
