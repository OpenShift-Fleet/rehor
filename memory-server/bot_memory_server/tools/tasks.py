import json
from datetime import datetime
from typing import Optional

from fastmcp import FastMCP

from ..artifacts import JIRA_BASE_URL, build_artifacts
from ..db import get_pool
from ..events import Event, bus
from ..models import Task

ACTIVE_STATUSES = ("in_progress", "pr_open", "pr_changes")
MAX_ACTIVE = 10


def _row_to_task(row) -> dict:
    raw_artifacts = row.get("artifacts")
    if isinstance(raw_artifacts, str):
        artifacts = json.loads(raw_artifacts)
    elif raw_artifacts is not None:
        artifacts = raw_artifacts
    else:
        artifacts = []

    task = Task(
        id=row["id"],
        external_key=row["external_key"],
        source_type=row["source_type"],
        source_url=row.get("source_url"),
        artifacts=artifacts,
        status=row["status"],
        repo=row["repo"],
        branch=row["branch"],
        title=row.get("title"),
        summary=row.get("summary"),
        created_at=row["created_at"],
        last_addressed=row["last_addressed"],
        paused_reason=row["paused_reason"],
        instance_id=row.get("instance_id"),
        metadata=json.loads(row["metadata"]) if isinstance(row["metadata"], str) else (row["metadata"] or {}),
    )
    return task.model_dump(mode="json")


