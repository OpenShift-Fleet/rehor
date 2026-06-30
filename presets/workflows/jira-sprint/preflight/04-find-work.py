#!/usr/bin/env python3
"""Find new Jira work candidates for jira-sprint workflow.

Searches active sprint + backlog for unassigned tickets matching
project-repos.json. Workflow-specific — other workflows (kanban, etc.)
have their own find-work logic.
"""

import os
import sys

from common import (
    INSTANCE_ID,
    build_repo_lookup,
    get_capacity,
    load_project_repos,
    load_state,
    output_result,
)
from jira_mcp import jira_call, jira_cleanup

BOT_LABEL = os.environ.get("BOT_LABEL", "")
BOT_INCLUDE_BACKLOG = os.environ.get("BOT_INCLUDE_BACKLOG", "").lower() in ("1", "true", "yes")
BOT_JIRA_EMAIL = os.environ.get("BOT_JIRA_EMAIL", "")
NOT_STARTED_STATUSES = ("New", "Backlog", "Refinement", "To Do")


def jira_search(jql, limit=10):
    data = jira_call(
        "jira_search",
        {
            "jql": jql,
            "limit": limit,
            "fields": "summary,status,labels,assignee,priority,description,comment,issuelinks,issuetype",
        },
    )
    if not data:
        return []
    return data if isinstance(data, list) else data.get("issues", [])


def match_repo_labels(labels, repo_lookup):
    repo_labels = [label.replace("repo:", "") for label in labels if label.startswith("repo:")]
    if not repo_labels:
        return []
    matched = [repo_lookup[r] for r in repo_labels if r in repo_lookup]
    return matched if len(matched) == len(repo_labels) else []


def get_candidates(repo_lookup):
    if not BOT_LABEL:
        print("ERR: BOT_LABEL not set", file=sys.stderr)
        return []

    status_list = ", ".join(f'"{s}"' for s in NOT_STARTED_STATUSES)
    candidates = []
    seen_keys = set()

    def collect(jql, tag):
        added = 0
        for c in jira_search(jql, limit=10):
            if c["key"] not in seen_keys:
                seen_keys.add(c["key"])
                candidates.append(c)
                added += 1
                if len(candidates) >= 10:
                    break
        print(f"  {tag}: +{added} (total {len(candidates)})", file=sys.stderr)

    collect(
        f"labels = {BOT_LABEL} AND sprint in openSprints() "
        f"AND assignee is EMPTY AND status IN ({status_list}) "
        f"ORDER BY priority DESC, created ASC",
        "sprint/unassigned",
    )

    if len(candidates) < 10 and BOT_JIRA_EMAIL:
        collect(
            f"labels = {BOT_LABEL} AND sprint in openSprints() "
            f'AND assignee = "{BOT_JIRA_EMAIL}" AND status IN ({status_list}) '
            f"ORDER BY priority DESC, created ASC",
            "sprint/bot-assigned",
        )

    if len(candidates) < 10 and BOT_INCLUDE_BACKLOG:
        assignee_filter = (
            f'AND (assignee is EMPTY OR assignee = "{BOT_JIRA_EMAIL}") ' if BOT_JIRA_EMAIL else "AND assignee is EMPTY "
        )
        collect(
            f"labels = {BOT_LABEL} {assignee_filter}"
            f"AND status IN ({status_list}) AND (sprint is EMPTY OR sprint not in openSprints()) "
            f"ORDER BY priority DESC, created ASC",
            "backlog",
        )

    return _format_candidates(candidates, repo_lookup)


def get_investigation_candidates(repo_lookup):
    """Search for investigation tickets only (at-capacity path)."""
    if not BOT_LABEL:
        return []
    status_list = ", ".join(f'"{s}"' for s in NOT_STARTED_STATUSES)
    issues = jira_search(
        f"labels = {BOT_LABEL} AND labels = needs-investigation "
        f"AND assignee is EMPTY AND status IN ({status_list}) "
        f"ORDER BY priority DESC, created ASC",
        limit=5,
    )
    return _format_candidates(issues, repo_lookup)


