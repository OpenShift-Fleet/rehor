"""Cost tracking — writes cycle cost data to costs.jsonl and the dashboard API."""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

import httpx

from .constants import MEMORY_API_BASE
from .metrics import record_cycle_metrics

if TYPE_CHECKING:
    from .agent import CycleContext

logger = logging.getLogger(__name__)

COSTS_API = os.environ.get("COSTS_API_URL", f"{MEMORY_API_BASE}/costs")


_NO_WORK_PATTERNS = [
    "NO_WORK_FOUND",
    "no work found",
    "no work available",
    "nothing to do",
    "nothing to pick up",
    "no tickets",
    "no unassigned",
    "no assigned tickets",
    "0 unassigned",
]


def _is_no_work(text: str) -> bool:
    lower = text.lower()
    return any(p.lower() in lower for p in _NO_WORK_PATTERNS)


def summarize_result(result) -> dict:
    """Extract model, token, and cache fields from an SDK ResultMessage.

    Ratio is cache_read / cache_write when write > 0, else ``n/a``.
    Does not log; callers decide what to print. JSONL/API entries should not
    include ``cache_ratio`` (logging-only).
    """
    usage = getattr(result, "usage", None) or {}
    model = ""
    model_usage = getattr(result, "model_usage", None)
    if model_usage and isinstance(model_usage, dict):
        model = next(iter(model_usage.keys()), "")

    cache_read = int(usage.get("cache_read_input_tokens", 0) or 0)
    cache_write = int(usage.get("cache_creation_input_tokens", 0) or 0)
    ratio = f"{cache_read / cache_write:.2f}" if cache_write else "n/a"

    return {
        "model": model,
        "model_usage": model_usage if model_usage else {},
        "input_tokens": int(usage.get("input_tokens", 0) or 0),
        "output_tokens": int(usage.get("output_tokens", 0) or 0),
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "cache_ratio": ratio,
    }


def _build_entry(label: str, result, ctx: CycleContext | None = None) -> dict:
    """Build a cost entry dict from an SDK ResultMessage."""
    summary = summarize_result(result)
    result_text = getattr(result, "result", "") or ""

    entry = {
        "timestamp": datetime.now(UTC).isoformat(),
        "label": label,
        "session_id": getattr(result, "session_id", ""),
        "num_turns": getattr(result, "num_turns", 0),
        "duration_ms": getattr(result, "duration_ms", 0),
        "cost_usd": getattr(result, "total_cost_usd", 0) or 0,
        "input_tokens": summary["input_tokens"],
        "output_tokens": summary["output_tokens"],
        "cache_read_tokens": summary["cache_read_tokens"],
        "cache_write_tokens": summary["cache_write_tokens"],
        "model": summary["model"],
        "model_usage": summary["model_usage"],
        "is_error": getattr(result, "subtype", "") != "success",
        "no_work": _is_no_work(result_text),
    }

    if ctx:
        entry["external_key"] = ctx.jira_key
        entry["repo"] = ctx.repo
        entry["work_type"] = ctx.work_type
        entry["summary"] = ctx.summary

    return entry


def record_cost(
    costs_file: Path,
    label: str,
    result,
    ctx: CycleContext | None = None,
    instance_id: str | None = None,
    workflow: str = "unknown",
) -> bool:
    """Record cost data from a ResultMessage.

    Writes to costs.jsonl (local), pushes to the dashboard API, and increments
    agent Prometheus cost/token counters.
    Returns True if the cycle found no work (for sleep interval decision).
    """
    entry = _build_entry(label, result, ctx)
    if instance_id:
        entry["instance_id"] = instance_id

    if entry["is_error"]:
        status = "error"
    elif entry["no_work"]:
        status = "idle"
    else:
        status = "ok"
    record_cycle_metrics(
        model=entry["model"],
        label=label,
        workflow=workflow,
        status=status,
        cost_usd=entry["cost_usd"],
        input_tokens=entry["input_tokens"],
        output_tokens=entry["output_tokens"],
        cache_read_tokens=entry["cache_read_tokens"],
        cache_write_tokens=entry["cache_write_tokens"],
    )

    # Write to local jsonl (backward compat with costs.sh)
    with open(costs_file, "a") as f:
        f.write(json.dumps(entry) + "\n")

    # Push to dashboard API
    try:
        resp = httpx.post(COSTS_API, json=entry, timeout=3.0)
        if not resp.is_success:
            logger.warning(
                "Cost push failed: HTTP %d: %s",
                resp.status_code,
                resp.text[:200],
            )
    except httpx.TimeoutException:
        logger.warning("Cost push timed out after 3s")
    except Exception as e:
        logger.warning("Cost push failed: %s", e)

    return entry["no_work"]
