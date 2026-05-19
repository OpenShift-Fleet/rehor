#!/usr/bin/env python3
"""Fetch new Jira work candidates. Runs after triage when no outstanding work.

Queries current sprint (and optionally backlog) for unassigned tickets
matching BOT_LABEL, ordered by priority. Checks repo: labels against
project-repos.json. Outputs full context for each candidate.
"""

import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from jira_mcp import jira_call
from paths import SLEEP_FILE

PROJECT_REPOS = Path(__file__).resolve().parent.parent.parent.parent / "project-repos.json"
BOT_LABEL = os.environ.get("BOT_LABEL", "")
BOT_BOARD_ID = os.environ.get("BOT_BOARD_ID", "")
BOT_BOARD_NAME = os.environ.get("BOT_BOARD_NAME", "")
BOT_INCLUDE_BACKLOG = os.environ.get("BOT_INCLUDE_BACKLOG", "").lower() in ("1", "true", "yes")
NOT_STARTED_STATUSES = ("New", "Backlog", "Refinement", "To Do")


def jira_search(jql, limit=10):
    data = jira_call("jira_search", {
        "jql": jql,
        "limit": limit,
        "fields": "summary,status,labels,assignee,priority,description,comment,issuelinks,issuetype",
    })
    if not data:
        print("ERR: Jira search returned no data", file=sys.stderr)
        return []
    issues = data if isinstance(data, list) else data.get("issues", [])
    return issues


def resolve_board_id():
    if BOT_BOARD_ID:
        return BOT_BOARD_ID
    if not BOT_BOARD_NAME:
        print("WARN: neither BOT_BOARD_ID nor BOT_BOARD_NAME set, skipping sprint query", file=sys.stderr)
        return None
    data = jira_call("jira_get_agile_boards", {
        "board_name": BOT_BOARD_NAME,
        "limit": 1,
    })
    if not data:
        print(f"ERR: no board found matching name '{BOT_BOARD_NAME}'", file=sys.stderr)
        return None
    boards = data if isinstance(data, list) else data.get("values", [])
    if not boards:
        print(f"ERR: no board found matching name '{BOT_BOARD_NAME}'", file=sys.stderr)
        return None
    board = boards[0]
    print(f"Resolved board: {board.get('name', '?')} (id={board['id']})", file=sys.stderr)
    return str(board["id"])


def get_active_sprint():
    board_id = resolve_board_id()
    if not board_id:
        return None
    data = jira_call("jira_get_sprints_from_board", {
        "board_id": board_id,
        "state": "active",
        "limit": 1,
    })
    if not data:
        return None
    sprints = data if isinstance(data, list) else data.get("values", [])
    if sprints:
        print(f"Active sprint: {sprints[0].get('name', '?')} (id={sprints[0]['id']})", file=sys.stderr)
    return sprints[0] if sprints else None


def load_project_repos():
    try:
        return json.loads(PROJECT_REPOS.read_text())
    except Exception as e:
        print(f"ERR reading {PROJECT_REPOS}: {e}", file=sys.stderr)
        return {}


def build_repo_lookup(repos_dict):
    lookup = {}
    for key, cfg in repos_dict.items():
        lookup[key] = key
        upstream = cfg.get("upstream", "")
        parts = upstream.rstrip("/").removesuffix(".git").split("/")
        if len(parts) >= 2:
            org_repo = f"{parts[-2]}/{parts[-1]}"
            lookup[org_repo] = key
    return lookup


def match_repo_labels(labels, repo_lookup):
    repo_labels = [l.replace("repo:", "") for l in labels if l.startswith("repo:")]
    if not repo_labels:
        return []
    matched = [repo_lookup[r] for r in repo_labels if r in repo_lookup]
    return matched if len(matched) == len(repo_labels) else []


