#!/usr/bin/env python3
"""Find exact review commands in top-level PR comments.

This identifies candidates only. The review runner must verify organization
membership before acting on any candidate.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timedelta
from urllib.parse import urlencode


COMMAND = "/review-bot re-review"
VERIFY_COMMAND = "/review-bot verify"


def timestamp(value: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError("Timestamps must be strings")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamps must include a timezone")
    return parsed


def requests(comments: list[dict], since: str, through: str, seen_ids: set[int],
             command: str = COMMAND) -> list[dict]:
    start, end = timestamp(since), timestamp(through)
    if end < start:
        raise ValueError("Request window ends before it starts")
    result = []
    emitted: set[int] = set()
    for comment in comments:
        if not isinstance(comment, dict):
            continue
        ident, author = comment.get("id"), comment.get("user") or {}
        if (not isinstance(ident, int) or isinstance(ident, bool) or ident <= 0 or ident in seen_ids or ident in emitted
                or not isinstance(author, dict) or author.get("type") != "User"
                or not isinstance(author.get("login"), str) or not author["login"].strip()
                or not isinstance(comment.get("body"), str)
                or comment.get("updated_at") != comment.get("created_at")
                or comment["body"].strip().casefold() != command.casefold()):
            continue
        try:
            created_at = comment["created_at"]
            created = timestamp(created_at)
        except (KeyError, TypeError, ValueError):
            continue
        if start <= created <= end:
            result.append({"id": ident, "login": author["login"], "created_at": created_at})
            emitted.add(ident)
    return sorted(result, key=lambda item: (timestamp(item["created_at"]), item["id"]))


def fetch_comments(repo: str, number: int, since: str | None = None) -> list[dict]:
    query = {"per_page": 100}
    if since is not None:
        # GitHub's filter is exclusive; overlap by one second at the watermark.
        query["since"] = (timestamp(since) - timedelta(seconds=1)).isoformat()
    result = subprocess.run(
        ["gh", "api", f"repos/{repo}/issues/{number}/comments?{urlencode(query)}", "--paginate", "--slurp"],
        capture_output=True, text=True, timeout=60, check=False,
    )
    if result.returncode:
        raise RuntimeError(f"Cannot fetch PR comments: {result.stderr.strip()[:300]}")
    pages = json.loads(result.stdout)
    if not isinstance(pages, list) or any(not isinstance(page, list) for page in pages):
        raise ValueError("GitHub did not return comment pages")
    return [comment for page in pages for comment in page]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="GitHub owner/repository")
    parser.add_argument("--pr", required=True, type=int)
    parser.add_argument("--since", required=True, help="Inclusive last-seen timestamp")
    parser.add_argument("--through", required=True, help="Inclusive preflight updatedAt")
    parser.add_argument("--seen-ids", default="[]", help="JSON array of already processed comment IDs")
    args = parser.parse_args()
    try:
        seen_ids = json.loads(args.seen_ids)
        if not isinstance(seen_ids, list) or any(type(item) is not int or item <= 0 for item in seen_ids):
            raise ValueError("seen-ids must be a JSON array of positive integers")
        comments = fetch_comments(args.repo, args.pr)
        print(json.dumps(requests(comments, args.since, args.through, set(seen_ids))))
    except (RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
        parser.exit(1, f"Cannot check re-review requests: {exc}\n")


if __name__ == "__main__":
    main()
