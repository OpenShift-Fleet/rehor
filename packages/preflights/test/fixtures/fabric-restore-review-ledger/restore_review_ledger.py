#!/usr/bin/env python3
"""Restore one tracked review ledger inside the runner, without remote writes."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

from persist_pending_publication import resolve_memory_tools
from public_comment_safety import ensure_public_content
from resolve_review_threads import bot_login
from review_ledger import (
    SHA_RE,
    EmptyPendingReview,
    LedgerPayloadMissing,
    decode_body,
    restore_from_review,
    write_cycle_ledger,
)


class RestoreError(ValueError):
    """A restoration blocker safe to report without including remote input."""


def task_metadata(task_key: str, review_id: int) -> dict:
    instance_id = os.environ.get("BOT_INSTANCE_ID")
    if not instance_id:
        raise RestoreError("BOT_INSTANCE_ID is required")
    memory_call, memory_cleanup = resolve_memory_tools()
    try:
        task = memory_call("task_get", {"external_key": task_key, "source_type": "github"})
    finally:
        memory_cleanup()
    if (not isinstance(task, dict) or task.get("external_key") != task_key
            or task.get("source_type") != "github" or task.get("instance_id") != instance_id
            or task.get("status") not in ("in_progress", "pr_open", "pr_changes", "done")):
        raise RestoreError("Selected review task is unavailable, inactive, or owned by another instance")
    metadata = task.get("metadata")
    if isinstance(metadata, str):
        metadata = json.loads(metadata)
    if (not isinstance(metadata, dict) or type(metadata.get("review_id")) is not int
            or metadata["review_id"] != review_id):
        raise RestoreError("Task's tracked review ID does not match preflight")
    return metadata


def require_current_revision(repo: str, pr: int, head: str, base: str) -> None:
    result = subprocess.run(
        ["gh", "api", f"repos/{repo}/pulls/{pr}"],
        capture_output=True, text=True, timeout=30, check=False,
    )
    if result.returncode:
        raise RestoreError("Could not read the selected GitHub PR")
    state = json.loads(result.stdout)
    if (not isinstance(state, dict) or state.get("state") != "open"
            or not isinstance(state.get("head"), dict) or state["head"].get("sha") != head
            or not isinstance(state.get("base"), dict) or state["base"].get("sha") != base):
        raise RestoreError("Selected PR is no longer open at the pinned head and base")


def pending_payload(metadata: dict, repo: str, pr: int, head: str, base: str) -> dict:
    pending = metadata.get("pending_publication")
    if (not isinstance(pending, dict) or pending.get("repo") != repo
            or type(pending.get("pr")) is not int or pending["pr"] != pr
            or pending.get("head_sha") != head or pending.get("base_sha") != base
            or pending.get("operation") not in ("review", "verify")):
        raise RestoreError("No matching pending publication for the selected revision")
    body = pending.get("publication_body")
    publication = pending.get("publication_json")
    if not isinstance(body, str) or not isinstance(publication, dict) or publication.get("body") != body:
        raise RestoreError("Pending publication is missing its exact prepared body")
    payload = decode_body(body, repo, pr)
    ensure_public_content(body, "Pending status review")
    if (payload["head_sha"] != head or payload["base_sha"] != base
            or type(pending.get("update_count")) is not int
            or pending["update_count"] != payload["update_count"]):
        raise RestoreError("Pending publication ledger does not match its revision or count")
    return payload


def restore(repo: str, pr: int, head: str, base: str, review_id: int,
            task_key: str, use_pending: bool = False) -> dict:
    if (not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo)
            or any(part in (".", "..") for part in repo.split("/"))
            or pr < 1 or review_id < 1 or not SHA_RE.fullmatch(head) or not SHA_RE.fullmatch(base)
            or task_key != f"review-only:github:{repo}#{pr}"):
        raise RestoreError("Invalid repository, PR, revision, task key, or review ID")
    metadata = task_metadata(task_key, review_id)
    require_current_revision(repo, pr, head, base)
    try:
        payload = restore_from_review(repo, pr, review_id, bot_login(), head)
    except LedgerPayloadMissing as exc:
        # A retry can use the saved body only if the tracked review is safe.
        if not use_pending or (isinstance(exc, EmptyPendingReview) and not exc.reusable):
            raise RestoreError("Tracked review has no usable ledger; stop without starting a fresh review") from exc
    if use_pending:
        payload = pending_payload(metadata, repo, pr, head, base)
    # A submitted ledger may describe an earlier pair. Its own revision marker
    # is validated by restore_from_review; only the live PR and pending body
    # must match the current work item's pair.
    require_current_revision(repo, pr, head, base)
    path = write_cycle_ledger(repo, pr, head, base, payload["findings"])
    return {
        "ledger_path": str(Path(path).resolve()),
        "source": "pending" if use_pending else "review",
        "update_count": payload["update_count"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--pr", required=True, type=int)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--review-id", required=True, type=int)
    parser.add_argument("--task-key", required=True)
    parser.add_argument("--pending", action="store_true", help="Restore only for an existing publication retry")
    args = parser.parse_args()
    try:
        result = restore(args.repo, args.pr, args.head_sha, args.base_sha,
                         args.review_id, args.task_key, args.pending)
    except RestoreError as exc:
        parser.exit(1, f"Ledger restoration blocked: {exc}\n")
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired, AttributeError, TypeError):
        # Existing GitHub helpers can include remote output in error messages.
        # Do not send that output (or the fetched body) to the caller.
        parser.exit(1, "Ledger restoration blocked: could not validate the tracked ledger inputs\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
