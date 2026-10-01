import json
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Literal

from fastmcp import FastMCP

from ..artifacts import JIRA_BASE_URL, build_artifacts
from ..db import get_pool
from ..events import Event, bus
from ..models import OutcomeArtifact, OutcomeEvidence, Task
from ..task_outcomes import _outcome_from_row, record_task_outcome

ACTIVE_STATUSES = ("in_progress", "pr_open", "pr_changes")
MAX_ACTIVE = 10
_OUTCOME_ARCHIVE_GUIDANCE = (
    "Call task_outcome_report first for the same task with artifacts, evidence items "
    "(source, reference, resolution: accepted|rejected|unknown, disposition, reason), and notes; "
    "then retry task_remove. Do not provide a final task decision."
)


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


def _merge_task_artifacts(reported: list[dict], stored) -> list[dict]:
    if isinstance(stored, str):
        stored = json.loads(stored)
    combined = list(reported)
    seen_urls = {item.get("url") for item in combined if item.get("url")}
    for item in stored or []:
        if item.get("url") and item["url"] not in seen_urls:
            combined.append(item)
            seen_urls.add(item["url"])
    return combined


async def _report_task_outcome(
    *,
    external_key: str,
    source_type: str,
    artifacts: Sequence[OutcomeArtifact],
    evidence: Sequence[OutcomeEvidence],
    notes: str | None,
    verified_at: datetime | None,
    run_id: str | None,
    reporting_cycle_id: int | None,
    attempt: int | None,
    workflow: str | None,
    reported_by: str,
    correction: bool,
) -> tuple[dict, dict]:
    pool = get_pool()
    async with pool.acquire() as conn, conn.transaction():
        existing = await conn.fetchrow(
            "SELECT * FROM tasks WHERE external_key = $1 AND source_type = $2 FOR UPDATE",
            external_key,
            source_type,
        )
        if not existing:
            raise ValueError(f"Task {external_key} not found")

        is_archived = existing["status"] == "archived"
        if correction and not is_archived:
            raise ValueError(f"Task {external_key} is not archived; correction requires an archived task")
        if not correction and is_archived and reported_by != "migration":
            raise ValueError(f"Task {external_key} is archived; set correction=true to append a correction")

        artifact_records = [
            OutcomeArtifact.model_validate(item).model_dump(by_alias=True, exclude_none=True) for item in artifacts
        ]
        evidence_records = [
            OutcomeEvidence.model_validate(item).model_dump(by_alias=True, exclude_none=True) for item in evidence
        ]
        combined_artifacts = _merge_task_artifacts(artifact_records, existing.get("artifacts"))
        outcome = await record_task_outcome(
            conn,
            task_id=existing["id"],
            task_reference=external_key,
            task_repo=existing.get("repo"),
            artifacts=combined_artifacts,
            evidence=evidence_records,
            notes=notes,
            verified_at=verified_at,
            run_id=run_id,
            reporting_cycle_id=reporting_cycle_id,
            attempt=attempt,
            workflow=workflow,
            instance_id=existing.get("instance_id"),
            reported_by=reported_by,
        )
        task_row = await conn.fetchrow(
            "UPDATE tasks SET outcome_report_id = $1 WHERE id = $2 RETURNING *",
            outcome["id"],
            existing["id"],
        )
    result = _row_to_task(task_row)
    result["outcome"] = outcome
    return result, outcome


