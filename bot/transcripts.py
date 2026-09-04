"""Transcript capture — compresses and stores cycle transcripts via the dashboard API."""

from __future__ import annotations

import base64
import logging
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

import httpx

from .constants import MEMORY_API_BASE
from .metrics import TRANSCRIPT_UPLOAD_TOTAL

if TYPE_CHECKING:
    from .agent import CycleContext

logger = logging.getLogger(__name__)


def _get_cycle_runs_url() -> str:
    explicit = os.environ.get("CYCLE_RUNS_API_URL")
    if explicit:
        return explicit
    costs_url = os.environ.get("COSTS_API_URL", "")
    if costs_url:
        return costs_url.rsplit("/costs", 1)[0] + "/cycle-runs"
    return f"{MEMORY_API_BASE}/cycle-runs"


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
    input_prompt: str | None = None,
) -> None:
    """Compress and store the cycle transcript + metadata to the dashboard API.

    Only called after an agent session ran. Missing transcripts are alertable —
    preflight skip/error use post_orphan_cycle and must not hit this path.
    """
    session_id = getattr(result, "session_id", "")
    if not session_id:
        logger.warning("No session_id in result — session cycle missing transcript")
        TRANSCRIPT_UPLOAD_TOTAL.labels(label, "missing").inc()
        return

    usage = getattr(result, "usage", None) or {}
    is_error = getattr(result, "subtype", "") != "success"
    cycle_type = _resolve_cycle_type(ctx.work_type if ctx else None, is_error)

    duration_ms = getattr(result, "duration_ms", None) or 0
    now = datetime.now(UTC)
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
        "input_prompt": input_prompt,
        "progress": {
            "jira_key": ctx.jira_key if ctx else None,
            "repo": ctx.repo if ctx else None,
            "work_type": ctx.work_type if ctx else None,
            "summary": ctx.summary if ctx else None,
        },
    }

    has_transcript = False
    outcome = None
    transcript_path = _find_transcript(session_id, cwd)
    if transcript_path:
        try:
            import zstandard as zstd

            raw = transcript_path.read_bytes()
            compressor = zstd.ZstdCompressor(level=19)
            compressed = compressor.compress(raw)
            body["transcript_b64"] = base64.b64encode(compressed).decode()
            has_transcript = True
            logger.info(
                "Transcript: %d bytes → %d compressed (%.0f%% savings)",
                len(raw),
                len(compressed),
                (1 - len(compressed) / len(raw)) * 100 if raw else 0,
            )
        except ImportError:
            logger.warning("zstandard not installed — storing cycle run without transcript")
            outcome = "compress_error"
        except Exception:
            logger.warning("Failed to read/compress transcript", exc_info=True)
            outcome = "compress_error"
    else:
        logger.warning("Transcript file not found for session %s", session_id)
        outcome = "missing"

    try:
        url = _get_cycle_runs_url()
        resp = httpx.post(url, json=body, timeout=10.0)
        logger.info("Cycle run stored: id=%s status=%s", resp.json().get("id"), resp.status_code)
        if outcome is None:
            outcome = "ok" if has_transcript else "missing"
    except Exception:
        logger.warning("Failed to push cycle run to %s", _get_cycle_runs_url(), exc_info=True)
        outcome = "push_error"

    TRANSCRIPT_UPLOAD_TOTAL.labels(label, outcome).inc()


def post_orphan_cycle(
    instance_id: str,
    cycle_type: str,
    content: str,
    task_id: int | None = None,
    input_prompt: str | None = None,
) -> None:
    """Post a cycle run to the dashboard without a Claude session (preflight skip/error)."""
    now = datetime.now(UTC)
    body: dict = {
        "task_id": task_id,
        "cycle_type": cycle_type,
        "instance_id": instance_id,
        "started_at": now.isoformat(),
        "finished_at": now.isoformat(),
        "tool_calls": 0,
        "tokens_used": 0,
        "input_prompt": input_prompt,
        "progress": {
            "summary": content[:2000] if content else None,
            "work_type": cycle_type,
        },
    }
    try:
        url = _get_cycle_runs_url()
        resp = httpx.post(url, json=body, timeout=10.0)
        logger.info("Orphan cycle posted: id=%s type=%s", resp.json().get("id"), cycle_type)
    except Exception:
        logger.warning("Failed to post orphan cycle to %s", _get_cycle_runs_url(), exc_info=True)
