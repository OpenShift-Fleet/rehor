"""Jira sprint preflight — triage active tasks + find new work candidates.

Single script replacing the former 03-jira-triage + 04-find-work split.
Returns start only when there's genuinely actionable work:
  - Active tasks with Jira feedback or interrupted work → start
  - Active tasks all clean + capacity + new candidates → start
  - No active tasks + new candidates found → start
  - No active tasks + no candidates → skip
  - Active tasks, all Jira-clean, no capacity or no candidates → skip
"""

import os
import sys

from common import (
    INSTANCE_ID,
    build_repo_lookup,
    fmt_comments,
    fmt_task_header,
    get_capacity,
    get_task_prs,
    get_tasks,
    load_project_repos,
    output_result,
    save_state,
)
from jira_mcp import jira_call, jira_cleanup

BOT_LABEL = os.environ.get("BOT_LABEL", "")
BOT_INCLUDE_BACKLOG = os.environ.get("BOT_INCLUDE_BACKLOG", "").lower() in ("1", "true", "yes")
BOT_JIRA_EMAIL = os.environ.get("BOT_JIRA_EMAIL", "")
NOT_STARTED_STATUSES = ("New", "Backlog", "Refinement", "To Do")


# ---------------------------------------------------------------------------
# Triage helpers
# ---------------------------------------------------------------------------


def _jira_issue(key):
    return jira_call(
        "jira_get_issue",
        {
            "issue_key": key,
            "fields": "summary,status,assignee,labels,issuelinks",
            "comment_limit": 10,
        },
    )


def _has_new_jira_feedback(jira_comments, last_addressed):
    for c in jira_comments:
        ct = c.get("created", "")[:16]
        if last_addressed and ct > last_addressed[:16]:
            body = c.get("body", "")
            if not ("### " in body or "| " in body or "PR:" in body):
                return True
    return False


def _fmt_jira(task, jira_data, jira_comments):
    lines = fmt_task_header(task)
    if jira_data:
        fields = jira_data.get("fields", {})
        lines.append(f"  jira_status: {fields.get('status', {}).get('name', '?')}")
        labels = fields.get("labels", [])
        if labels:
            lines.append(f"  labels: {','.join(labels)}")
        for lk in fields.get("issuelinks", [])[:5]:
            lt = lk.get("type", {}).get("name", "?")
            linked = lk.get("inwardIssue") or lk.get("outwardIssue", {})
            if linked:
                status = linked.get("fields", {}).get("status", {}).get("name", "?")
                lines.append(f"  link: {lt} {linked.get('key', '?')} [{status}]")
        last_addr = task.get("last_addressed")
        jc = [
            {
                "author": c.get("author", {}).get("displayName", "?"),
                "t": c.get("created", "")[:16],
                "b": c.get("body", ""),
            }
            for c in jira_comments
        ]
        lines.append(fmt_comments(jc, "jira_comments", since=last_addr))
    else:
        lines.append("  [jira unavailable — use jira_get_issue]")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Find-work helpers
# ---------------------------------------------------------------------------


def _jira_search(jql, limit=10):
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


def _match_repo_labels(labels, repo_lookup):
    repo_labels = [label.replace("repo:", "") for label in labels if label.startswith("repo:")]
    if not repo_labels:
        return []
    matched = [repo_lookup[r] for r in repo_labels if r in repo_lookup]
    return matched if len(matched) == len(repo_labels) else []


def _format_candidates(issues, repo_lookup):
    results = []
    for issue in issues:
        fields = issue.get("fields") or issue
        labels = fields.get("labels", [])
        repos = _match_repo_labels(labels, repo_lookup)
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


def _get_candidates(repo_lookup):
    if not BOT_LABEL:
        print("ERR: BOT_LABEL not set", file=sys.stderr)
        return []

    status_list = ", ".join(f'"{s}"' for s in NOT_STARTED_STATUSES)
    candidates = []
    seen_keys = set()

    def collect(jql, tag):
        added = 0
        for c in _jira_search(jql, limit=10):
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


def _get_investigation_candidates(repo_lookup):
    if not BOT_LABEL:
        return []
    status_list = ", ".join(f'"{s}"' for s in NOT_STARTED_STATUSES)
    issues = _jira_search(
        f"labels = {BOT_LABEL} AND labels = needs-investigation "
        f"AND assignee is EMPTY AND status IN ({status_list}) "
        f"ORDER BY priority DESC, created ASC",
        limit=5,
    )
    return _format_candidates(issues, repo_lookup)


