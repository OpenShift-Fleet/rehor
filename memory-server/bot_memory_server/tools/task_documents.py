"""Durable task-owned document tools.

Classic CRUD over the ``task_documents`` table: arbitrary JSONB documents
attached to a task by ``external_key`` + ``source_type`` (the same identity
convention as the task tools). Named documents are distinct from the legacy
``tasks.artifacts`` array of PR/MR display links and from outcome-report
evidence. Documents persist through task archival and are never expired or
deleted automatically; removal is an explicit ``task_document_delete`` call.

Document content is returned only by the explicit read/write tools — never by
``task_list``/``task_get`` and never logged. All clients share the Bot Memory
trust boundary (the X-Bot-Instance-Id header is not verified authentication).

Concurrency: without ``expected_revision`` an update or delete is an atomic
last-writer-wins operation. Passing ``expected_revision`` (the value a previous
read returned) turns it into an optimistic check: the operation fails with the
current revision instead of silently replacing a concurrent writer's change.
Concurrent creates of the same (task, name) fail with a duplicate error; the
UNIQUE(task_id, name) constraint enforces this even under race.

Known ABA limitation: deleting a document and recreating the same name starts
a fresh record — new server-issued ``id``, ``revision`` restarts at 1. A stale
``expected_revision`` from the deleted record can therefore match the recreated
one. ``expected_revision`` guards the record, not the name; when delete/recreate
is in play, compare the record ``id`` (returned by every response) as well.
Classic CRUD keeps no history, so this is documented rather than prevented.
"""

import json
import re
from typing import Any

import asyncpg
from fastmcp import FastMCP

from ..db import get_pool

MAX_NAME_LENGTH = 200

# Any valid JSON document: object, array, string, number, boolean or null.
DocumentData = dict[str, Any] | list[Any] | str | int | float | bool | None

# PostgreSQL jsonb rejects NUL (U+0000) and unpaired UTF-16 surrogate escapes.
# json.dumps escapes them as literal \uXXXX sequences in the serialized text, so
# scan that text: strip valid surrogate pairs first, then any remaining
# \ud8xx-\udfxx escape is unpaired. Errors never echo the rejected data.
_NUL_ESCAPE = "\\u0000"
_SURROGATE_PAIR_RE = re.compile(r"\\ud[89ab][0-9a-f]{2}\\ud[c-f][0-9a-f]{2}")
_SURROGATE_RE = re.compile(r"\\ud[89a-f][0-9a-f]{2}")

_COLUMNS = "id, name, data, revision, created_at, updated_at"


def _validate_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise ValueError("name must not be empty")
    if len(name) > MAX_NAME_LENGTH:
        raise ValueError(f"name must be at most {MAX_NAME_LENGTH} characters")
    return name


def _validate_identity(external_key: str, source_type: str) -> None:
    if not external_key.strip():
        raise ValueError("external_key must not be empty")
    if not source_type.strip():
        raise ValueError("source_type must not be empty")


def _dump_data(data: DocumentData) -> str:
    """Serialize document data to JSON text, rejecting values PostgreSQL cannot store.

    allow_nan=False rejects float NaN/Infinity. NUL characters and unpaired
    Unicode surrogates are rejected before any database access — PostgreSQL
    jsonb refuses them and its native error would echo the payload.
    """
    try:
        payload = json.dumps(data, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"document data must be valid JSON ({exc})") from exc
    if _NUL_ESCAPE in payload:
        raise ValueError("document data contains a NUL character (U+0000), which cannot be stored")
    if _SURROGATE_RE.search(_SURROGATE_PAIR_RE.sub("", payload)):
        raise ValueError("document data contains an unpaired Unicode surrogate, which cannot be stored")
    return payload


def _load_data(value) -> Any:
    return json.loads(value) if isinstance(value, str) else value


def _row_to_document(row, *, include_data: bool) -> dict:
    record = {
        "id": row["id"],
        "name": row["name"],
        "revision": row["revision"],
        "created_at": row["created_at"].isoformat(),
        "updated_at": row["updated_at"].isoformat(),
    }
    if include_data:
        record["data"] = _load_data(row["data"])
    return record


def _task_not_found(external_key: str, source_type: str) -> ValueError:
    return ValueError(f"Task {external_key} not found (source_type={source_type})")


