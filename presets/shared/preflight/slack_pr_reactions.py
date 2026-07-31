"""Slack Open PRs thread — sync emoji reactions with GH/GL PR status.

Reads an Open PRs Slack thread, checks GitHub/GitLab status for each PR/MR URL,
and manages status emoji reactions. Always outputs skip (no LLM session).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime

from common import output_result
from croniter import croniter

DEFAULT_SCHEDULE = "0 9 * * 1-5"
DEFAULT_PATTERN = "open prs"

GH_PR_RE = re.compile(r"https://github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)")
GL_MR_RE = re.compile(r"https://gitlab\.cee\.redhat\.com/([\w./-]+)/-/merge_requests/(\d+)")

STATUS_REACTIONS = ["eyes", "lgtm-5363", "changes_requested", "merged2"]
MANUAL_ONLY = "jira-blocker"
REACTION_SLEEP = 1.0


def check_schedule(cron_expr: str, now: datetime | None = None) -> bool:
    """Return True if now is within the cron window (60s of scheduled time)."""
    if now is None:
        now = datetime.now()
    itr = croniter(cron_expr, now)
    prev = itr.get_prev(datetime)
    return (now - prev).total_seconds() <= 60


def extract_pr_urls(text: str) -> list[tuple[str, str, int]]:
    """Extract (host, repo_path, number) tuples from message text."""
    urls: list[tuple[str, str, int]] = []
    for match in GH_PR_RE.finditer(text):
        urls.append(("github", match.group(1), int(match.group(2))))
    for match in GL_MR_RE.finditer(text):
        urls.append(("gitlab", match.group(1), int(match.group(2))))
    return urls


def desired_reaction_from_gh(pr: dict) -> str | None:
    """Map GitHub PR JSON to status reaction name, or None to clear reactions."""
    state = pr.get("state", "")
    if state == "MERGED":
        return "merged2"
    if state == "CLOSED":
        return None
    decision = pr.get("reviewDecision")
    if decision == "CHANGES_REQUESTED":
        return "changes_requested"
    if decision == "APPROVED":
        return "lgtm-5363"
    return "eyes"


def desired_reaction_from_gl(mr: dict) -> str | None:
    """Map GitLab MR JSON to status reaction name, or None to clear reactions."""
    state = mr.get("state", "")
    if state == "merged":
        return "merged2"
    if state == "closed":
        return None
    if not mr.get("blocking_discussions_resolved", True):
        return "changes_requested"
    if mr.get("approved"):
        return "lgtm-5363"
    approvals_required = mr.get("approvals_before_merge") or 0
    approved_by = mr.get("approved_by") or []
    if approvals_required and len(approved_by) >= approvals_required:
        return "lgtm-5363"
    return "eyes"


def _slack_request(token: str, method: str, params: dict | None = None, post_data: dict | None = None) -> dict | None:
    """Call Slack Web API via urllib. Returns parsed JSON or None on error."""
    url = f"https://slack.com/api/{method}"
    if post_data is not None:
        body = json.dumps(post_data).encode()
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json; charset=utf-8")
    else:
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f"WARN Slack API {method}: {e}", file=sys.stderr)
        return None
    if not data.get("ok"):
        print(f"WARN Slack API {method}: {data.get('error')}", file=sys.stderr)
        return None
    return data


def get_bot_user_id(token: str) -> str | None:
    """Return Slack user ID for the token bearer."""
    data = _slack_request(token, "auth.test")
    return data.get("user_id") if data else None


def find_open_prs_thread(
    slack_token: str,
    channel_id: str,
    pattern: str,
    poster: str | None = None,
) -> str | None:
    """Find root post matching text pattern; return thread_ts (message ts) or None."""
    data = _slack_request(
        slack_token,
        "conversations.history",
        {"channel": channel_id, "limit": 100},
    )
    if not data:
        return None
    needle = pattern.lower()
    for msg in data.get("messages", []):
        if needle not in (msg.get("text") or "").lower():
            continue
        if poster and msg.get("user") != poster:
            continue
        return msg.get("ts")
    return None


def get_thread_replies(slack_token: str, channel_id: str, thread_ts: str) -> list[dict]:
    """Return all messages in a thread (including parent)."""
    data = _slack_request(
        slack_token,
        "conversations.replies",
        {"channel": channel_id, "ts": thread_ts, "limit": 200},
    )
    if not data:
        return []
    return data.get("messages", [])


def get_reactions(slack_token: str, channel_id: str, timestamp: str) -> list[dict]:
    """Return reaction list for a message via reactions.get."""
    data = _slack_request(
        slack_token,
        "reactions.get",
        {"channel": channel_id, "timestamp": timestamp, "full": "true"},
    )
    if not data:
        return []
    return (data.get("message") or {}).get("reactions", [])


def _reactions_add(token: str, channel: str, timestamp: str, name: str) -> bool:
    data = _slack_request(token, "reactions.add", post_data={"channel": channel, "timestamp": timestamp, "name": name})
    time.sleep(REACTION_SLEEP)
    return data is not None


def _reactions_remove(token: str, channel: str, timestamp: str, name: str) -> bool:
    data = _slack_request(
        token,
        "reactions.remove",
        post_data={"channel": channel, "timestamp": timestamp, "name": name},
    )
    time.sleep(REACTION_SLEEP)
    return data is not None


def comment_conflict(
    slack_token: str,
    channel_id: str,
    thread_ts: str,
    message_ts: str,
    human_reaction: str,
    bot_reaction: str,
) -> None:
    """Post thread comment explaining human and bot status reactions coexist."""
    text = (
        f"Status note: this message has `:{human_reaction}:` (manual) and I'm adding "
        f"`:{bot_reaction}:` based on current PR/MR status. Both reactions are intentional."
    )
    _slack_request(
        slack_token,
        "chat.postMessage",
        post_data={
            "channel": channel_id,
            "thread_ts": thread_ts,
            "text": text,
        },
    )


def sync_reaction(
    slack_token: str,
    channel_id: str,
    timestamp: str,
    thread_ts: str,
    current_reactions: list[dict],
    desired_reaction: str | None,
    bot_user_id: str,
) -> None:
    """Add/remove status reactions; respect manual-only and human conflicts."""
    reaction_map = {r["name"]: r for r in current_reactions if r.get("name") != MANUAL_ONLY}

    if desired_reaction is None:
        for name in STATUS_REACTIONS:
            if name not in reaction_map:
                continue
            users = reaction_map[name].get("users", [])
            if bot_user_id in users:
                _reactions_remove(slack_token, channel_id, timestamp, name)
        return

    for name in STATUS_REACTIONS:
        if name == desired_reaction or name not in reaction_map:
            continue
        users = reaction_map[name].get("users", [])
        if bot_user_id in users:
            _reactions_remove(slack_token, channel_id, timestamp, name)

    human_conflict = None
    for name in STATUS_REACTIONS:
        if name == desired_reaction or name not in reaction_map:
            continue
        users = reaction_map[name].get("users", [])
        if any(u != bot_user_id for u in users):
            human_conflict = name
            break

    existing = reaction_map.get(desired_reaction)
    if existing:
        if bot_user_id not in existing.get("users", []):
            _reactions_add(slack_token, channel_id, timestamp, desired_reaction)
    else:
        _reactions_add(slack_token, channel_id, timestamp, desired_reaction)

    if human_conflict:
        comment_conflict(slack_token, channel_id, thread_ts, timestamp, human_conflict, desired_reaction)


def check_github_pr(owner_repo: str, num: int) -> dict | None:
    """Fetch GitHub PR via gh CLI."""
    try:
        r = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                str(num),
                "--repo",
                owner_repo,
                "--json",
                "state,reviewDecision,reviews",
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if r.returncode != 0:
            print(f"WARN gh pr view {owner_repo}#{num}: {r.stderr.strip()}", file=sys.stderr)
            return None
        return json.loads(r.stdout)
    except Exception as e:
        print(f"WARN gh pr view {owner_repo}#{num}: {e}", file=sys.stderr)
        return None


def check_gitlab_mr(project_path: str, num: int) -> dict | None:
    """Fetch GitLab MR via glab CLI."""
    encoded = project_path.replace("/", "%2F")
    try:
        r = subprocess.run(
            [
                "glab",
                "api",
                f"projects/{encoded}/merge_requests/{num}",
                "--hostname",
                "gitlab.cee.redhat.com",
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if r.returncode != 0:
            print(f"WARN glab mr {project_path}!{num}: {r.stderr.strip()}", file=sys.stderr)
            return None
        return json.loads(r.stdout)
    except Exception as e:
        print(f"WARN glab mr {project_path}!{num}: {e}", file=sys.stderr)
        return None


def check_pr_status(host: str, repo_path: str, num: int) -> tuple[str | None, bool]:
    """Return (desired_reaction, ok). ok=False on CLI error; desired=None clears reactions (closed)."""
    if host == "github":
        pr = check_github_pr(repo_path, num)
        if pr is None:
            return None, False
        return desired_reaction_from_gh(pr), True
    if host == "gitlab":
        mr = check_gitlab_mr(repo_path, num)
        if mr is None:
            return None, False
        return desired_reaction_from_gl(mr), True
    return None, False


def process_thread(
    slack_token: str,
    channel_id: str,
    thread_ts: str,
    bot_user_id: str,
) -> int:
    """Sync reactions for all PR/MR replies in a thread. Returns processed count."""
    replies = get_thread_replies(slack_token, channel_id, thread_ts)
    processed = 0
    for msg in replies:
        text = msg.get("text") or ""
        pr_urls = extract_pr_urls(text)
        if not pr_urls:
            continue
        host, repo_path, num = pr_urls[0]
        desired, ok = check_pr_status(host, repo_path, num)
        if not ok:
            continue
        ts = msg.get("ts")
        if not ts:
            continue
        reactions = get_reactions(slack_token, channel_id, ts)
        sync_reaction(slack_token, channel_id, ts, thread_ts, reactions, desired, bot_user_id)
        processed += 1
    return processed


def run() -> None:
    """Main entry: self-disable via skip when misconfigured or outside schedule."""
    token = os.environ.get("SLACK_USER_TOKEN", "").strip()
    channel = os.environ.get("SLACK_OPEN_PRS_CHANNEL", "").strip()
    if not token or not channel:
        output_result("skip", "slack-pr-reactions: missing SLACK_USER_TOKEN or SLACK_OPEN_PRS_CHANNEL")
        return

    schedule = os.environ.get("SLACK_OPEN_PRS_SCHEDULE", "").strip() or DEFAULT_SCHEDULE
    if not check_schedule(schedule):
        output_result("skip", f"slack-pr-reactions: outside schedule ({schedule})")
        return

    pattern = os.environ.get("SLACK_OPEN_PRS_PATTERN", "").strip() or DEFAULT_PATTERN
    poster = os.environ.get("SLACK_OPEN_PRS_POSTER", "").strip() or None

    bot_user_id = get_bot_user_id(token)
    if not bot_user_id:
        output_result("skip", "slack-pr-reactions: could not resolve Slack user ID")
        return

    thread_ts = find_open_prs_thread(token, channel, pattern, poster)
    if not thread_ts:
        output_result("skip", f"slack-pr-reactions: no thread matching '{pattern}'")
        return

    count = process_thread(token, channel, thread_ts, bot_user_id)
    output_result("skip", f"slack-pr-reactions: synced {count} message(s)")


if __name__ == "__main__":
    run()