def register_task_tools(mcp: FastMCP):
    @mcp.tool()
    async def task_list(
        status: Optional[str] = None,
        include_archived: bool = False,
        instance_id: Optional[str] = None,
    ) -> list[dict]:
        """List tasks, optionally filtered by status and instance_id. Archived tasks are excluded by default.
        instance_id: Filter to tasks owned by this bot instance. Omit to see all."""
        pool = get_pool()
        conditions = []
        params = []
        idx = 0

        if status:
            idx += 1
            conditions.append(f"status = ${idx}::task_status")
            params.append(status)
        elif not include_archived:
            conditions.append("status != 'archived'::task_status")

        if instance_id:
            idx += 1
            conditions.append(f"(instance_id = ${idx} OR instance_id IS NULL)")
            params.append(instance_id)

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        rows = await pool.fetch(
            f"SELECT * FROM tasks {where} ORDER BY created_at",
            *params,
        )
        return [_row_to_task(r) for r in rows]

    @mcp.tool()
    async def task_get(
        external_key: str,
        source_type: str = "jira",
    ) -> dict | None:
        """Get a single task by external_key + source_type.
        external_key: The external identifier (e.g. Jira key like 'RHCLOUD-12345', GitHub issue URL, etc.)."""
        pool = get_pool()
        row = await pool.fetchrow(
            "SELECT * FROM tasks WHERE external_key = $1 AND source_type = $2",
            external_key,
            source_type,
        )
        return _row_to_task(row) if row else None

    @mcp.tool()
    async def task_add(
        external_key: str,
        repo: str,
        branch: str,
        status: str = "in_progress",
        source_type: str = "jira",
        title: Optional[str] = None,
        summary: Optional[str] = None,
        metadata: Optional[dict] = None,
        instance_id: Optional[str] = None,
    ) -> dict:
        """Add a new task. Fails if >= 10 active tasks exist for this instance.
        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345', GitHub issue URL, etc.).
        source_type: Source system — 'jira', 'github', 'gitlab', 'manual'. Defaults to 'jira'.
        title: Ticket title. summary: short description of what the bot is doing/did.
        metadata: structured progress data (e.g. last_step, files_changed).
        instance_id: Bot instance name — used for multi-instance isolation.
        For multi-repo tickets, include repos list and prs array in metadata:
        {"repos": ["repo1", "repo2"], "prs": [{"repo": "repo1", "number": 42, "url": "...", "host": "github"}]}"""
        pool = get_pool()

        if isinstance(metadata, str):
            metadata = json.loads(metadata)

        if instance_id:
            count = await pool.fetchval(
                "SELECT COUNT(*) FROM tasks WHERE status = ANY($1) AND (instance_id = $2 OR instance_id IS NULL)",
                list(ACTIVE_STATUSES),
                instance_id,
            )
        else:
            count = await pool.fetchval(
                "SELECT COUNT(*) FROM tasks WHERE status = ANY($1)",
                list(ACTIVE_STATUSES),
            )
        if count >= MAX_ACTIVE:
            raise ValueError(
                f"Cannot add task: {count} active tasks (max {MAX_ACTIVE}). Complete or pause existing tasks first."
            )

        if isinstance(metadata, str):
            metadata = json.loads(metadata)
        meta_dict = metadata or {}
        artifacts = build_artifacts(meta_dict)
        source_url = f"{JIRA_BASE_URL}/{external_key}" if JIRA_BASE_URL and source_type == "jira" else None
        row = await pool.fetchrow(
            """
            INSERT INTO tasks (external_key, source_type, source_url, artifacts,
                               status, repo, branch, title, summary, instance_id, metadata)
            VALUES ($1, $2, $3, $4, $5::task_status, $6, $7, $8, $9, $10, $11)
            RETURNING *
            """,
            external_key,
            source_type,
            source_url,
            json.dumps(artifacts),
            status,
            repo,
            branch,
            title,
            summary,
            instance_id,
            json.dumps(meta_dict),
        )
        result = _row_to_task(row)
        await bus.publish(
            Event(
                "task_added",
                {
                    "external_key": external_key,
                    "title": title,
                    "status": status,
                    "instance_id": instance_id,
                },
            )
        )
        return result

    @mcp.tool()
    async def task_update(
        external_key: str,
        source_type: str = "jira",
        status: Optional[str] = None,
        last_addressed: Optional[str] = None,
        paused_reason: Optional[str] = None,
        title: Optional[str] = None,
        summary: Optional[str] = None,
        metadata: Optional[dict] = None,
    ) -> dict:
        """Update fields on an existing task. Lookup by external_key + source_type.
        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345').
        summary: human-readable description of current state/what was done.
        metadata: structured progress data (e.g. last_step, files_changed, commits, repos, prs).
            Merged with existing metadata.
        For multi-repo tickets, use metadata.prs to track all PRs/MRs:
        {"prs": [{"repo": "repo1", "number": 42, "url": "...", "host": "github"}]}"""
        pool = get_pool()

        sets = []
        params = []
        idx = 1

        if status is not None:
            idx += 1
            sets.append(f"status = ${idx}::task_status")
            params.append(status)
        if last_addressed is not None:
            idx += 1
            sets.append(f"last_addressed = ${idx}")
            params.append(datetime.fromisoformat(last_addressed))
        if paused_reason is not None:
            idx += 1
            sets.append(f"paused_reason = ${idx}")
            params.append(paused_reason)
        if title is not None:
            idx += 1
            sets.append(f"title = ${idx}")
            params.append(title)
        if summary is not None:
            idx += 1
            sets.append(f"summary = ${idx}")
            params.append(summary)
        if metadata is not None:
            if isinstance(metadata, str):
                metadata = json.loads(metadata)
            idx += 1
            sets.append(f"metadata = metadata || ${idx}::jsonb")
            params.append(json.dumps(metadata))

        if metadata is not None and "prs" in (metadata or {}):
            current = await pool.fetchrow(
                "SELECT metadata FROM tasks WHERE external_key = $1 AND source_type = $2",
                external_key,
                source_type,
            )
            if current:
                cur_meta = current["metadata"]
                if isinstance(cur_meta, str):
                    cur_meta = json.loads(cur_meta)
                cur_meta = cur_meta or {}
                if metadata is not None:
                    cur_meta.update(metadata)
                new_artifacts = build_artifacts(cur_meta)
                idx += 1
                sets.append(f"artifacts = ${idx}")
                params.append(json.dumps(new_artifacts))

        if not sets:
            raise ValueError("No fields to update")

        query = f"UPDATE tasks SET {', '.join(sets)} WHERE external_key = $1 AND source_type = ${idx + 1} RETURNING *"
        row = await pool.fetchrow(query, external_key, *params, source_type)
        if not row:
            raise ValueError(f"Task {external_key} not found")
        result = _row_to_task(row)
        await bus.publish(
            Event(
                "task_updated",
                {
                    "external_key": external_key,
                    "status": result["status"],
                    "summary": result.get("summary"),
                },
            )
        )
        return result

    @mcp.tool()
    async def task_remove(
        external_key: str,
        source_type: str = "jira",
    ) -> dict:
        """Archive a completed task (preserves full history). Lookup by external_key + source_type.
        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345')."""
        pool = get_pool()
        row = await pool.fetchrow(
            "UPDATE tasks SET status = 'archived'::task_status "
            "WHERE external_key = $1 AND source_type = $2 RETURNING *",
            external_key,
            source_type,
        )
        if not row:
            raise ValueError(f"Task {external_key} not found")
        result = _row_to_task(row)
        await bus.publish(Event("task_archived", {"external_key": external_key}))
        return result

    @mcp.tool()
    async def task_check_capacity(instance_id: Optional[str] = None) -> dict:
        """Check if the bot can take on new work.
        instance_id: Scope capacity check to this instance."""
        pool = get_pool()
        if instance_id:
            count = await pool.fetchval(
                "SELECT COUNT(*) FROM tasks WHERE status = ANY($1) AND (instance_id = $2 OR instance_id IS NULL)",
                list(ACTIVE_STATUSES),
                instance_id,
            )
        else:
            count = await pool.fetchval(
                "SELECT COUNT(*) FROM tasks WHERE status = ANY($1)",
                list(ACTIVE_STATUSES),
            )
        return {
            "active": count,
            "max": MAX_ACTIVE,
            "has_capacity": count < MAX_ACTIVE,
        }

    @mcp.tool()
    async def bot_status_update(
        state: str,
        message: str,
        external_key: Optional[str] = None,
        repo: Optional[str] = None,
        instance_id: Optional[str] = None,
    ) -> dict:
        """Update the bot's current activity status. Call this at the start and end of each cycle,
        and when switching between tasks.
        state: 'working', 'idle', 'error'.
        message: Human-readable description of what the bot is doing right now.
        external_key: The ticket/task being worked on (e.g. Jira key 'RHCLOUD-12345').
        repo: The repo being worked in (if any).
        instance_id: Bot instance name for multi-instance setups."""
        pool = get_pool()
        source_type = "jira" if external_key else None
        row = await pool.fetchrow(
            """
            UPDATE bot_status SET state = $1, message = $2, external_key = $3, source_type = $4,
                repo = $5, instance_id = COALESCE($6, instance_id),
                cycle_start = CASE WHEN state = 'idle' AND $1 = 'working' THEN NOW() ELSE cycle_start END,
                updated_at = NOW()
            WHERE id = 1 RETURNING *
            """,
            state,
            message,
            external_key,
            source_type,
            repo,
            instance_id,
        )
        if instance_id:
            await pool.execute(
                """
                INSERT INTO bot_instances (instance_id, state, message, external_key, source_type, repo,
                                           cycle_start, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6,
                    CASE WHEN $2 = 'working' THEN NOW() ELSE NULL END,
                    NOW())
                ON CONFLICT (instance_id) DO UPDATE SET
                    state = $2, message = $3, external_key = $4, source_type = $5, repo = $6,
                    cycle_start = CASE
                        WHEN bot_instances.state = 'idle' AND $2 = 'working' THEN NOW()
                        ELSE bot_instances.cycle_start
                    END,
                    updated_at = NOW()
                """,
                instance_id,
                state,
                message,
                external_key,
                source_type,
                repo,
            )
        result = {
            "state": row["state"],
            "message": row["message"],
            "external_key": row["external_key"],
            "repo": row["repo"],
            "instance_id": row.get("instance_id") or instance_id,
            "cycle_start": row["cycle_start"].isoformat() if row["cycle_start"] else None,
            "updated_at": row["updated_at"].isoformat(),
        }
        await bus.publish(Event("bot_status", result))
        return result
