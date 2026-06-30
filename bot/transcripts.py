"""Transcript capture — compresses and stores cycle transcripts via the dashboard API."""

from __future__ import annotations

import base64
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from .agent import CycleContext

logger = logging.getLogger(__name__)


def _get_cycle_runs_url() -> str:
    explicit = os.environ.get("CYCLE_RUNS_API_URL")
    if explicit:
        return explicit
    costs_url = os.environ.get("COSTS_API_URL", "http://localhost:8080/api/costs")
    return costs_url.rsplit("/", 1)[0] + "/cycle-runs"


CYCLE_RUNS_API = _get_cycle_runs_url()

_WORK_TYPE_TO_CYCLE_TYPE = {
    "new_ticket": "task_work",
    "pr_review": "task_work",
    "ci_fix": "task_work",
    "idle": "idle",
    "memory_housekeeping": "idle",
    "error": "error",
}


def _resolve_cycle_type(work_type: str | None, is_error: bool) -> str:
    if is_error:
        return "error"
    if work_type:
        return _WORK_TYPE_TO_CYCLE_TYPE.get(work_type, "task_work")
    return "triage_only"


def _find_transcript(session_id: str, cwd: str) -> Path | None:
    """Locate the Claude session transcript JSONL file."""
    slug = cwd.replace("/", "-")
    if not slug.startswith("-"):
        slug = "-" + slug
    home = Path.home()
    path = home / ".claude" / "projects" / slug / f"{session_id}.jsonl"
    if path.exists():
        return path
    # Fallback: scan project dirs for the session file
    projects_dir = home / ".claude" / "projects"
    if projects_dir.is_dir():
        for candidate in projects_dir.iterdir():
            f = candidate / f"{session_id}.jsonl"
            if f.exists():
                return f
    return None


def record_transcript(
    label: str,
    result,
    ctx: CycleContext | None = None,
    cwd: str = "",
    instance_id: str | None = None,
) -> None:
    """Compress and store the cycle transcript + metadata to the dashboard API."""
    session_id = getattr(result, "session_id", "")
    if not session_id:
        logger.debug("No session_id in result — skipping transcript capture")
        return

    usage = getattr(result, "usage", None) or {}
    is_error = getattr(result, "subtype", "") != "success"
    cycle_type = _resolve_cycle_type(ctx.work_type if ctx else None, is_error)

    duration_ms = getattr(result, "duration_ms", None) or 0
    now = datetime.now(timezone.utc)
    started_at = now
    if duration_ms:
        started_at = now - timedelta(milliseconds=duration_ms)

    body: dict = {
        "task_id": ctx.task_id if ctx else None,
        "cycle_type": cycle_type,
        "instance_id": instance_id or label,
        "started_at": started_at.isoformat(),
        "finished_at": now.isoformat(),
        "tool_calls": getattr(result, "num_turns", 0),
        "tokens_used": usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
        "progress": {
            "jira_key": ctx.jira_key if ctx else None,
            "repo": ctx.repo if ctx else None,
            "work_type": ctx.work_type if ctx else None,
            "summary": ctx.summary if ctx else None,
        },
    }

    transcript_path = _find_transcript(session_id, cwd)
    if transcript_path:
        try:
            import zstandard as zstd

            raw = transcript_path.read_bytes()
            compressor = zstd.ZstdCompressor(level=19)
            compressed = compressor.compress(raw)
            body["transcript_b64"] = base64.b64encode(compressed).decode()
            logger.info(
                "Transcript: %d bytes → %d compressed (%.0f%% savings)",
                len(raw),
                len(compressed),
                (1 - len(compressed) / len(raw)) * 100 if raw else 0,
            )
        except ImportError:
            logger.warning("zstandard not installed — storing cycle run without transcript")
        except Exception:
            logger.warning("Failed to read/compress transcript", exc_info=True)
    else:
        logger.debug("Transcript file not found for session %s", session_id)

    try:
        resp = httpx.post(CYCLE_RUNS_API, json=body, timeout=10.0)
        logger.info("Cycle run stored: id=%s status=%s", resp.json().get("id"), resp.status_code)
    except Exception:
        logger.warning("Failed to push cycle run to %s", CYCLE_RUNS_API, exc_info=True)


def post_orphan_cycle(
    instance_id: str,
    cycle_type: str,
    content: str,
    task_id: int | None = None,
) -> None:
    """Post a cycle run to the dashboard without a Claude session (preflight skip/error)."""
    now = datetime.now(timezone.utc)
    body: dict = {
        "task_id": task_id,
        "cycle_type": cycle_type,
        "instance_id": instance_id,
        "started_at": now.isoformat(),
        "finished_at": now.isoformat(),
        "tool_calls": 0,
        "tokens_used": 0,
        "progress": {
            "summary": content[:2000] if content else None,
            "work_type": cycle_type,
        },
    }
    try:
        resp = httpx.post(CYCLE_RUNS_API, json=body, timeout=10.0)
        logger.info("Orphan cycle posted: id=%s type=%s", resp.json().get("id"), cycle_type)
    except Exception:
        logger.warning("Failed to post orphan cycle to %s", CYCLE_RUNS_API, exc_info=True)