def _format_candidates(issues, repo_lookup):
    results = []
    for issue in issues:
        fields = issue.get("fields") or issue
        labels = fields.get("labels", [])
        repos = match_repo_labels(labels, repo_lookup)
        comment_data = fields.get("comment", {})
        comments = (comment_data.get("comments") or [])[-5:] if isinstance(comment_data, dict) else []
        status = fields.get("status", {})
        priority = fields.get("priority", {})
        issue_type = fields.get("issuetype") or fields.get("issue_type") or {}

        results.append(
            {
                "key": issue["key"],
                "summary": fields.get("summary") or issue.get("summary", ""),
                "status": status.get("name", "?") if isinstance(status, dict) else str(status),
                "priority": priority.get("name", "?") if isinstance(priority, dict) else str(priority),
                "type": issue_type.get("name", "?") if isinstance(issue_type, dict) else str(issue_type),
                "labels": labels,
                "repos": repos,
                "description": fields.get("description") or "",
                "comments": comments,
                "links": fields.get("issuelinks", []),
            }
        )
    return results


def fmt_candidate(c):
    lines = [f"{c['key']} [{c['status']}] priority={c['priority']} type={c['type']}"]
    lines.append(f"  title: {c['summary']}")
    if c["repos"]:
        lines.append(f"  repos: {','.join(c['repos'])}")
    else:
        repo_labels = [label for label in c["labels"] if label.startswith("repo:")]
        if repo_labels:
            lines.append(f"  repo_labels: {','.join(repo_labels)} (NO MATCH in project-repos.json)")
        else:
            lines.append("  repos: (no repo: label)")
    other_labels = [label for label in c["labels"] if not label.startswith("repo:") and label != BOT_LABEL]
    if other_labels:
        lines.append(f"  labels: {','.join(other_labels)}")
    for lk in c["links"][:5]:
        lt = lk.get("type", {}).get("name", "?")
        linked = lk.get("inwardIssue") or lk.get("outwardIssue", {})
        if linked:
            lk_status = linked.get("fields", {}).get("status", {}).get("name", "?")
            lines.append(f"  link: {lt} {linked.get('key', '?')} [{lk_status}]")
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
    if not INSTANCE_ID:
        output_result("error", "BOT_INSTANCE_ID not set")
        return

    state = load_state()
    cap = state.get("capacity", {})
    if cap:
        active_n, max_n = cap.get("active", 0), cap.get("max", 10)
    else:
        active_n, max_n = get_capacity()

    repos_dict = load_project_repos()
    repo_lookup = build_repo_lookup(repos_dict)

    if active_n >= max_n:
        candidates = get_investigation_candidates(repo_lookup)
        jira_cleanup()
        if not candidates:
            output_result("skip", f"At capacity ({active_n}/{max_n}), no investigation tickets")
            return
        lines = [f"## Investigation Candidates (at capacity {active_n}/{max_n})"]
        lines.append("")
        for c in candidates:
            lines.append(fmt_candidate(c))
            lines.append("")
        output_result("start", "\n".join(lines))
        return

    candidates = get_candidates(repo_lookup)
    jira_cleanup()

    if not candidates:
        output_result("skip", "No eligible work candidates in sprint/backlog")
        return

    lines = [f"## New Work Candidates ({len(candidates)})"]
    lines.append("")
    for c in candidates:
        lines.append(fmt_candidate(c))
        lines.append("")

    with_repos = [c for c in candidates if c["repos"]]
    without_repos = [c for c in candidates if not c["repos"]]
    lines.append(f"-> {len(with_repos)} with matching repos, {len(without_repos)} without")
    if with_repos:
        lines.append(f"-> Top pick: {with_repos[0]['key']} repos={','.join(with_repos[0]['repos'])}")

    output_result("start", "\n".join(lines))


if __name__ == "__main__":
    main()
