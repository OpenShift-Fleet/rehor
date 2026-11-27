#!/usr/bin/env python3
"""Persist prepared review publication state through Bot Memory MCP."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

from post_review import load_comment_links, resolve_finding_links
from review_ledger import decode_body


SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def load_json(path: Path, description: str) -> object:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Could not read {description}: {exc}") from exc


def resolve_memory_tools():
    home = os.environ.get("HOME")
    if home:
        sys.path.insert(0, str(Path(home) / "app"))
    try:
        from bot.memory_mcp import memory_call, memory_cleanup
    except ImportError as exc:
        raise RuntimeError(f"Bot Memory MCP client is unavailable: {exc}") from exc
    return memory_call, memory_cleanup


def persist(task_key: str, publication_path: Path, pending_state_path: Path,
            comment_links_path: Path | None = None) -> dict:
    publication = load_json(publication_path, "prepared publication")
    state = load_json(pending_state_path, "pending publication state")
    if not isinstance(publication, dict) or not isinstance(publication.get("body"), str):
        raise ValueError("Prepared publication must contain a body string")
    if not isinstance(state, dict):
        raise ValueError("Pending publication state must be a JSON object")
    if "publication_body" in state or "publication_json" in state:
        raise ValueError("Pending state must not copy publication content; the script reads it directly")

    repo = state.get("repo")
    pr = state.get("pr")
    head = state.get("head_sha")
    base = state.get("base_sha")
    if not isinstance(repo, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("Pending state needs a valid GitHub repository")
    if not isinstance(pr, int) or isinstance(pr, bool) or pr < 1:
        raise ValueError("Pending state needs a positive PR number")
    if task_key != f"review-only:github:{repo}#{pr}":
        raise ValueError("Task key does not match the pending publication repository and PR")
    if not isinstance(head, str) or not SHA_RE.fullmatch(head):
        raise ValueError("Pending state needs a valid head SHA")
    if not isinstance(base, str) or not SHA_RE.fullmatch(base):
        raise ValueError("Pending state needs a valid base SHA")
    if state.get("operation") not in {"review", "verify"}:
        raise ValueError("Pending state operation must be review or verify")
    update_count = state.get("update_count")
    if not isinstance(update_count, int) or isinstance(update_count, bool) or update_count < 0:
        raise ValueError("Pending state needs a non-negative update_count")

    body = publication["body"]
    links = load_comment_links(comment_links_path)
    if comment_links_path is not None:
        body = resolve_finding_links(body, links)
    payload = decode_body(body, repo, pr)
    if payload.get("head_sha") != head or payload.get("base_sha") != base:
        raise ValueError("Prepared body ledger SHAs do not match pending state")
    if update_count != payload.get("update_count"):
        raise ValueError("Prepared body ledger count does not match pending state")

    publication["body"] = body
    pending = {
        **state,
        "publication_json": publication,
        "publication_body": body,
    }

    memory_call, memory_cleanup = resolve_memory_tools()
    try:
        current = memory_call("task_get", {"external_key": task_key, "source_type": "github"})
        if not isinstance(current, dict):
            raise RuntimeError("Bot Memory task_get failed or the review task does not exist")
        if current.get("status") == "paused":
            raise RuntimeError("Review task is paused; pending publication was not changed")
        if current.get("status") == "archived":
            raise RuntimeError("Review task is archived; pending publication was not changed")

        current_metadata = current.get("metadata")
        if not isinstance(current_metadata, dict):
            current_metadata = {}
        existing = current_metadata.get("pending_publication")
        if existing is not None:
            if not isinstance(existing, dict):
                raise RuntimeError("Existing pending_publication is not an object")
            existing_body = existing.get("publication_body")
            if (existing.get("head_sha") != head or existing.get("base_sha") != base
                    or not isinstance(existing_body, str)):
                raise RuntimeError("A different or incomplete pending publication must be recovered first")
            existing_payload = decode_body(existing_body, repo, pr)
            if existing_payload != payload:
                raise RuntimeError("Existing pending publication has a different review ledger")
            if existing_body != body:
                if comment_links_path is None or resolve_finding_links(existing_body, links) != body:
                    raise RuntimeError("Pending body can only be refreshed with its matching inline-comment links")

        if existing != pending or current_metadata.get("publication_blocker") is not None:
            updated = memory_call("task_update", {
                "external_key": task_key,
                "source_type": "github",
                "metadata": {
                    "pending_publication": pending,
                    "publication_blocker": None,
                },
            })
            if not isinstance(updated, dict):
                raise RuntimeError("Bot Memory task_update failed; see the MCP error above")

        saved = memory_call("task_get", {"external_key": task_key, "source_type": "github"})
        if (not isinstance(saved, dict)
                or saved.get("status") in {"paused", "archived"}):
            raise RuntimeError("Could not verify pending publication after task update")
        saved_metadata = saved.get("metadata")
        saved_pending = saved_metadata.get("pending_publication") if isinstance(saved_metadata, dict) else None
        if saved_pending != pending:
            raise RuntimeError("Bot Memory did not retain the exact pending publication")
    finally:
        memory_cleanup()

    return {
        "persisted": True,
        "task_key": task_key,
        "head_sha": head,
        "base_sha": base,
        "body_chars": len(body),
        "body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task-key", required=True)
    parser.add_argument("--publication", required=True, type=Path,
                        help="Prepared publication JSON; its body is read by this script")
    parser.add_argument("--pending-state", required=True, type=Path,
                        help="JSON object containing recovery metadata other than the body")
    parser.add_argument("--comment-links", type=Path,
                        help="Optional finding links used to refresh a previously persisted body")
    args = parser.parse_args()
    try:
        print(json.dumps(persist(
            args.task_key, args.publication, args.pending_state, args.comment_links
        )))
    except (OSError, ValueError, RuntimeError) as exc:
        parser.exit(1, f"Pending publication persistence failed: {exc}\n")


if __name__ == "__main__":
    main()
