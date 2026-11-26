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
one. ``expected_id`` is the atomic generation guard: it is checked against the
locked row before any mutation, so a stale id can never touch a recreated
record. For full protection pass both ``expected_id`` and ``expected_revision``
from your last read; ``expected_revision`` alone guards the record's data
version, not its identity across delete/recreate. Classic CRUD keeps no
history, so this is guarded rather than prevented with tombstones.

Number semantics: JSON numbers travel the MCP transport as Python values —
integers keep arbitrary precision, but floats are IEEE 754 doubles. The
transport-level envelope guard (``mcp_validation_sanitizer.McpEnvelopeGuard``)
rejects ``task_document_create``/``task_document_update`` calls whose ``data``
contains float tokens that would not survive the double conversion unchanged
(``1e400``, ``1e-400``, beyond-double-precision decimals like
``9007199254740993.0``) with a sanitized error, so no silent numeric
corruption occurs. Accepted numbers are value-exact within these limits;
send precision-sensitive values as strings.
"""

import json
from typing import Any

import asyncpg
from fastmcp import FastMCP

from ..db import get_pool

MAX_NAME_LENGTH = 200

# Any valid JSON document: object, array, string, number, boolean or null.
DocumentData = dict[str, Any] | list[Any] | str | int | float | bool | None

_COLUMNS = "id, name, data, revision, created_at, updated_at"
# Update/delete pre-checks need identity and revision only — fetching the full
# JSONB payload just to compare a revision would read large documents for nothing.
_META_COLUMNS = "id, name, revision, created_at, updated_at"


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


def _reject_invalid_strings(value: Any) -> None:
    """Reject decoded string values (and object keys) PostgreSQL jsonb cannot store.

    PostgreSQL jsonb refuses NUL (U+0000) and unpaired UTF-16 surrogates, and
    its native error echoes the offending payload — so reject them here first.
    Validation runs on the decoded Python values, never on serialized JSON
    text: a literal backslash-u sequence (e.g. the six characters ``\\u0000``)
    is ordinary text and must pass. Astral characters are single code points
    in Python, so any char in the surrogate range is unpaired by definition.
    """
    if isinstance(value, str):
        if "\x00" in value:
            raise ValueError("document data contains a NUL character (U+0000), which cannot be stored")
        if any("\ud800" <= ch <= "\udfff" for ch in value):
            raise ValueError("document data contains an unpaired Unicode surrogate, which cannot be stored")
    elif isinstance(value, dict):
        for key, item in value.items():
            _reject_invalid_strings(key)
            _reject_invalid_strings(item)
    elif isinstance(value, list):
        for item in value:
            _reject_invalid_strings(item)


def _dump_data(data: DocumentData) -> str:
    """Serialize document data to JSON text, rejecting values PostgreSQL cannot store.

    allow_nan=False rejects float NaN/Infinity; _reject_invalid_strings rejects
    NUL characters and unpaired surrogates in any string value or key.
    """
    _reject_invalid_strings(data)
    try:
        return json.dumps(data, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"document data must be valid JSON ({exc})") from exc


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


def _validate_expected(value: int | None, param: str) -> int | None:
    if value is not None and value < 1:
        raise ValueError(f"{param} must be a positive integer")
    return value


def _check_expected(
    row, name: str, external_key: str, source_type: str, expected_revision: int | None, expected_id: int | None
) -> None:
    """Atomically guard a locked document row before any mutation.

    ``expected_id`` is the generation guard: a recreated record (delete +
    recreate of the same name) gets a new id, so a stale id can never mutate
    it even when the revision matches. ``expected_revision`` guards the data
    version. Errors never echo document content.
    """
    if expected_id is not None and row["id"] != expected_id:
        raise ValueError(
            f"Document conflict on task document '{name}' for task {external_key} "
            f"(source_type={source_type}): expected id {expected_id}, current id is {row['id']} "
            "(the document was deleted and recreated); re-read with task_document_get and retry"
        )
    if expected_revision is not None and row["revision"] != expected_revision:
        raise ValueError(
            f"Revision conflict on task document '{name}' for task {external_key} "
            f"(source_type={source_type}): expected revision {expected_revision}, "
            f"current revision is {row['revision']}; re-read with task_document_get and retry"
        )


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


async def _locked_document(conn, task_id: int, name: str, external_key: str, source_type: str):
    """Lock the document row for mutation; metadata only, the full JSONB
    payload is read by the mutating statement's RETURNING clause."""
    row = await conn.fetchrow(
        f"SELECT {_META_COLUMNS} FROM task_documents WHERE task_id = $1 AND name = $2 FOR UPDATE",
        task_id,
        name,
    )
    if not row:
        raise _document_not_found(name, external_key, source_type)
    return row


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
            Integers are exact (arbitrary precision); floats must be exactly representable
            as IEEE 754 doubles — others (1e400, 1e-400, beyond-double-precision decimals)
            are rejected at the transport boundary. Send precision-sensitive values as strings.
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
        expected_id: int | None = None,
    ) -> dict:
        """Replace a task document's data wholesale (no merge). Revision increments on every update.
        Omit expected_revision/expected_id for plain last-writer-wins update; pass both from your
        last read to fail instead of silently overwriting a concurrent writer's change.
        expected_revision guards the data version; expected_id guards the record generation —
        delete + recreate of the same name starts a new record (new id, revision restarts at 1),
        which expected_revision alone cannot detect but expected_id rejects atomically.
        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345').
        name: Document name.
        data: Arbitrary valid JSON replacing the previous content.
            Integers exact; floats must be exactly representable IEEE 754 doubles (others
            rejected at the transport boundary); send precision-sensitive values as strings.
        source_type: Source system — 'jira', 'github', 'gitlab', 'manual'. Defaults to 'jira'.
        expected_revision: Optional revision you last read; update fails on mismatch.
        expected_id: Optional record id you last read; update fails if the record was recreated.
        Never store credentials, tokens or secrets in documents."""
        expected_id = _validate_expected(expected_id, "expected_id")
        expected_revision = _validate_expected(expected_revision, "expected_revision")
        name = _validate_name(name)
        _validate_identity(external_key, source_type)
        payload = _dump_data(data)
        pool = get_pool()
        async with pool.acquire() as conn, conn.transaction():
            task_id = await _lock_task(conn, external_key, source_type)
            row = await _locked_document(conn, task_id, name, external_key, source_type)
            _check_expected(row, name, external_key, source_type, expected_revision, expected_id)
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
        expected_id: int | None = None,
    ) -> dict:
        """Explicitly delete a task document. Not performed automatically on archival.
        Omit expected_revision/expected_id for plain delete; pass both from your last read to fail
        instead of deleting data changed by a concurrent writer.
        expected_revision guards the data version; expected_id guards the record generation —
        delete + recreate of the same name starts a new record (new id, revision restarts at 1),
        which expected_revision alone cannot detect but expected_id rejects atomically.
        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345').
        name: Document name.
        source_type: Source system — 'jira', 'github', 'gitlab', 'manual'. Defaults to 'jira'.
        expected_revision: Optional revision you last read; delete fails on mismatch.
        expected_id: Optional record id you last read; delete fails if the record was recreated."""
        expected_id = _validate_expected(expected_id, "expected_id")
        expected_revision = _validate_expected(expected_revision, "expected_revision")
        name = _validate_name(name)
        _validate_identity(external_key, source_type)
        pool = get_pool()
        async with pool.acquire() as conn, conn.transaction():
            task_id = await _lock_task(conn, external_key, source_type)
            row = await _locked_document(conn, task_id, name, external_key, source_type)
            _check_expected(row, name, external_key, source_type, expected_revision, expected_id)
            deleted = await conn.fetchrow(
                "DELETE FROM task_documents WHERE task_id = $1 AND name = $2 "
                "RETURNING id, name, revision, created_at, updated_at",
                task_id,
                name,
            )
        result = _row_to_document(deleted, include_data=False)
        result.update({"external_key": external_key, "source_type": source_type, "deleted": True})
        return result