def _document_not_found(name: str, external_key: str, source_type: str) -> ValueError:
    return ValueError(f"Task document '{name}' not found for task {external_key} (source_type={source_type})")


async def _lock_task(conn, external_key: str, source_type: str) -> int:
    """Lock the task row so document writes serialize with archival flows."""
    row = await conn.fetchrow(
        "SELECT id FROM tasks WHERE external_key = $1 AND source_type = $2 FOR UPDATE",
        external_key,
        source_type,
    )
    if not row:
        raise _task_not_found(external_key, source_type)
    return row["id"]


def register_task_document_tools(mcp: FastMCP):
    @mcp.tool()
    async def task_document_create(
        external_key: str,
        name: str,
        data: DocumentData,
        source_type: str = "jira",
    ) -> dict:
        """Store a durable JSON document on a task. Persists through archival; never auto-expired.
        Fails if a document with the same name already exists — use task_document_update to change it.
        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345').
        name: Document name, unique per task (max 200 chars).
        data: Arbitrary valid JSON — object, array, string, number, boolean or null.
        source_type: Source system — 'jira', 'github', 'gitlab', 'manual'. Defaults to 'jira'.
        Never store credentials, tokens or secrets in documents."""
        name = _validate_name(name)
        _validate_identity(external_key, source_type)
        payload = _dump_data(data)
        pool = get_pool()
        try:
            async with pool.acquire() as conn, conn.transaction():
                task_id = await _lock_task(conn, external_key, source_type)
                row = await conn.fetchrow(
                    f"INSERT INTO task_documents (task_id, name, data) VALUES ($1, $2, $3::jsonb) RETURNING {_COLUMNS}",
                    task_id,
                    name,
                    payload,
                )
        except asyncpg.UniqueViolationError as exc:
            raise ValueError(
                f"Task document '{name}' already exists for task {external_key} (source_type={source_type}); "
                "use task_document_update to replace its data"
            ) from exc
        result = _row_to_document(row, include_data=True)
        result.update({"external_key": external_key, "source_type": source_type})
        return result

    @mcp.tool()
    async def task_document_get(
        external_key: str,
        name: str,
        source_type: str = "jira",
    ) -> dict:
        """Read one task document, including its full data content.
        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345').
        name: Document name.
        source_type: Source system — 'jira', 'github', 'gitlab', 'manual'. Defaults to 'jira'."""
        name = _validate_name(name)
        _validate_identity(external_key, source_type)
        pool = get_pool()
        row = await pool.fetchrow(
            f"SELECT {_COLUMNS} FROM task_documents WHERE task_id = "
            "(SELECT id FROM tasks WHERE external_key = $1 AND source_type = $2) AND name = $3",
            external_key,
            source_type,
            name,
        )
        if not row:
            # Distinguish a missing task from a missing document.
            task = await pool.fetchrow(
                "SELECT id FROM tasks WHERE external_key = $1 AND source_type = $2",
                external_key,
                source_type,
            )
            if not task:
                raise _task_not_found(external_key, source_type)
            raise _document_not_found(name, external_key, source_type)
        result = _row_to_document(row, include_data=True)
        result.update({"external_key": external_key, "source_type": source_type})
        return result

    @mcp.tool()
    async def task_document_list(
        external_key: str,
        source_type: str = "jira",
    ) -> list[dict]:
        """List document names and metadata for a task — no data content. Use task_document_get to read one.
        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345').
        source_type: Source system — 'jira', 'github', 'gitlab', 'manual'. Defaults to 'jira'."""
        _validate_identity(external_key, source_type)
        pool = get_pool()
        task = await pool.fetchrow(
            "SELECT id FROM tasks WHERE external_key = $1 AND source_type = $2",
            external_key,
            source_type,
        )
        if not task:
            raise _task_not_found(external_key, source_type)
        rows = await pool.fetch(
            "SELECT id, name, revision, created_at, updated_at FROM task_documents WHERE task_id = $1 ORDER BY name",
            task["id"],
        )
        return [_row_to_document(row, include_data=False) for row in rows]

    @mcp.tool()
    async def task_document_update(
        external_key: str,
        name: str,
        data: DocumentData,
        source_type: str = "jira",
        expected_revision: int | None = None,
    ) -> dict:
        """Replace a task document's data wholesale (no merge). Revision increments on every update.
        Omit expected_revision for plain last-writer-wins update; pass the revision from your last
        read to fail instead of silently overwriting a concurrent writer's change.
        expected_revision guards the record, not the name: delete + recreate of the same name starts
        a new record (new id, revision restarts at 1), so a stale expected_revision can match it —
        compare the returned record id as well when delete/recreate is in play.
        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345').
        name: Document name.
        data: Arbitrary valid JSON replacing the previous content.
        source_type: Source system — 'jira', 'github', 'gitlab', 'manual'. Defaults to 'jira'.
        expected_revision: Optional revision you last read; update fails on mismatch.
        Never store credentials, tokens or secrets in documents."""
        if expected_revision is not None and expected_revision < 1:
            raise ValueError("expected_revision must be a positive integer")
        name = _validate_name(name)
        _validate_identity(external_key, source_type)
        payload = _dump_data(data)
        pool = get_pool()
        async with pool.acquire() as conn, conn.transaction():
            task_id = await _lock_task(conn, external_key, source_type)
            row = await conn.fetchrow(
                f"SELECT {_COLUMNS} FROM task_documents WHERE task_id = $1 AND name = $2 FOR UPDATE",
                task_id,
                name,
            )
            if not row:
                raise _document_not_found(name, external_key, source_type)
            if expected_revision is not None and row["revision"] != expected_revision:
                raise ValueError(
                    f"Revision conflict on task document '{name}' for task {external_key} "
                    f"(source_type={source_type}): expected revision {expected_revision}, "
                    f"current revision is {row['revision']}; re-read with task_document_get and retry"
                )
            updated = await conn.fetchrow(
                f"UPDATE task_documents SET data = $3::jsonb, revision = revision + 1, updated_at = NOW() "
                f"WHERE task_id = $1 AND name = $2 RETURNING {_COLUMNS}",
                task_id,
                name,
                payload,
            )
        result = _row_to_document(updated, include_data=True)
        result.update({"external_key": external_key, "source_type": source_type})
        return result

    @mcp.tool()
    async def task_document_delete(
        external_key: str,
        name: str,
        source_type: str = "jira",
        expected_revision: int | None = None,
    ) -> dict:
        """Explicitly delete a task document. Not performed automatically on archival.
        Omit expected_revision for plain delete; pass the revision from your last read to fail
        instead of deleting data changed by a concurrent writer.
        expected_revision guards the record, not the name: delete + recreate of the same name starts
        a new record (new id, revision restarts at 1), so a stale expected_revision can match it —
        compare the returned record id as well when delete/recreate is in play.
        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345').
        name: Document name.
        source_type: Source system — 'jira', 'github', 'gitlab', 'manual'. Defaults to 'jira'.
        expected_revision: Optional revision you last read; delete fails on mismatch."""
        if expected_revision is not None and expected_revision < 1:
            raise ValueError("expected_revision must be a positive integer")
        name = _validate_name(name)
        _validate_identity(external_key, source_type)
        pool = get_pool()
        async with pool.acquire() as conn, conn.transaction():
            task_id = await _lock_task(conn, external_key, source_type)
            row = await conn.fetchrow(
                "SELECT id, name, revision, created_at, updated_at FROM task_documents "
                "WHERE task_id = $1 AND name = $2 FOR UPDATE",
                task_id,
                name,
            )
            if not row:
                raise _document_not_found(name, external_key, source_type)
            if expected_revision is not None and row["revision"] != expected_revision:
                raise ValueError(
                    f"Revision conflict on task document '{name}' for task {external_key} "
                    f"(source_type={source_type}): expected revision {expected_revision}, "
                    f"current revision is {row['revision']}; re-read with task_document_get and retry"
                )
            deleted = await conn.fetchrow(
                "DELETE FROM task_documents WHERE task_id = $1 AND name = $2 "
                "RETURNING id, name, revision, created_at, updated_at",
                task_id,
                name,
            )
        result = _row_to_document(deleted, include_data=False)
        result.update({"external_key": external_key, "source_type": source_type, "deleted": True})
        return result
