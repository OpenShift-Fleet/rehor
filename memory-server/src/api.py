"""REST API endpoints for the web dashboard."""

import base64
import json
import logging
import os
from datetime import date as date_type
from datetime import datetime

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .db import get_pool
from .embeddings import embed
from .events import Event, bus

logger = logging.getLogger(__name__)


async def api_tasks(request: Request) -> JSONResponse:
    pool = get_pool()
    status = request.query_params.get("status")
    limit = int(request.query_params.get("limit", "20"))
    offset = int(request.query_params.get("offset", "0"))
    instance_id = request.query_params.get("instance_id")

    exclude = request.query_params.get("exclude_status")

    instance_clause = ""
    instance_params: list = []
    if instance_id:
        instance_clause = " AND instance_id = $__idx__"
        instance_params = [instance_id]

    if status:
        base_params = [status]
        where = "WHERE status = $1::task_status"
        if instance_id:
            idx = len(base_params) + 1
            where += f" AND instance_id = ${idx}"
            base_params.append(instance_id)

        total = await pool.fetchval(f"SELECT COUNT(*) FROM tasks {where}", *base_params)
        order_col = "last_addressed" if status == "archived" else "created_at"
        base_params.extend([limit, offset])
        rows = await pool.fetch(
            f"SELECT * FROM tasks {where} ORDER BY {order_col} DESC LIMIT ${len(base_params) - 1} OFFSET ${len(base_params)}",
            *base_params,
        )
    elif exclude:
        base_params = [exclude]
        where = "WHERE status != $1::task_status"
        if instance_id:
            idx = len(base_params) + 1
            where += f" AND instance_id = ${idx}"
            base_params.append(instance_id)

        total = await pool.fetchval(f"SELECT COUNT(*) FROM tasks {where}", *base_params)
        base_params.extend([limit, offset])
        rows = await pool.fetch(
            f"SELECT * FROM tasks {where} ORDER BY created_at DESC LIMIT ${len(base_params) - 1} OFFSET ${len(base_params)}",
            *base_params,
        )
    else:
        if instance_id:
            total = await pool.fetchval(
                "SELECT COUNT(*) FROM tasks WHERE instance_id = $1", instance_id
            )
            rows = await pool.fetch(
                "SELECT * FROM tasks WHERE instance_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
                instance_id,
                limit,
                offset,
            )
        else:
            total = await pool.fetchval("SELECT COUNT(*) FROM tasks")
            rows = await pool.fetch(
                "SELECT * FROM tasks ORDER BY created_at DESC LIMIT $1 OFFSET $2",
                limit,
                offset,
            )

    # Fetch latest Slack notification per task
    jira_keys = [r["jira_key"] for r in rows]
    notifications = {}
    if jira_keys:
        notif_rows = await pool.fetch(
            """
            SELECT DISTINCT ON (jira_key) jira_key, event_type, message, sent_at
            FROM slack_notifications
            WHERE jira_key = ANY($1)
            ORDER BY jira_key, sent_at DESC
            """,
            jira_keys,
        )
        for nr in notif_rows:
            notifications[nr["jira_key"]] = {
                "event_type": nr["event_type"],
                "message": nr["message"],
                "sent_at": nr["sent_at"].isoformat(),
            }

    return JSONResponse(
        {
            "items": [_task(r, notifications.get(r["jira_key"])) for r in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    )


async def api_task_delete(request: Request) -> JSONResponse:
    """Archive a task by jira_key (soft delete — preserves history)."""
    pool = get_pool()
    jira_key = request.path_params.get("jira_key")
    if not jira_key:
        return JSONResponse({"error": "missing jira_key"}, status_code=400)
    row = await pool.fetchrow(
        "UPDATE tasks SET status = 'archived'::task_status WHERE jira_key = $1 RETURNING *",
        jira_key,
    )
    if not row:
        return JSONResponse({"error": f"Task {jira_key} not found"}, status_code=404)
    await bus.publish(Event("task_archived", {"jira_key": jira_key}))
    return JSONResponse({"archived": True, "jira_key": jira_key, "task": _task(row)})


async def api_task_unarchive(request: Request) -> JSONResponse:
    """Restore an archived task back to paused so the bot can pick it up."""
    pool = get_pool()
    jira_key = request.path_params.get("jira_key")
    if not jira_key:
        return JSONResponse({"error": "missing jira_key"}, status_code=400)
    row = await pool.fetchrow(
        "UPDATE tasks SET status = 'in_progress'::task_status, paused_reason = NULL WHERE jira_key = $1 AND status = 'archived'::task_status RETURNING *",
        jira_key,
    )
    if not row:
        return JSONResponse(
            {"error": f"Task {jira_key} not found or not archived"}, status_code=404
        )
    await bus.publish(
        Event("task_updated", {"jira_key": jira_key, "status": "in_progress"})
    )
    return JSONResponse({"unarchived": True, "jira_key": jira_key, "task": _task(row)})


async def api_memories(request: Request) -> JSONResponse:
    pool = get_pool()
    category = request.query_params.get("category")
    repo = request.query_params.get("repo")
    tag = request.query_params.get("tag")
    limit = int(request.query_params.get("limit", "20"))
    offset = int(request.query_params.get("offset", "0"))

    conditions, params, idx = [], [], 0
    if category:
        idx += 1
        conditions.append(f"category = ${idx}")
        params.append(category)
    if repo:
        idx += 1
        conditions.append(f"repo = ${idx}")
        params.append(repo)
    if tag:
        idx += 1
        conditions.append(f"${idx} = ANY(tags)")
        params.append(tag)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    total = await pool.fetchval(f"SELECT COUNT(*) FROM memories {where}", *params)

    idx += 1
    params.append(limit)
    limit_idx = idx
    idx += 1
    params.append(offset)
    offset_idx = idx

    rows = await pool.fetch(
        f"SELECT id, category, repo, jira_key, title, content, tags, created_at, metadata FROM memories {where} ORDER BY created_at DESC LIMIT ${limit_idx} OFFSET ${offset_idx}",
        *params,
    )
    return JSONResponse(
        {
            "items": [_memory(r) for r in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    )


async def api_memory_search(request: Request) -> JSONResponse:
    pool = get_pool()
    query = request.query_params.get("q", "")
    if not query:
        return JSONResponse({"error": "missing ?q= parameter"}, status_code=400)

    category = request.query_params.get("category")
    repo = request.query_params.get("repo")
    tag = request.query_params.get("tag")
    limit = int(request.query_params.get("limit", "10"))

    vector = embed(query)
    conditions, params, idx = [], [vector, limit], 2
    if category:
        idx += 1
        conditions.append(f"category = ${idx}")
        params.append(category)
    if repo:
        idx += 1
        conditions.append(f"repo = ${idx}")
        params.append(repo)
    if tag:
        idx += 1
        conditions.append(f"${idx} = ANY(tags)")
        params.append(tag)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    rows = await pool.fetch(
        f"""
        SELECT id, category, repo, jira_key, title, content, tags, created_at, metadata,
               embedding <=> $1 AS distance
        FROM memories {where}
        ORDER BY distance LIMIT $2
        """,
        *params,
    )
    return JSONResponse(
        [{**_memory(r), "similarity": round(1 - r["distance"], 4)} for r in rows]
    )


async def api_memory_embeddings(request: Request) -> JSONResponse:
    """Return 3D projected embeddings for visualization (PCA)."""
    pool = get_pool()
    rows = await pool.fetch(
        "SELECT id, title, content, category, repo, tags, embedding FROM memories ORDER BY created_at DESC LIMIT 200"
    )
    if not rows:
        return JSONResponse([])

    import numpy as np

    embeddings = np.array([list(r["embedding"]) for r in rows])

    # Center and PCA → 3 components
    mean = embeddings.mean(axis=0)
    centered = embeddings - mean
    n_components = min(3, len(rows), centered.shape[1])
    if len(rows) > 2:
        U, S, Vt = np.linalg.svd(centered, full_matrices=False)
        proj = centered @ Vt[:n_components].T
    else:
        proj = centered[:, :n_components]

    # Pad to 3D if needed
    if proj.shape[1] < 3:
        proj = np.pad(proj, ((0, 0), (0, 3 - proj.shape[1])))

    # Normalize to [-1, 1] range for Three.js
    max_abs = np.abs(proj).max(axis=0)
    max_abs[max_abs == 0] = 1
    proj = proj / max_abs

    result = []
    for i, r in enumerate(rows):
        result.append(
            {
                "id": r["id"],
                "title": r["title"],
                "content": r["content"][:200],
                "category": r["category"],
                "repo": r["repo"],
                "tags": list(r["tags"]) if r["tags"] else [],
                "x": float(proj[i, 0]),
                "y": float(proj[i, 1]),
                "z": float(proj[i, 2]),
            }
        )
    return JSONResponse(result)


async def api_memory_get(request: Request) -> JSONResponse:
    """Get a single memory by ID."""
    pool = get_pool()
    memory_id = request.path_params.get("id")
    if not memory_id:
        return JSONResponse({"error": "missing memory id"}, status_code=400)
    row = await pool.fetchrow(
        "SELECT id, category, repo, jira_key, title, content, tags, created_at, metadata FROM memories WHERE id = $1",
        int(memory_id),
    )
    if not row:
        return JSONResponse({"error": f"Memory {memory_id} not found"}, status_code=404)
    return JSONResponse(_memory(row))


async def api_memory_delete(request: Request) -> JSONResponse:
    """Delete a memory by ID."""
    pool = get_pool()
    memory_id = request.path_params.get("id")
    if not memory_id:
        return JSONResponse({"error": "missing memory id"}, status_code=400)
    result = await pool.execute("DELETE FROM memories WHERE id = $1", int(memory_id))
    if result == "DELETE 0":
        return JSONResponse({"error": f"Memory {memory_id} not found"}, status_code=404)
    await bus.publish(Event("memory_deleted", {"id": int(memory_id)}))
    return JSONResponse({"deleted": True, "id": int(memory_id)})


async def api_memory_upload(request: Request) -> JSONResponse:
    """POST /api/memories/upload — bulk upload memories with a shared secret."""
    secret = os.environ.get("UPLOAD_MEMORY_PASSWORD")
    if not secret:
        return JSONResponse({"error": "not found"}, status_code=404)

    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer ") or auth[7:] != secret:
        return JSONResponse({"error": "forbidden"}, status_code=403)

    body = await request.json()
    memories = body.get("memories", [])
    if not memories:
        return JSONResponse({"uploaded": 0, "errors": []})

    pool = get_pool()
    uploaded = 0
    errors = []

    for i, m in enumerate(memories):
        try:
            title = m["title"]
            category = m["category"]
            content = m["content"]
            repo = m.get("repo")
            jira_key = m.get("jira_key")
            tags = m.get("tags", [])
            metadata = m.get("metadata", {})

            existing = await pool.fetchval(
                "SELECT id FROM memories WHERE title = $1 AND category = $2 AND repo IS NOT DISTINCT FROM $3",
                title,
                category,
                repo,
            )
            if existing:
                errors.append({"index": i, "title": title, "reason": "duplicate"})
                continue

            vector = embed(f"{title}\n{content}")
            row = await pool.fetchrow(
                """
                INSERT INTO memories (category, repo, jira_key, title, content, tags, embedding, metadata)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING *
                """,
                category,
                repo,
                jira_key,
                title,
                content,
                tags or [],
                vector,
                json.dumps(metadata or {}),
            )
            await bus.publish(
                Event(
                    "memory_stored",
                    {"id": row["id"], "title": title, "category": category},
                )
            )
            uploaded += 1
        except KeyError as e:
            errors.append({"index": i, "reason": f"missing field: {e}"})
        except Exception as e:
            errors.append({"index": i, "title": m.get("title", "?"), "reason": str(e)})

    logger.info("Memory upload: %d uploaded, %d errors/skipped", uploaded, len(errors))
    return JSONResponse({"uploaded": uploaded, "errors": errors})


async def api_bot_status(request: Request) -> JSONResponse:
    if request.method == "POST":
        return await api_bot_status_update(request)
    pool = get_pool()
    row = await pool.fetchrow("SELECT * FROM bot_status WHERE id = 1")
    if not row:
        return JSONResponse({"state": "unknown", "message": ""})
    return JSONResponse(
        {
            "state": row["state"],
            "message": row["message"],
            "jira_key": row["jira_key"],
            "repo": row["repo"],
            "instance_id": row.get("instance_id"),
            "cycle_start": row["cycle_start"].isoformat()
            if row["cycle_start"]
            else None,
            "updated_at": row["updated_at"].isoformat(),
        }
    )


async def api_bot_status_update(request: Request) -> JSONResponse:
    """POST /api/bot-status — update bot status from the runner."""
    pool = get_pool()
    body = await request.json()
    state = body.get("state")
    message = body.get("message", "")
    jira_key = body.get("jira_key")
    repo = body.get("repo")

    if state not in ("working", "idle", "error"):
        return JSONResponse(
            {"error": "state must be working, idle, or error"}, status_code=400
        )

    row = await pool.fetchrow(
        """
        UPDATE bot_status SET state = $1, message = $2, jira_key = $3, repo = $4,
            cycle_start = CASE WHEN state = 'idle' AND $1 = 'working' THEN NOW() ELSE cycle_start END,
            updated_at = NOW()
        WHERE id = 1 RETURNING *
        """,
        state,
        message,
        jira_key,
        repo,
    )
    result = {
        "state": row["state"],
        "message": row["message"],
        "jira_key": row["jira_key"],
        "repo": row["repo"],
        "cycle_start": row["cycle_start"].isoformat() if row["cycle_start"] else None,
        "updated_at": row["updated_at"].isoformat(),
    }
    await bus.publish(Event("bot_status", result))
    return JSONResponse(result)


async def api_instances(request: Request) -> JSONResponse:
    """GET /api/instances — list all bot instances with aggregated task counts."""
    pool = get_pool()
    instance_rows = await pool.fetch(
        "SELECT * FROM bot_instances ORDER BY updated_at DESC"
    )
    # Count active tasks per instance
    task_counts = await pool.fetch(
        """
        SELECT instance_id, COUNT(*) AS active
        FROM tasks
        WHERE status IN ('in_progress', 'pr_open', 'pr_changes')
        AND instance_id IS NOT NULL
        GROUP BY instance_id
        """
    )
    counts_map = {r["instance_id"]: r["active"] for r in task_counts}

    result = []
    for r in instance_rows:
        result.append(
            {
                "instance_id": r["instance_id"],
                "state": r["state"],
                "message": r["message"],
                "jira_key": r["jira_key"],
                "repo": r["repo"],
                "cycle_start": r["cycle_start"].isoformat()
                if r["cycle_start"]
                else None,
                "updated_at": r["updated_at"].isoformat(),
                "active_tasks": counts_map.get(r["instance_id"], 0),
                "max_tasks": 10,
            }
        )
    return JSONResponse(result)


async def api_costs(request: Request) -> JSONResponse:
    """GET /api/costs — list cycle cost records. POST to add one."""
    if request.method == "POST":
        return await api_costs_add(request)
    pool = get_pool()
    limit = int(request.query_params.get("limit", "200"))
    date_filter, date_params = _parse_date_filter(request)

    pidx = len(date_params) + 1
    rows = await pool.fetch(
        f"SELECT * FROM cycles WHERE {date_filter} ORDER BY timestamp DESC LIMIT ${pidx}",
        *date_params,
        limit,
    )
    items = [_cycle(r) for r in rows]

    # Daily aggregates
    daily_rows = await pool.fetch(
        f"""
        SELECT DATE(timestamp) AS day,
               COUNT(*) AS cycles,
               SUM(cost_usd) AS total_cost,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read,
               SUM(cache_write_tokens) AS cache_write,
               SUM(duration_ms) AS total_duration,
               SUM(num_turns) AS total_turns,
               SUM(CASE WHEN no_work THEN 1 ELSE 0 END) AS idle_cycles,
               SUM(CASE WHEN is_error THEN 1 ELSE 0 END) AS error_cycles
        FROM cycles
        WHERE {date_filter}
        GROUP BY DATE(timestamp)
        ORDER BY day DESC
        """,
        *date_params,
    )
    daily = [
        {
            "day": str(r["day"]),
            "cycles": r["cycles"],
            "total_cost": float(r["total_cost"] or 0),
            "input_tokens": r["input_tokens"],
            "output_tokens": r["output_tokens"],
            "cache_read": r["cache_read"],
            "cache_write": r["cache_write"],
            "total_duration": r["total_duration"],
            "total_turns": r["total_turns"],
            "idle_cycles": r["idle_cycles"],
            "error_cycles": r["error_cycles"],
        }
        for r in daily_rows
    ]

    return JSONResponse({"items": items, "daily": daily})


async def api_costs_add(request: Request) -> JSONResponse:
    """POST /api/costs — record a new cycle cost entry."""
    pool = get_pool()
    body = await request.json()

    row = await pool.fetchrow(
        """
        INSERT INTO cycles (label, session_id, num_turns, duration_ms, cost_usd,
                            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                            model, is_error, no_work,
                            jira_key, repo, work_type, summary)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING *
        """,
        body.get("label", ""),
        body.get("session_id", ""),
        body.get("num_turns", 0),
        body.get("duration_ms", 0),
        body.get("cost_usd", 0),
        body.get("input_tokens", 0),
        body.get("output_tokens", 0),
        body.get("cache_read_tokens", 0),
        body.get("cache_write_tokens", 0),
        body.get("model", ""),
        body.get("is_error", False),
        body.get("no_work", False),
        body.get("jira_key"),
        body.get("repo"),
        body.get("work_type"),
        body.get("summary"),
    )
    cycle = _cycle(row)
    await bus.publish(Event("cycle_recorded", cycle))
    return JSONResponse(cycle, status_code=201)


def _parse_date_filter(request: Request):
    """Build date filter clause + params from request query params."""
    days = int(request.query_params.get("days", "30"))
    date_from = request.query_params.get("from")
    date_to = request.query_params.get("to")

    if date_from and date_to:
        return (
            "timestamp >= $1 AND timestamp < ($2 + interval '1 day')",
            [date_type.fromisoformat(date_from), date_type.fromisoformat(date_to)],
        )
    if date_from:
        return "timestamp >= $1", [date_type.fromisoformat(date_from)]
    if date_to:
        return "timestamp < ($1 + interval '1 day')", [date_type.fromisoformat(date_to)]
    return "timestamp > NOW() - make_interval(days => $1)", [days]


async def api_analytics(request: Request) -> JSONResponse:
    """GET /api/analytics — aggregated stats for the analytics dashboard."""
    pool = get_pool()
    date_filter, date_params = _parse_date_filter(request)

    # Work type breakdown (derived from ticket titles + work_type)
    work_type_rows = await pool.fetch(
        f"""
        SELECT
            CASE
                WHEN summary ILIKE '%%investigation%%' OR work_type = 'investigation' THEN 'investigation'
                WHEN jira_key IS NOT NULL AND (
                    summary ILIKE '%%CVE%%' OR summary ILIKE '%%cve%%'
                    OR jira_key IN (SELECT DISTINCT jira_key FROM tasks WHERE title ILIKE '%%CVE%%')
                ) THEN 'cve'
                WHEN work_type = 'pr_review' THEN 'pr_review'
                WHEN work_type = 'new_ticket' THEN 'new_ticket'
                WHEN no_work THEN 'idle'
                WHEN is_error THEN 'error'
                ELSE 'other'
            END AS category,
            COUNT(*) AS cycles,
            ROUND(SUM(cost_usd)::numeric, 2) AS total_cost,
            ROUND(AVG(cost_usd)::numeric, 2) AS avg_cost,
            ROUND(AVG(num_turns)::numeric, 1) AS avg_turns,
            ROUND(AVG(duration_ms)::numeric, 0) AS avg_duration_ms
        FROM cycles
        WHERE {date_filter}
        GROUP BY category
        ORDER BY cycles DESC
        """,
        *date_params,
    )

    # Per-repo breakdown
    repo_rows = await pool.fetch(
        f"""
        SELECT repo,
            COUNT(DISTINCT jira_key) AS tickets,
            COUNT(*) AS cycles,
            ROUND(SUM(cost_usd)::numeric, 2) AS total_cost,
            ROUND(AVG(num_turns)::numeric, 1) AS avg_turns
        FROM cycles
        WHERE {date_filter} AND repo IS NOT NULL AND NOT no_work
        GROUP BY repo
        ORDER BY cycles DESC
        """,
        *date_params,
    )

    # Ticket lifecycle — cycles per ticket, impl vs review, cost, time to resolve
    ticket_rows = await pool.fetch(
        f"""
        SELECT
            c.jira_key,
            t.title,
            t.status::text AS task_status,
            t.repo,
            COUNT(*) AS total_cycles,
            SUM(CASE WHEN c.work_type = 'new_ticket' THEN 1 ELSE 0 END) AS impl_cycles,
            SUM(CASE WHEN c.work_type = 'pr_review' THEN 1 ELSE 0 END) AS review_cycles,
            ROUND(SUM(c.cost_usd)::numeric, 2) AS total_cost,
            ROUND(EXTRACT(EPOCH FROM (MAX(c.timestamp) - MIN(c.timestamp)))/3600.0, 1) AS hours_span
        FROM cycles c
        LEFT JOIN tasks t ON t.jira_key = c.jira_key
        WHERE {date_filter} AND c.jira_key IS NOT NULL AND NOT c.no_work
        GROUP BY c.jira_key, t.title, t.status, t.repo
        ORDER BY total_cycles DESC
        LIMIT 30
        """,
        *date_params,
    )

    # Summary stats
    summary = await pool.fetchrow(
        f"""
        SELECT
            COUNT(*) AS total_cycles,
            COUNT(DISTINCT jira_key) FILTER (WHERE jira_key IS NOT NULL AND NOT no_work) AS unique_tickets,
            ROUND(SUM(cost_usd)::numeric, 2) AS total_cost,
            ROUND(AVG(cost_usd) FILTER (WHERE NOT no_work)::numeric, 2) AS avg_cost_per_work_cycle,
            ROUND(AVG(num_turns) FILTER (WHERE NOT no_work)::numeric, 1) AS avg_turns,
            ROUND(AVG(duration_ms) FILTER (WHERE NOT no_work)::numeric, 0) AS avg_duration_ms,
            COUNT(*) FILTER (WHERE no_work) AS idle_cycles,
            COUNT(*) FILTER (WHERE is_error) AS error_cycles,
            COUNT(*) FILTER (WHERE NOT no_work AND NOT is_error) AS work_cycles,
            COUNT(DISTINCT repo) FILTER (WHERE repo IS NOT NULL) AS repos_touched
        FROM cycles
        WHERE {date_filter}
        """,
        *date_params,
    )

    # Tickets resolved (archived) in period
    resolved = await pool.fetchval(
        """
        SELECT COUNT(*) FROM tasks
        WHERE status = 'archived'
        AND last_addressed >= NOW() - make_interval(days => $1)
        """,
        date_params[0] if isinstance(date_params[0], int) else 365,
    )

    # Avg review rounds per ticket
    avg_reviews = await pool.fetchrow(
        f"""
        SELECT
            ROUND(AVG(review_count)::numeric, 1) AS avg_review_rounds,
            COUNT(*) FILTER (WHERE review_count = 0) AS zero_review,
            COUNT(*) FILTER (WHERE review_count = 1) AS one_review,
            COUNT(*) FILTER (WHERE review_count > 1) AS multi_review
        FROM (
            SELECT jira_key, COUNT(*) FILTER (WHERE work_type = 'pr_review') AS review_count
            FROM cycles
            WHERE {date_filter} AND jira_key IS NOT NULL AND NOT no_work
            GROUP BY jira_key
        ) sub
        """,
        *date_params,
    )

    return JSONResponse(
        {
            "summary": {
                "total_cycles": summary["total_cycles"],
                "work_cycles": summary["work_cycles"],
                "idle_cycles": summary["idle_cycles"],
                "error_cycles": summary["error_cycles"],
                "unique_tickets": summary["unique_tickets"],
                "total_cost": float(summary["total_cost"] or 0),
                "avg_cost_per_work_cycle": float(
                    summary["avg_cost_per_work_cycle"] or 0
                ),
                "avg_turns": float(summary["avg_turns"] or 0),
                "avg_duration_ms": float(summary["avg_duration_ms"] or 0),
                "repos_touched": summary["repos_touched"],
                "tickets_resolved": resolved,
            },
            "work_types": [
                {
                    "category": r["category"],
                    "cycles": r["cycles"],
                    "total_cost": float(r["total_cost"]),
                    "avg_cost": float(r["avg_cost"]),
                    "avg_turns": float(r["avg_turns"]),
                    "avg_duration_ms": float(r["avg_duration_ms"]),
                }
                for r in work_type_rows
            ],
            "repos": [
                {
                    "repo": r["repo"],
                    "tickets": r["tickets"],
                    "cycles": r["cycles"],
                    "total_cost": float(r["total_cost"]),
                    "avg_turns": float(r["avg_turns"]),
                }
                for r in repo_rows
            ],
            "tickets": [
                {
                    "jira_key": r["jira_key"],
                    "title": r["title"],
                    "status": r["task_status"],
                    "repo": r["repo"],
                    "total_cycles": r["total_cycles"],
                    "impl_cycles": r["impl_cycles"],
                    "review_cycles": r["review_cycles"],
                    "total_cost": float(r["total_cost"]),
                    "hours_span": float(r["hours_span"] or 0),
                }
                for r in ticket_rows
            ],
            "feedback": {
                "avg_review_rounds": float(avg_reviews["avg_review_rounds"] or 0),
                "zero_review": avg_reviews["zero_review"],
                "one_review": avg_reviews["one_review"],
                "multi_review": avg_reviews["multi_review"],
            },
        }
    )


async def api_tags(request: Request) -> JSONResponse:
    pool = get_pool()
    rows = await pool.fetch(
        "SELECT DISTINCT unnest(tags) AS tag FROM memories ORDER BY tag"
    )
    return JSONResponse([r["tag"] for r in rows])


async def api_stats(request: Request) -> JSONResponse:
    pool = get_pool()
    tasks_by_status = await pool.fetch(
        "SELECT status::text, COUNT(*) as count FROM tasks GROUP BY status"
    )
    memory_count = await pool.fetchval("SELECT COUNT(*) FROM memories")
    memories_by_cat = await pool.fetch(
        "SELECT category, COUNT(*) as count FROM memories GROUP BY category"
    )
    memories_by_repo = await pool.fetch(
        "SELECT COALESCE(repo, 'unset') as repo, COUNT(*) as count FROM memories GROUP BY repo ORDER BY count DESC"
    )
    return JSONResponse(
        {
            "tasks": {r["status"]: r["count"] for r in tasks_by_status},
            "memories": {
                "total": memory_count,
                "by_category": {r["category"]: r["count"] for r in memories_by_cat},
                "by_repo": {r["repo"]: r["count"] for r in memories_by_repo},
            },
        }
    )


_CYCLE_RUN_LIST_COLUMNS = (
    "id, task_id, cycle_type, instance_id, started_at, finished_at, "
    "tool_calls, tokens_used, progress, created_at"
)


async def api_cycle_runs(request: Request) -> JSONResponse:
    """GET /api/cycle-runs — list cycle runs, filterable.
    POST /api/cycle-runs — store a new cycle run (with optional transcript)."""
    if request.method == "POST":
        return await api_cycle_runs_add(request)

    pool = get_pool()
    task_id = request.query_params.get("task_id")
    instance_id = request.query_params.get("instance_id")
    cycle_type = request.query_params.get("cycle_type")
    limit = int(request.query_params.get("limit", "50"))
    offset = int(request.query_params.get("offset", "0"))

    conditions, params, idx = [], [], 0
    if task_id:
        idx += 1
        conditions.append(f"task_id = ${idx}")
        params.append(int(task_id))
    if instance_id:
        idx += 1
        conditions.append(f"instance_id = ${idx}")
        params.append(instance_id)
    if cycle_type:
        idx += 1
        conditions.append(f"cycle_type = ${idx}")
        params.append(cycle_type)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    total = await pool.fetchval(f"SELECT COUNT(*) FROM cycle_runs {where}", *params)

    idx += 1
    params.append(limit)
    limit_idx = idx
    idx += 1
    params.append(offset)
    offset_idx = idx

    rows = await pool.fetch(
        f"""
        SELECT {_CYCLE_RUN_LIST_COLUMNS}
        FROM cycle_runs {where}
        ORDER BY created_at DESC
        LIMIT ${limit_idx} OFFSET ${offset_idx}
        """,
        *params,
    )

    return JSONResponse(
        {
            "items": [_cycle_run(r) for r in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    )


async def api_cycle_runs_add(request: Request) -> JSONResponse:
    """POST /api/cycle-runs — store a cycle run with optional base64 transcript."""
    pool = get_pool()
    body = await request.json()

    task_id = body.get("task_id")
    if task_id is not None:
        task_id = int(task_id) if task_id else None

    transcript_bytes = None
    transcript_b64 = body.get("transcript_b64")
    if transcript_b64:
        transcript_bytes = base64.b64decode(transcript_b64)

    started_at = body.get("started_at")
    finished_at = body.get("finished_at")
    parsed_started = datetime.fromisoformat(started_at) if started_at else None
    parsed_finished = datetime.fromisoformat(finished_at) if finished_at else None

    progress = body.get("progress")
    if isinstance(progress, str):
        progress = json.loads(progress)

    row = await pool.fetchrow(
        f"""
        INSERT INTO cycle_runs (task_id, cycle_type, instance_id, started_at, finished_at,
                                tool_calls, tokens_used, progress, transcript)
        VALUES ($1, $2, $3, COALESCE($4, NOW()), $5, $6, $7, $8, $9)
        RETURNING {_CYCLE_RUN_LIST_COLUMNS}
        """,
        task_id,
        body.get("cycle_type", "task_work"),
        body.get("instance_id"),
        parsed_started,
        parsed_finished,
        body.get("tool_calls"),
        body.get("tokens_used"),
        json.dumps(progress or {}),
        transcript_bytes,
    )
    result = _cycle_run(row)
    result["has_transcript"] = transcript_bytes is not None
    await bus.publish(
        Event(
            "cycle_run_added",
            {
                "id": result["id"],
                "task_id": result["task_id"],
                "cycle_type": result["cycle_type"],
                "instance_id": result["instance_id"],
            },
        )
    )
    return JSONResponse(result, status_code=201)


async def api_cycle_run_transcript(request: Request) -> Response:
    """GET /api/cycle-runs/{id}/transcript — return transcript, optionally decompressed."""
    pool = get_pool()
    run_id = request.path_params.get("id")
    if not run_id:
        return JSONResponse({"error": "missing cycle run id"}, status_code=400)

    row = await pool.fetchrow(
        "SELECT transcript FROM cycle_runs WHERE id = $1", int(run_id)
    )
    if not row:
        return JSONResponse({"error": f"Cycle run {run_id} not found"}, status_code=404)

    transcript = row["transcript"]
    if transcript is None:
        return JSONResponse(
            {"error": f"Cycle run {run_id} has no transcript"}, status_code=404
        )

    decompress = request.query_params.get("decompress", "").lower() in (
        "true",
        "1",
        "yes",
    )

    if decompress:
        try:
            import zstandard as zstd

            decompressor = zstd.ZstdDecompressor()
            decompressed = decompressor.decompress(transcript)
            return Response(
                content=decompressed,
                media_type="application/x-ndjson",
            )
        except Exception as e:
            return JSONResponse(
                {"error": f"Decompression failed: {e}"}, status_code=500
            )

    return Response(
        content=bytes(transcript),
        media_type="application/zstd",
    )


def _task(row, slack_notif=None) -> dict:
    result = {
        "id": row["id"],
        "jira_key": row["jira_key"],
        "status": row["status"],
        "repo": row["repo"],
        "branch": row["branch"],
        "pr_number": row["pr_number"],
        "pr_url": row["pr_url"],
        "title": row.get("title"),
        "summary": row.get("summary"),
        "created_at": row["created_at"].isoformat(),
        "last_addressed": row["last_addressed"].isoformat(),
        "paused_reason": row["paused_reason"],
        "instance_id": row.get("instance_id"),
        "metadata": json.loads(row["metadata"])
        if isinstance(row["metadata"], str)
        else (row["metadata"] or {}),
    }
    if slack_notif:
        result["slack_notification"] = slack_notif
    return result


def _cycle(row) -> dict:
    return {
        "id": row["id"],
        "timestamp": row["timestamp"].isoformat(),
        "label": row["label"],
        "session_id": row["session_id"],
        "num_turns": row["num_turns"],
        "duration_ms": row["duration_ms"],
        "cost_usd": float(row["cost_usd"]),
        "input_tokens": row["input_tokens"],
        "output_tokens": row["output_tokens"],
        "cache_read_tokens": row["cache_read_tokens"],
        "cache_write_tokens": row["cache_write_tokens"],
        "model": row["model"],
        "is_error": row["is_error"],
        "no_work": row["no_work"],
        "jira_key": row.get("jira_key"),
        "repo": row.get("repo"),
        "work_type": row.get("work_type"),
        "summary": row.get("summary"),
    }


def _memory(row) -> dict:
    return {
        "id": row["id"],
        "category": row["category"],
        "repo": row["repo"],
        "jira_key": row["jira_key"],
        "title": row["title"],
        "content": row["content"],
        "tags": list(row["tags"]) if row["tags"] else [],
        "created_at": row["created_at"].isoformat(),
        "metadata": json.loads(row["metadata"])
        if isinstance(row["metadata"], str)
        else (row["metadata"] or {}),
    }


def _cycle_run(row) -> dict:
    return {
        "id": row["id"],
        "task_id": row["task_id"],
        "cycle_type": row["cycle_type"],
        "instance_id": row["instance_id"],
        "started_at": row["started_at"].isoformat() if row["started_at"] else None,
        "finished_at": row["finished_at"].isoformat() if row["finished_at"] else None,
        "tool_calls": row["tool_calls"],
        "tokens_used": row["tokens_used"],
        "progress": json.loads(row["progress"])
        if isinstance(row["progress"], str)
        else (row["progress"] or {}),
        "created_at": row["created_at"].isoformat(),
    }