def register_task_tools(mcp: FastMCP):
    @mcp.tool()
    async def task_list(
        status: str | None = None,
        include_archived: bool = False,
        instance_id: str | None = None,
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
        title: str | None = None,
        summary: str | None = None,
        metadata: dict | None = None,
        instance_id: str | None = None,
    ) -> dict:
        """Add a new task. Fails if >= 10 active tasks exist for this instance.
        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345', GitHub issue URL, etc.).
        source_type: Source system — 'jira', 'github', 'gitlab', 'manual'. Defaults to 'jira'.
        title: Ticket title. summary: short description of what the bot is doing/did.
        metadata: structured progress data (e.g. last_step, files_changed).
        instance_id: Bot instance name — used for multi-instance isolation.
        For multi-repo tickets, include repos list and prs array in metadata:
        {"repos": ["repo1", "repo2"], "prs": [{"repo": "repo1", "number": 42, "url": "...", "host": "github"}]}
        For related work items, include related_items:
        {"related_items": [{"name": "Related item", "url": "https://example.test/item/1", "type": "related"}]}"""
        if status == "archived":
            raise ValueError(
                "Cannot create a task as archived. Create it with a non-archived status first; "
                f"{_OUTCOME_ARCHIVE_GUIDANCE}"
            )
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
        status: str | None = None,
        last_addressed: str | None = None,
        paused_reason: str | None = None,
        title: str | None = None,
        summary: str | None = None,
        metadata: dict | None = None,
    ) -> dict:
        """Update fields on an existing task. Lookup by external_key + source_type.
        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345').
        summary: human-readable description of current state/what was done.
        metadata: structured progress data (e.g. last_step, files_changed, commits, repos, prs).
            Merged with existing metadata.
        For multi-repo tickets, use metadata.prs to track all PRs/MRs:
        {"prs": [{"repo": "repo1", "number": 42, "url": "...", "host": "github"}]}
        For related work items, use metadata.related_items:
        {"related_items": [{"name": "Related item", "url": "https://example.test/item/1", "type": "related"}]}"""
        if status == "archived":
            raise ValueError(f"Cannot set status='archived' directly. {_OUTCOME_ARCHIVE_GUIDANCE}")
        pool = get_pool()

        sets = []
        params = []
        idx = 1

        if status is not None:
            idx += 1
            sets.append(f"status = ${idx}::task_status")
            params.append(status)
            if last_addressed is None:
                sets.append("last_addressed = NOW()")
            sets.append(
                "outcome_report_id = CASE WHEN status = 'archived'::task_status THEN NULL ELSE outcome_report_id END"
            )
            sets.append("archived_at = CASE WHEN status = 'archived'::task_status THEN NULL ELSE archived_at END")
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

        if metadata is not None and any(key in metadata for key in ("prs", "related_items")):
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
    async def task_outcome_report(
        external_key: str,
        artifacts: list[OutcomeArtifact],
        evidence: list[OutcomeEvidence],
        notes: str | None,
        source_type: str = "jira",
        verified_at: str | None = None,
        run_id: str | None = None,
        reporting_cycle_id: int | None = None,
        attempt: int | None = None,
        workflow: str | None = None,
        reported_by: Literal["agent", "workflow", "migration"] = "agent",
        correction: bool = False,
    ) -> dict:
        """Record evidence before archival; reports are append-only.
        Set correction=true to append a corrected report to an already archived task.
        Each evidence item uses the same fields: source, reference, resolution
        (accepted/rejected/unknown), disposition, reason, optional authorType. LLM fills resolution/reason
        from source evidence; do not send a final task decision. Human/workflow comments are authoritative;
        agent/automation comments are ignored.
        A staged report does not archive the task; call task_remove afterward. Manual dashboard archive
        remains unreported.
        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345')."""
        try:
            parsed_verified_at = datetime.fromisoformat(verified_at.replace("Z", "+00:00")) if verified_at else None
        except ValueError as exc:
            raise ValueError("verified_at must be an ISO 8601 timestamp") from exc
        if parsed_verified_at and parsed_verified_at.tzinfo is None:
            parsed_verified_at = parsed_verified_at.replace(tzinfo=UTC)

        result, outcome = await _report_task_outcome(
            external_key=external_key,
            source_type=source_type,
            artifacts=artifacts,
            evidence=evidence,
            notes=notes,
            verified_at=parsed_verified_at,
            run_id=run_id,
            reporting_cycle_id=reporting_cycle_id,
            attempt=attempt,
            workflow=workflow,
            reported_by=reported_by,
            correction=correction,
        )
        event_type = "task_outcome_corrected" if correction else "task_outcome_reported"
        await bus.publish(
            Event(
                event_type,
                {
                    "external_key": external_key,
                    "report_id": outcome["id"],
                    "state": outcome["decision"],
                },
            )
        )
        return result

    @mcp.tool()
    async def task_remove(external_key: str, source_type: str = "jira") -> dict:
        """Archive a task only after task_outcome_report has staged its required outcome.
        Repeated archive attempts fail; set correction=true on task_outcome_report to correct.
        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345')."""
        pool = get_pool()
        async with pool.acquire() as conn, conn.transaction():
            task = await conn.fetchrow(
                "SELECT id, status, outcome_report_id FROM tasks "
                "WHERE external_key = $1 AND source_type = $2 FOR UPDATE",
                external_key,
                source_type,
            )
            if not task:
                raise ValueError(f"Task {external_key} not found")
            if task["status"] == "archived":
                raise ValueError(f"Task {external_key} is already archived")
            if task["outcome_report_id"] is None:
                raise ValueError(
                    f"Task {external_key} requires task_outcome_report before archival. {_OUTCOME_ARCHIVE_GUIDANCE}"
                )

            report = await conn.fetchrow(
                "SELECT * FROM task_outcome_reports WHERE id = $1 AND task_id = $2",
                task["outcome_report_id"],
                task["id"],
            )
            if not report:
                raise ValueError(f"Task {external_key} has an invalid staged outcome report")
            row = await conn.fetchrow(
                "UPDATE tasks SET status = 'archived'::task_status, archived_at = NOW() WHERE id = $1 RETURNING *",
                task["id"],
            )

        result = _row_to_task(row)
        result["outcome"] = _outcome_from_row(report)
        await bus.publish(
            Event(
                "task_archived",
                {
                    "external_key": external_key,
                    "decision": report["decision"],
                    "confidence": report["confidence"],
                },
            )
        )
        return result

    @mcp.tool()
    async def task_check_capacity(instance_id: str | None = None) -> dict:
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
        external_key: str | None = None,
        repo: str | None = None,
        instance_id: str | None = None,
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