def _fmt_candidate(c):
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


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    if not INSTANCE_ID:
        output_result("error", "BOT_INSTANCE_ID not set")
        return

    tasks = get_tasks()
    active_n, max_n = get_capacity()
    active = [t for t in tasks if t.get("status") in ("in_progress", "pr_open", "pr_changes")]
    paused = [t for t in tasks if t.get("status") == "paused"]
    done = [t for t in tasks if t.get("status") == "done"]

    lines = [f"## Jira Sprint Preflight (capacity {active_n}/{max_n})"]
    lines.append("")

    # Phase 1: Triage active tasks for Jira feedback / interruptions
    if active:
        feedback_tasks = []
        interrupted_tasks = []
        clean_tasks = []

        for t in active:
            key = t.get("external_key", "")
            meta = t.get("metadata") or {}
            prs = get_task_prs(t)

            jira = _jira_issue(key) if key else None
            jira_comments = []
            if jira:
                jira_comments = (jira.get("fields", {}).get("comment", {}).get("comments") or [])[-10:]

            is_interrupted = (
                t.get("status") == "in_progress" and not t.get("pr_number") and not meta.get("prs") and not prs
            )

            if _has_new_jira_feedback(jira_comments, t.get("last_addressed", "")):
                feedback_tasks.append((t, jira, jira_comments))
            elif is_interrupted:
                interrupted_tasks.append((t, jira, jira_comments))
            else:
                clean_tasks.append((t, jira, jira_comments))

        actionable = len(feedback_tasks) + len(interrupted_tasks)

        if feedback_tasks:
            lines.append(f"### JIRA FEEDBACK ({len(feedback_tasks)})")
            for t, jira, jc in feedback_tasks:
                lines.append(_fmt_jira(t, jira, jc))
                lines.append("")

        if interrupted_tasks:
            lines.append(f"### INTERRUPTED ({len(interrupted_tasks)})")
            for t, jira, jc in interrupted_tasks:
                lines.append(_fmt_jira(t, jira, jc))
                lines.append("")

        if clean_tasks:
            lines.append(f"### CLEAN ({len(clean_tasks)})")
            for t, _, _ in clean_tasks:
                lines.append(f"  {t.get('external_key', '?')} [{t.get('status', '?')}] {t.get('repo', '?')}")
            lines.append("")

        if actionable > 0:
            save_state({"jira": {"feedback": len(feedback_tasks), "interrupted": len(interrupted_tasks)}})
            output_result("start", "\n".join(lines))
            jira_cleanup()
            return

        # Active tasks but all Jira-clean — still search for new work if capacity allows

    # Phase 2: Search for new work candidates (capacity permitting)
    if not active:
        lines.append("No active tasks")
    if done:
        lines.append(f"done pending archival: {','.join(t.get('external_key', '?') for t in done)}")
    if paused:
        parts = (t.get("external_key", "?") + ":" + str(t.get("paused_reason", "")) for t in paused)
        lines.append(f"paused: {' | '.join(parts)}")
    lines.append("")

    repos_dict = load_project_repos()
    repo_lookup = build_repo_lookup(repos_dict)

    if active_n >= max_n:
        candidates = _get_investigation_candidates(repo_lookup)
        jira_cleanup()
        if not candidates:
            lines.append(f"At capacity ({active_n}/{max_n}), no investigation tickets")
            save_state({"jira": {"feedback": 0, "interrupted": 0}})
            output_result("skip", "\n".join(lines))
            return
        lines.append(f"### Investigation Candidates (at capacity {active_n}/{max_n})")
        lines.append("")
        for c in candidates:
            lines.append(_fmt_candidate(c))
            lines.append("")
        save_state({"jira": {"feedback": 0, "interrupted": 0}})
        output_result("start", "\n".join(lines))
        return

    candidates = _get_candidates(repo_lookup)
    jira_cleanup()

    if not candidates:
        lines.append("No eligible work candidates in sprint/backlog")
        save_state({"jira": {"feedback": 0, "interrupted": 0}})
        output_result("skip", "\n".join(lines))
        return

    lines.append(f"### New Work Candidates ({len(candidates)})")
    lines.append("")
    for c in candidates:
        lines.append(_fmt_candidate(c))
        lines.append("")

    with_repos = [c for c in candidates if c["repos"]]
    without_repos = [c for c in candidates if not c["repos"]]
    lines.append(f"-> {len(with_repos)} with matching repos, {len(without_repos)} without")
    if with_repos:
        lines.append(f"-> Top pick: {with_repos[0]['key']} repos={','.join(with_repos[0]['repos'])}")

    save_state({"jira": {"feedback": 0, "interrupted": 0}})
    output_result("start", "\n".join(lines))


if __name__ == "__main__":
    main()
