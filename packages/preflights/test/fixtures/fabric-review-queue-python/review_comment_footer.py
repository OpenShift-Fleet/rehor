#!/usr/bin/env python3
"""Add a consistent status link and next steps to bot comments other than the status review."""

from __future__ import annotations

import argparse
import json
import re
import subprocess

from public_comment_safety import ensure_public_content


START = "<!-- dev-review-bot:comment-footer:start -->"
END = "<!-- dev-review-bot:comment-footer:end -->"
LEARNING_REQUEST = "learning-extraction"
LEARNING_STEP = f"- Comment `/review-bot {LEARNING_REQUEST}` to ask for reusable lessons from this PR."
_FOOTER = re.compile(r"\n*<!-- dev-review-bot:comment-footer:start -->\n.*?"
                     r"<!-- dev-review-bot:comment-footer:end -->\s*\Z", re.DOTALL)
_BOT_COMMENT = re.compile(r"<!-- dev-review-bot:(?!comment-footer:)[^>]+ -->")


def status_url(repo: str, pr: int, review_id: int) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo) or pr < 1:
        raise ValueError("Repository or PR number is invalid")
    if type(review_id) is not int or review_id < 1:
        raise ValueError("Status review ID must be positive")
    return f"https://github.com/{repo}/pull/{pr}#pullrequestreview-{review_id}"


def with_footer(body: str, repo: str, pr: int, review_url: str | None = None) -> str:
    """Replace this bot's footer while preserving the comment and its ID marker."""
    if not isinstance(body, str) or not body.strip():
        raise ValueError("Bot comment body is empty")
    if "<!-- dev-review-bot:fabric-access-review:" in body:
        raise ValueError("The status review must not have a comment footer")
    if review_url is not None and not re.fullmatch(
            re.escape(f"https://github.com/{repo}/pull/{pr}#pullrequestreview-") + r"[1-9]\d*",
            review_url):
        raise ValueError("Status URL does not belong to this PR")
    if START in body or END in body:
        match = _FOOTER.search(body)
        if match is None or body.count(START) != 1 or body.count(END) != 1:
            raise ValueError("Bot comment has a malformed footer")
        body = body[:match.start()].rstrip()
    else:
        body = body.rstrip()

    steps = []
    question = re.search(r"<!-- dev-review-bot:missing-context:(Q-[0-9a-f]{12}) -->", body)
    approval = re.search(r"<!-- dev-review-bot:review-approval:(RA-[0-9a-f]{12}) -->", body)
    recovery = re.search(r"<!-- dev-review-bot:ledger-recovery:(LR-[0-9a-f]{12}) -->", body)
    if question:
        steps.append(f"- Answer this question with `Answer {question.group(1)}: ...`.")
    if approval:
        steps.append(f"- Approve with `Review bot: yes {approval.group(1)}` or decline with `Review bot: no {approval.group(1)}`.")
    if recovery:
        steps.append(f"- Approve a fresh review with `Review bot: yes {recovery.group(1)}` or decline with `Review bot: no {recovery.group(1)}`.")
    steps.append("- Comment `/review-bot <question or request>` for an answer based on the pinned PR and review context.")
    steps.append(LEARNING_STEP)
    if review_url:
        steps.extend([
            "- After changes, comment `/review-bot verify` to recheck existing findings.",
            "- Comment `/review-bot re-review` to request a full review (approval required).",
        ])
    footer = "\n".join([
        START,
        "---",
        "",
        (f"**Status Comment:** [View review status]({review_url})"
         if review_url else "**Status Comment:** Pending the first review."),
        "",
        "**Next steps:**",
        *steps,
        END,
    ])
    return f"{body}\n\n{footer}"


def sync(repo: str, pr: int, review_id: int | None = None) -> dict:
    """Add or refresh the footer on this bot's published PR comments."""
    from post_review import api

    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo) or pr < 1:
        raise ValueError("Repository or PR number is invalid")
    actor = api("user")
    login = actor.get("login") if isinstance(actor, dict) else None
    if not isinstance(login, str) or not login:
        raise RuntimeError("Could not identify the GitHub reviewer")
    review_url = None
    if review_id is not None:
        review = api(f"repos/{repo}/pulls/{pr}/reviews/{review_id}")
        if (not isinstance(review, dict) or review.get("state") != "COMMENTED"
                or not isinstance(review.get("user"), dict)
                or not isinstance(review["user"].get("login"), str)
                or review["user"]["login"].casefold() != login.casefold()
                or not isinstance(review.get("body"), str)
                or "<!-- dev-review-bot:fabric-access-review:" not in review["body"]
                or review.get("html_url") != status_url(repo, pr, review_id)):
            raise RuntimeError("Tracked status review is unavailable or not owned by this bot")
        review_url = review["html_url"]

    updated = unchanged = 0
    sources = (
        (f"repos/{repo}/issues/{pr}/comments?per_page=100", f"repos/{repo}/issues/comments/"),
        (f"repos/{repo}/pulls/{pr}/comments?per_page=100", f"repos/{repo}/pulls/comments/"),
    )
    for endpoint, update_prefix in sources:
        comments = api(endpoint, paginate=True)
        if not isinstance(comments, list) or any(not isinstance(item, dict) for item in comments):
            raise RuntimeError("GitHub returned invalid bot comments")
        for comment in comments:
            user = comment.get("user")
            body = comment.get("body")
            if (not isinstance(user, dict) or not isinstance(user.get("login"), str)
                    or user["login"].casefold() != login.casefold()
                    or not isinstance(body, str) or not _BOT_COMMENT.search(body)):
                continue
            if review_url is None and START in body:
                unchanged += 1
                continue
            desired = with_footer(body, repo, pr, review_url)
            if desired == body:
                unchanged += 1
                continue
            ensure_public_content(desired, "Bot comment")
            ident = comment.get("id")
            if type(ident) is not int or ident < 1:
                raise RuntimeError("Bot comment ID is invalid")
            result = api(f"{update_prefix}{ident}", "PATCH", {"body": desired})
            if not isinstance(result, dict) or result.get("id") != ident:
                raise RuntimeError("GitHub did not confirm bot comment update")
            updated += 1
    return {"updated": updated, "unchanged": unchanged, "status_url": review_url}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--pr", required=True, type=int)
    parser.add_argument("--review-id", type=int)
    args = parser.parse_args()
    try:
        print(json.dumps(sync(args.repo, args.pr, args.review_id)))
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        parser.exit(1, f"Comment footer sync failed: {exc}\n")


if __name__ == "__main__":
    main()
