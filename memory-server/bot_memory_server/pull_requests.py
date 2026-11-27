"""Internal, atomic PR/MR label snapshots; no remote source-system calls."""

import json
import os
import re
import secrets
from typing import Annotated, Literal
from urllib.parse import unquote, urlsplit

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, ValidationError, field_validator
from starlette.requests import Request
from starlette.responses import JSONResponse

from .db import get_pool

Text = Annotated[str, Field(min_length=1, max_length=500)]


class PullRequestSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    external_key: Text
    source_type: Text
    host: Literal["github", "gitlab"]
    repository: Text
    number: Annotated[int, Field(gt=0, le=2147483647)]
    url: HttpUrl
    labels: Annotated[list[Annotated[str, Field(min_length=1, max_length=500)]], Field(max_length=100)]
    title: Annotated[str, Field(max_length=2000)] | None = None
    state: Annotated[str, Field(max_length=50)] | None = None
    is_draft: bool | None = None

    @field_validator("repository")
    @classmethod
    def canonical_repository(cls, value):
        if len(value.split("/")) < 2 or any(part in ("", ".", "..") for part in value.split("/")):
            raise ValueError("repository must be an owner/project path")
        return value

    @field_validator("url")
    @classmethod
    def no_url_credentials(cls, value):
        if value.username or value.password:
            raise ValueError("URL must not contain credentials")
        return value


async def api_pull_request_snapshot(request: Request) -> JSONResponse:
    # Reuse the existing memory upload shared-secret boundary. Fail closed when
    # absent, and never accept browser-originated writes or expose the secret.
    secret = os.environ.get("UPLOAD_MEMORY_PASSWORD", "")
    if not secret:
        return JSONResponse({"error": "snapshot ingestion disabled"}, status_code=404)
    authorization = request.headers.get("authorization", "")
    if (
        request.headers.get("origin") is not None
        or request.headers.get("sec-fetch-site") is not None
        or not secrets.compare_digest(authorization.encode(), f"Bearer {secret}".encode())
    ):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 65536:
            return JSONResponse({"error": "snapshot exceeds 64 KiB"}, status_code=413)
    try:
        snapshot = PullRequestSnapshot.model_validate_json(bytes(body))
    except ValidationError:
        return JSONResponse({"error": "invalid PR/MR snapshot"}, status_code=400)

    async with get_pool().acquire() as conn, conn.transaction():
        # SHARE conflicts with metadata updates: validation and parent/label
        # writes cannot race a reference removal and resurrect stale labels.
        task = await conn.fetchrow(
            "SELECT id, task_references_pr(metadata, artifacts, $3, $4, $5, $6, source_url) AS referenced "
            "FROM tasks WHERE external_key = $1 AND source_type = $2 FOR SHARE",
            snapshot.external_key,
            snapshot.source_type,
            snapshot.host,
            snapshot.repository,
            snapshot.number,
            str(snapshot.url),
        )
        if task is None:
            return JSONResponse({"error": "task not found"}, status_code=404)
        if not task["referenced"]:
            return JSONResponse({"error": "PR/MR is not referenced by task"}, status_code=409)
        task_id = task["id"]
        # The upsert locks the parent row until label replacement commits. A PR
        # already attached to another task must never be silently reassigned.
        pr_id = await conn.fetchval(
            """
            INSERT INTO pull_requests (task_id, host, repository, number, url, title, state, is_draft)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (host, repository, number) DO UPDATE
            SET url = EXCLUDED.url, title = EXCLUDED.title, state = EXCLUDED.state,
                is_draft = EXCLUDED.is_draft, updated_at = NOW()
            WHERE pull_requests.task_id = EXCLUDED.task_id
            RETURNING id
            """,
            task_id,
            snapshot.host,
            snapshot.repository,
            snapshot.number,
            str(snapshot.url),
            snapshot.title,
            snapshot.state,
            snapshot.is_draft,
        )
        if pr_id is None:
            return JSONResponse({"error": "PR/MR is associated with another task"}, status_code=409)
        await conn.execute("DELETE FROM pull_request_labels WHERE pull_request_id = $1", pr_id)
        if snapshot.labels:
            await conn.executemany(
                "INSERT INTO pull_request_labels (pull_request_id, label) VALUES ($1, $2)",
                [(pr_id, label) for label in sorted(set(snapshot.labels))],
            )
    return JSONResponse({"updated": True})


async def seed_pull_requests(conn):
    """Seed identities from resolvable metadata/artifact URLs, without inventing labels.

    Replaying startup never replaces collected snapshots. Bare repository aliases
    without URLs are left for the existing preflight repository resolver.
    """
    rows = await conn.fetch(
        """SELECT id, metadata, artifacts FROM tasks
        WHERE jsonb_typeof(metadata->'prs') = 'array'
           OR jsonb_typeof(metadata->'mrs') = 'array'
           OR jsonb_array_length(CASE WHEN jsonb_typeof(artifacts) = 'array' THEN artifacts ELSE '[]'::jsonb END) > 0
        ORDER BY id"""
    )
    records = []
    for row in rows:
        metadata = json.loads(row["metadata"]) if isinstance(row["metadata"], str) else row["metadata"]
        artifacts = json.loads(row["artifacts"]) if isinstance(row["artifacts"], str) else row["artifacts"]
        candidates = list(artifacts) if isinstance(artifacts, list) else []
        if isinstance(metadata, dict):
            for key in ("prs", "mrs"):
                if isinstance(metadata.get(key), list):
                    candidates.extend(metadata[key])
        for candidate in candidates:
            if not isinstance(candidate, dict) or not isinstance(candidate.get("url"), str):
                continue
            try:
                url = urlsplit(candidate["url"])
                if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
                    continue
                path = unquote(url.path)
                # Self-hosted GitLab need not have "gitlab" in its hostname.
                host = "gitlab"
                match = re.match(r"^/(.+?)/(?:-/)?merge_requests/(\d+)/?$", path)
                if not match:
                    host = "github"
                    match = re.match(r"^/([^/]+/[^/]+)/pull/(\d+)/?$", path)
                if not match:
                    continue
                number = int(match[2])
                if not 0 < number <= 2147483647:
                    continue
            except ValueError:
                continue
            records.append((row["id"], host, match[1], number, candidate["url"]))
    if records:
        await conn.executemany(
            """INSERT INTO pull_requests (task_id, host, repository, number, url)
               VALUES ($1, $2, $3, $4, $5) ON CONFLICT (host, repository, number) DO NOTHING""",
            records,
        )