def get_candidates():
    if not BOT_LABEL:
        print("ERR: BOT_LABEL not set", file=sys.stderr)
        return []
    repos_dict = load_project_repos()
    repo_lookup = build_repo_lookup(repos_dict)
    status_list = ", ".join(f'"{s}"' for s in NOT_STARTED_STATUSES)
    candidates = []

    sprint = get_active_sprint()
    if sprint:
        jql = (
            f"project = RHCLOUD AND labels = {BOT_LABEL} "
            f"AND assignee is EMPTY AND status IN ({status_list}) "
            f"AND sprint = {sprint['id']} "
            f"ORDER BY priority DESC, created ASC"
        )
        candidates.extend(jira_search(jql, limit=10))

    if len(candidates) < 10 and BOT_INCLUDE_BACKLOG:
        existing_keys = {c["key"] for c in candidates}
        jql = (
            f"project = RHCLOUD AND labels = {BOT_LABEL} "
            f"AND assignee is EMPTY AND status IN ({status_list}) "
            f"AND sprint is EMPTY "
            f"ORDER BY priority DESC, created ASC"
        )
        for c in jira_search(jql, limit=10):
            if c["key"] not in existing_keys:
                candidates.append(c)
                if len(candidates) >= 10:
                    break

    results = []
    for issue in candidates:
        fields = issue.get("fields", {})
        labels = fields.get("labels", [])
        repos = match_repo_labels(labels, repo_lookup)
        comments = (fields.get("comment", {}).get("comments") or [])[-5:]

        results.append({
            "key": issue["key"],
            "summary": fields.get("summary", ""),
            "status": fields.get("status", {}).get("name", "?"),
            "priority": fields.get("priority", {}).get("name", "?"),
            "type": fields.get("issuetype", {}).get("name", "?"),
            "labels": labels,
            "repos": repos,
            "description": fields.get("description") or "",
            "comments": comments,
            "links": fields.get("issuelinks", []),
        })
    return results


def fmt_candidate(c):
    lines = [f"{c['key']} [{c['status']}] priority={c['priority']} type={c['type']}"]
    lines.append(f"  title: {c['summary']}")
    if c["repos"]:
        lines.append(f"  repos: {','.join(c['repos'])}")
    else:
        repo_labels = [l for l in c["labels"] if l.startswith("repo:")]
        if repo_labels:
            lines.append(f"  repo_labels: {','.join(repo_labels)} (NO MATCH in project-repos.json)")
        else:
            lines.append("  repos: (no repo: label)")
    other_labels = [l for l in c["labels"] if not l.startswith("repo:") and l != BOT_LABEL]
    if other_labels:
        lines.append(f"  labels: {','.join(other_labels)}")
    for lk in c["links"][:5]:
        lt = lk.get("type", {}).get("name", "?")
        linked = lk.get("inwardIssue") or lk.get("outwardIssue", {})
        if linked:
            lk_status = linked.get("fields", {}).get("status", {}).get("name", "?")
            lines.append(f"  link: {lt} {linked.get('key','?')} [{lk_status}]")
    if c["description"]:
        lines.append("  description:")
        for dl in c["description"].strip().split("\n"):
            lines.append(f"    {dl}")
    if c["comments"]:
        lines.append(f"  comments ({len(c['comments'])}):")
        for cm in c["comments"]:
            author = cm.get("author", {}).get("displayName", "?")
            t = cm.get("created", "")[:16]
            body = cm.get("body", "")
            lines.append(f"    [{t}] {author}:")
            for bl in body.strip().split("\n"):
                lines.append(f"      {bl}")
    return "\n".join(lines)


def main():
    candidates = get_candidates()
    if not candidates:
        print("NO CANDIDATES FOUND")
        SLEEP_FILE.parent.mkdir(parents=True, exist_ok=True)
        SLEEP_FILE.write_text(json.dumps({"recommended_sleep": 3600, "reason": "no_eligible_work"}))
        return

    print(f"NEW WORK CANDIDATES ({len(candidates)})")
    print()
    for c in candidates:
        print(fmt_candidate(c))
        print()

    with_repos = [c for c in candidates if c["repos"]]
    without_repos = [c for c in candidates if not c["repos"]]
    print(f"-> {len(with_repos)} with matching repos, {len(without_repos)} without")
    if with_repos:
        print(f"-> Top pick: {with_repos[0]['key']} repos={','.join(with_repos[0]['repos'])}")


if __name__ == "__main__":
    main()
