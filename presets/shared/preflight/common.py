"""Shared utilities for preflight scripts.

Provides task fetching, project-repos resolution, comment formatting,
inter-script state, and the JSON output protocol.
"""

import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

MEMORY_URL = os.environ.get("BOT_MEMORY_URL", "http://localhost:8080").rstrip("/mcp").rstrip("/")
INSTANCE_ID = os.environ.get("BOT_INSTANCE_ID", "")
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
PROJECT_REPOS_PATH = _REPO_ROOT / "project-repos.json"
STATE_FILE = _REPO_ROOT / "data" / "preflight-state.json"


def _instance_param():
    if INSTANCE_ID:
        return f"&instance_id={urllib.parse.quote(INSTANCE_ID)}"
    return ""


def http_get(url, timeout=10):
    """GET JSON from a URL. Returns parsed dict or None on error."""
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f"ERR GET {url}: {e}", file=sys.stderr)
        return None


def get_tasks():
    """Fetch active tasks from memory server, with state file caching."""
    state = load_state()
    if "tasks" in state:
        return state["tasks"]
    data = http_get(f"{MEMORY_URL}/api/tasks?exclude_status=archived&limit=50{_instance_param()}")
    tasks = data.get("items", []) if data else []
    save_state({"tasks": tasks})
    return tasks


def get_capacity():
    """Get (active_count, max) capacity, with state file caching."""
    state = load_state()
    if "capacity" in state:
        c = state["capacity"]
        return c["active"], c["max"]
    data = http_get(
        f"{MEMORY_URL}/api/tasks?exclude_status=archived&exclude_status=done"
        f"&exclude_status=paused&limit=50{_instance_param()}"
    )
    if data and "items" in data:
        n = len([t for t in data["items"] if t.get("status") in ("in_progress", "pr_open", "pr_changes")])
    else:
        n = 0
    save_state({"capacity": {"active": n, "max": 10}})
    return n, 10


def load_project_repos():
    """Load project-repos.json."""
    try:
        return json.loads(PROJECT_REPOS_PATH.read_text())
    except Exception as e:
        print(f"ERR reading {PROJECT_REPOS_PATH}: {e}", file=sys.stderr)
        return {}


def build_repo_lookup(repos_dict=None):
    """Build repo name lookup: bare name and org/repo both resolve to canonical key."""
    if repos_dict is None:
        repos_dict = load_project_repos()
    lookup = {}
    for key, cfg in repos_dict.items():
        lookup[key] = key
        upstream = cfg.get("upstream", "")
        parts = upstream.rstrip("/").removesuffix(".git").split("/")
        if len(parts) >= 2:
            org_repo = f"{parts[-2]}/{parts[-1]}"
            lookup[org_repo] = key
    return lookup


def _parse_repo_path(url):
    """Extract org/repo from a git URL."""
    if ":" in url and "@" in url:
        return url.split(":")[-1].replace(".git", "")
    return "/".join(url.split("/")[-2:]).replace(".git", "")


def upstream_repo(repo_name):
    """Resolve a repo name to (upstream_path, host) from project-repos.json."""
    if "/" in repo_name:
        host = "gitlab" if "gitlab" in repo_name.lower() else "github"
        return repo_name, host
    repos = load_project_repos()
    entry = repos.get(repo_name, {})
    up = entry.get("upstream", "")
    if not up:
        return "", entry.get("host", "github")
    parsed = urllib.parse.urlparse(up if "://" in up else f"ssh://{up}")
    host = parsed.hostname or ""
    if host == "github.com":
        return _parse_repo_path(up), "github"
    if host in ("gitlab.com", "gitlab.cee.redhat.com"):
        return _parse_repo_path(up), "gitlab"
    return _parse_repo_path(up), entry.get("host", "github")


def is_bot_author(author):
    """Check if a comment author is a known bot."""
    if not author or author == "?":
        return False
    a = author.lower()
    return "[bot]" in a or a.endswith("-bot") or a in ("github-actions", "dependabot", "renovate")


def fmt_comments(comments, label, since=None, max_comments=30):
    """Format a list of comments, optionally filtering by timestamp."""
    if not comments:
        return f"  {label}: (none)"
    if since:
        since_prefix = since[:16]
        comments = [c for c in comments if (c.get("t", c.get("created", ""))[:16]) > since_prefix]
    if not comments:
        return f"  {label}: (none since last_addressed)"
    comments = list(reversed(comments))
    truncated = len(comments) > max_comments
    if truncated:
        comments = comments[:max_comments]
    lines = [f"  {label} ({len(comments)}, newest first):"]
    for c in comments:
        author = c.get(
            "a",
            c.get("author", {}).get("displayName", "?") if isinstance(c.get("author"), dict) else c.get("author", "?"),
        )
        t = c.get("t", c.get("created", ""))[:16]
        body = c.get("b", c.get("body", ""))
        lines.append(f"    [{t}] {author}:")
        for bl in body.strip().split("\n"):
            lines.append(f"      {bl}")
    if truncated:
        lines.append(f"    ... truncated (showing {max_comments} of latest, use Jira for full history)")
    return "\n".join(lines)


def fmt_task_header(task):
    """Format common task fields as header lines."""
    key = task.get("external_key", "?")
    status = task.get("status", "?")
    repo = task.get("repo", "?")
    meta = task.get("metadata") or {}
    lines = [f"{key} [{status}] {repo}"]
    if task.get("title"):
        lines.append(f"  title: {task['title']}")
    if task.get("summary"):
        lines.append(f"  summary: {task['summary'][:150]}")
    if meta.get("last_step"):
        lines.append(f"  last_step: {meta['last_step']}")
    if task.get("last_addressed"):
        lines.append(f"  last_addressed: {task['last_addressed']}")
    return lines


def get_task_prs(task):
    """Extract PR info from task metadata/artifacts, resolving host from project-repos."""
    repo = task.get("repo", "")
    meta = task.get("metadata") or {}
    prs_info = list(meta.get("prs", []))
    if not prs_info:
        for a in task.get("artifacts") or []:
            if a.get("type") == "pull_request" and a.get("url"):
                m = re.search(r"github\.com/([^/]+/[^/]+)/pull/(\d+)", a["url"])
                if m:
                    prs_info.append({"repo": m.group(1), "number": int(m.group(2)), "host": "github"})
                    continue
                m = re.search(r"gitlab[^/]*/([^/]+(?:/[^/]+)+)/-/merge_requests/(\d+)", a["url"])
                if m:
                    prs_info.append({"repo": m.group(1), "number": int(m.group(2)), "host": "gitlab"})
    if not prs_info and task.get("pr_number"):
        _, host = upstream_repo(repo)
        prs_info = [{"repo": repo, "number": task["pr_number"], "host": host}]
    return prs_info


def output_result(status, content):
    """Print the JSON protocol result to stdout."""
    print(json.dumps({"status": status, "content": content}))


def load_state():
    """Load preflight state from inter-script state file."""
    try:
        return json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_state(updates):
    """Merge updates into the inter-script state file."""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    state = load_state()
    state.update(updates)
    STATE_FILE.write_text(json.dumps(state, default=str))
