#!/usr/bin/env python3
"""Parse contextual /review-bot requests and publish idempotent replies."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from post_review import api
from public_comment_safety import ensure_public_content
from review_comment_footer import LEARNING_REQUEST, status_url, with_footer


COMMAND_PREFIX = "/review-bot"
SPECIAL_ISSUE_COMMANDS = {"verify", "re-review"}
MAX_COMMANDS_PER_CYCLE = 5
MAX_REQUEST_LENGTH = 4000


def parse_request(body: object, *, allow_special: bool = False) -> str | None:
    """Return request text when a comment starts with the command prefix."""
    if not isinstance(body, str):
        return None
    match = re.match(
        rf"^{re.escape(COMMAND_PREFIX)}(?=$|\s)(.*)$",
        body.lstrip(), re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return None
    request = match.group(1).strip()
    if not allow_special and request.casefold() in SPECIAL_ISSUE_COMMANDS:
        return None
    return request


def timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else None


def requests(comments: list[dict], source: str, repo: str, pr: int,
             since: str, through: str, seen_ids: set[str], bot_login: str) -> list[dict]:
    """Select new human-authored command comments from the pinned window."""
    if source not in {"issue", "review-comment", "review"}:
        raise ValueError("Comment source is invalid")
    start, end = timestamp(since), timestamp(through)
    if start is None or end is None or end < start:
        raise ValueError("Command window timestamps are invalid")
    result: list[dict] = []
    emitted: set[str] = set()
    for comment in comments:
        if not isinstance(comment, dict):
            continue
        ident = comment.get("id")
        user = comment.get("user") or {}
        created_at = comment.get("submitted_at") if source == "review" else comment.get("created_at")
        updated_at = comment.get("updated_at")
        body = comment.get("body")
        created = timestamp(created_at)
        feedback_id = f"{source}:{ident}"
        if (type(ident) is not int or ident < 1 or feedback_id in seen_ids
                or feedback_id in emitted or not isinstance(user, dict)
                or user.get("type") != "User"
                or not isinstance(user.get("login"), str)
                or (source == "review" and comment.get("state") not in {
                    "COMMENTED", "APPROVED", "CHANGES_REQUESTED"
                })
                or user["login"].casefold() == bot_login.casefold()
                or (source != "review" and updated_at != created_at) or created is None
                or not start <= created <= end):
            continue
        request = parse_request(body, allow_special=(source != "issue"))
        if request is None:
            continue
        if len(request) > MAX_REQUEST_LENGTH:
            request = ""
            too_long = True
        else:
            too_long = False
        url = comment.get("html_url")
        if not isinstance(url, str) or not url.startswith(f"https://github.com/{repo}/pull/{pr}#"):
            if source == "issue":
                url = f"https://github.com/{repo}/pull/{pr}#issuecomment-{ident}"
            elif source == "review-comment":
                url = f"https://github.com/{repo}/pull/{pr}#discussion_r{ident}"
            else:
                url = f"https://github.com/{repo}/pull/{pr}#pullrequestreview-{ident}"
        entry = {
            "id": ident,
            "source": source,
            "feedback_id": feedback_id,
            "login": user["login"],
            "created_at": created_at,
            "url": url,
            "request": request,
            "too_long": too_long,
        }
        if request.casefold() == LEARNING_REQUEST:
            entry["action"] = LEARNING_REQUEST
        result.append(entry)
        emitted.add(feedback_id)
    return sorted(result, key=lambda item: (timestamp(item["created_at"]), item["id"]))


def _is_org_member(org: str, login: str) -> bool:
    result = subprocess.run(
        ["gh", "api", "--include", f"orgs/{quote(org, safe='')}/members/{quote(login, safe='')}"],
        capture_output=True, text=True, timeout=15, check=False,
    )
    response = result.stdout + "\n" + result.stderr
    status = re.search(r"(?m)^HTTP/\S+\s+(\d{3})\b", response)
    if status and status.group(1) == "204" and result.returncode == 0:
        return True
    if status and status.group(1) == "404":
        return False
    raise RuntimeError(f"Could not verify @{login}'s organization membership")


def publish(repo: str, pr: int, head: str, base: str, review_id: int | None,
            replies_path: Path, expected: list[str]) -> dict:
    if (not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo) or pr < 1
            or not re.fullmatch(r"[0-9a-f]{40}", head)
            or not re.fullmatch(r"[0-9a-f]{40}", base)):
        raise ValueError("Repository, PR, or revision is invalid")
    if not expected or any(
            not re.fullmatch(r"(?:issue|review-comment|review):[1-9]\d*", item)
            for item in expected) or len(expected) != len(set(expected)):
        raise ValueError("Expected command IDs must be unique and source-qualified")
    if review_id is not None and review_id < 1:
        raise ValueError("Status review ID must be positive")

    payload = json.loads(replies_path.read_text())
    replies = payload.get("replies") if isinstance(payload, dict) else None
    if (not isinstance(replies, list) or len(replies) != len(expected)
            or any(not isinstance(item, dict) for item in replies)):
        raise ValueError("Replies must contain exactly one response per command")
    by_id: dict[str, str] = {}
    for reply in replies:
        source, ident, body = reply.get("source"), reply.get("comment_id"), reply.get("text")
        key = f"{source}:{ident}"
        if (key not in expected or key in by_id or not isinstance(body, str) or not body.strip()
                or len(body) > 12000 or "<!-- dev-review-bot:" in body):
            raise ValueError("A command response is invalid or contains a bot marker")
        by_id[key] = body.strip()
    if set(by_id) != set(expected):
        raise ValueError("Every requested command needs exactly one response")

    pull = api(f"repos/{repo}/pulls/{pr}")
    if (not isinstance(pull, dict) or pull.get("state") != "open"
            or not isinstance(pull.get("head"), dict) or pull["head"].get("sha") != head
            or not isinstance(pull.get("base"), dict) or pull["base"].get("sha") != base):
        raise RuntimeError("PR head or base changed before command replies")
    actor = api("user")
    bot_login = actor.get("login") if isinstance(actor, dict) else None
    if not isinstance(bot_login, str) or not bot_login:
        raise RuntimeError("Could not identify the GitHub bot account")

    review_url = None
    if review_id is not None:
        review = api(f"repos/{repo}/pulls/{pr}/reviews/{review_id}")
        body = review.get("body") if isinstance(review, dict) else None
        marker = re.compile(
            r"<!-- dev-review-bot:fabric-access-review:[0-9a-f]{40}:[0-9a-f]{40} -->"
        )
        if (not isinstance(review, dict) or review.get("state") != "COMMENTED"
                or not isinstance(review.get("user"), dict)
                or not isinstance(review["user"].get("login"), str)
                or review["user"]["login"].casefold() != bot_login.casefold()
                or not isinstance(body, str) or not marker.search(body)
                or review.get("html_url") != status_url(repo, pr, review_id)):
            raise RuntimeError("Tracked status review is unavailable or not owned by this bot")
        review_url = status_url(repo, pr, review_id)

    issue_comments = api(f"repos/{repo}/issues/{pr}/comments?per_page=100", paginate=True)
    review_comments = api(f"repos/{repo}/pulls/{pr}/comments?per_page=100", paginate=True)
    reviews = api(f"repos/{repo}/pulls/{pr}/reviews?per_page=100", paginate=True)
    if (not isinstance(issue_comments, list) or not isinstance(review_comments, list)
            or not isinstance(reviews, list)
            or any(not isinstance(item, dict) for item in issue_comments + review_comments + reviews)):
        raise RuntimeError("GitHub returned invalid PR comments")
    sources = {"issue": issue_comments, "review-comment": review_comments, "review": reviews}
    endpoint = f"repos/{repo}/issues/{pr}/comments"
    posted = unchanged = 0
    for key in expected:
        source, raw_id = key.split(":", 1)
        ident = int(raw_id)
        request = next((item for item in sources[source] if item.get("id") == ident), None)
        if not isinstance(request, dict):
            raise RuntimeError(f"Command comment {key} is missing")
        submitted_at = request.get("submitted_at") if source == "review" else request.get("created_at")
        edited = source != "review" and request.get("updated_at") != request.get("created_at")
        if (not isinstance(request.get("user"), dict)
                or request["user"].get("type") != "User"
                or (source == "review" and request.get("state") not in {
                    "COMMENTED", "APPROVED", "CHANGES_REQUESTED"
                })
                or edited or not isinstance(submitted_at, str)
                or parse_request(request.get("body"), allow_special=(source != "issue")) is None):
            raise RuntimeError(f"Command comment {key} is missing, edited, or invalid")
        login = request["user"].get("login")
        if not isinstance(login, str) or not _is_org_member(repo.split("/", 1)[0], login):
            raise RuntimeError(f"Command comment {key} is not from a verified organization member")

        marker = f"<!-- dev-review-bot:command-response:{source}:{ident} -->"
        if any(marker in str(item.get("body", ""))
               and isinstance(item.get("user"), dict)
               and isinstance(item["user"].get("login"), str)
               and item["user"]["login"].casefold() == bot_login.casefold()
               for item in issue_comments):
            unchanged += 1
            continue
        response = by_id[key]
        if not response.startswith("**Answer:**"):
            response = f"**Answer:** {response}"
        comment_url = request.get("html_url")
        if not isinstance(comment_url, str) or not comment_url.startswith(f"https://github.com/{repo}/pull/{pr}#"):
            if source == "issue":
                comment_url = f"https://github.com/{repo}/pull/{pr}#issuecomment-{ident}"
            elif source == "review-comment":
                comment_url = f"https://github.com/{repo}/pull/{pr}#discussion_r{ident}"
            else:
                comment_url = f"https://github.com/{repo}/pull/{pr}#pullrequestreview-{ident}"
        full_body = f"Response to [your `/review-bot` request]({comment_url}):\n\n{response}\n\n{marker}"
        full_body = with_footer(full_body, repo, pr, review_url)
        ensure_public_content(full_body, "Command response")
        created = api(endpoint, "POST", {"body": full_body})
        if not isinstance(created, dict) or type(created.get("id")) is not int:
            raise RuntimeError("GitHub did not confirm the command response")
        issue_comments.append(created)
        posted += 1
    return {"posted": posted, "unchanged": unchanged}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--pr", required=True, type=int)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--review-id", type=int)
    parser.add_argument("--replies", required=True, type=Path)
    parser.add_argument("--comment", required=True, action="append",
                        help="Expected source-qualified ID: issue:123, review-comment:123, or review:123")
    args = parser.parse_args()
    try:
        print(json.dumps(publish(args.repo, args.pr, args.head_sha, args.base_sha,
                                 args.review_id, args.replies, args.comment)))
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        parser.exit(1, f"Command reply failed: {exc}\n")


if __name__ == "__main__":
    main()
