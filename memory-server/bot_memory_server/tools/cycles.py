"""MCP tools for cycle progress storage and retrieval."""

import json
from datetime import datetime
from typing import Optional

from fastmcp import FastMCP

from ..db import get_pool
from ..events import Event, bus
from ..models import CycleRun


def _row_to_cycle_run(row) -> dict:
    run = CycleRun(
        id=row["id"],
        task_id=row["task_id"],
        cycle_type=row["cycle_type"],
        instance_id=row["instance_id"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
        tool_calls=row["tool_calls"],
        tokens_used=row["tokens_used"],
        progress=json.loads(row["progress"]) if isinstance(row["progress"], str) else (row["progress"] or {}),
        created_at=row["created_at"],
    )
    return run.model_dump(mode="json")


_CYCLE_RUN_COLUMNS = (
    "id, task_id, cycle_type, instance_id, started_at, finished_at, tool_calls, tokens_used, progress, created_at"
)


def register_cycle_tools(mcp: FastMCP):
    @mcp.tool()
    async def progress_store(
        instance_id: str,
        task_id: Optional[int] = None,
        external_key: Optional[str] = None,
        source_type: Optional[str] = None,
        cycle_type: str = "task_work",
        progress: Optional[dict] = None,
        started_at: Optional[str] = None,
        finished_at: Optional[str] = None,
        tool_calls: Optional[int] = None,
        tokens_used: Optional[int] = None,
    ) -> dict:
        """Store a structured progress summary for the current cycle.
        Called by the bot before a cycle ends to persist what happened.
        task_id: The DB task ID (from task_add/task_get result). Use 0 or omit for idle/error cycles.
        external_key: Jira key or external identifier. If provided without task_id, resolves the task automatically.
        source_type: Source type for external_key lookup (default 'jira').
        instance_id: Bot instance name.
        cycle_type: One of 'task_work', 'triage_only', 'idle', 'error'.
        progress: Structured JSON with keys like last_step, next_step, files_changed,
            commits, key_decisions, blockers, notes.
        started_at/finished_at: ISO timestamps. If omitted, started_at defaults to NOW().
        tool_calls: Number of tool calls in this cycle.
        tokens_used: Total tokens consumed."""
        pool = get_pool()

        if isinstance(progress, str):
            progress = json.loads(progress)

        resolved_task_id = task_id if task_id and task_id > 0 else None

        if not resolved_task_id and external_key:
            row = await pool.fetchrow(
                "SELECT id FROM tasks WHERE external_key = $1 AND source_type = $2",
                external_key,
                source_type or "jira",
            )
            if row:
                resolved_task_id = row["id"]

        parsed_started = datetime.fromisoformat(started_at) if started_at else None
        parsed_finished = datetime.fromisoformat(finished_at) if finished_at else None

        row = await pool.fetchrow(
            f"""
            INSERT INTO cycle_runs (task_id, cycle_type, instance_id, started_at, finished_at,
                                    tool_calls, tokens_used, progress)
            VALUES ($1, $2, $3, COALESCE($4, NOW()), $5, $6, $7, $8)
            RETURNING {_CYCLE_RUN_COLUMNS}
            """,
            resolved_task_id,
            cycle_type,
            instance_id,
            parsed_started,
            parsed_finished,
            tool_calls,
            tokens_used,
            json.dumps(progress or {}),
        )
        result = _row_to_cycle_run(row)
        await bus.publish(
            Event(
                "cycle_run_added",
                {
                    "id": result["id"],
                    "task_id": result["task_id"],
                    "cycle_type": cycle_type,
                    "instance_id": instance_id,
                },
            )
        )
        return result

    @mcp.tool()
    async def progress_load(
        task_id: int,
        instance_id: Optional[str] = None,
        limit: int = 5,
    ) -> list[dict]:
        """Load recent progress entries for a task across cycles.
        Returns the last N cycle progress summaries, most recent first.
        Use this at cycle start to understand what happened in prior cycles.
        task_id: The DB task ID.
        instance_id: Optional filter to a specific bot instance.
        limit: Max entries to return (default 5)."""
        pool = get_pool()

        conditions = ["task_id = $1"]
        params: list = [task_id]
        idx = 1

        if instance_id:
            idx += 1
            conditions.append(f"instance_id = ${idx}")
            params.append(instance_id)

        idx += 1
        params.append(min(limit, 50))

        where = " AND ".join(conditions)
        rows = await pool.fetch(
            f"""
            SELECT {_CYCLE_RUN_COLUMNS}
            FROM cycle_runs
            WHERE {where}
            ORDER BY created_at DESC
            LIMIT ${idx}
            """,
            *params,
        )
        return [_row_to_cycle_run(r) for r in rows]
