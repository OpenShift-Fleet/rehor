"""Onboarding preflight — triage active onboarding tasks + find new tickets.

Label-based candidate finder for onboarding requests.
Returns start when there's actionable work:
  - Active tasks with Jira feedback → start
  - Active tasks ready to advance phase → start
  - New onboarding tickets found → start
  - Nothing actionable → skip
"""

import os
import sys

from common import (
    INSTANCE_ID,
    fmt_comments,
    fmt_task_header,
    get_capacity,
    get_task_prs,
    get_tasks,
    output_result,
    save_state,
)
from jira_mcp import jira_call, jira_cleanup

BOT_LABEL = os.environ.get("BOT_LABEL", "")
BOT_JIRA_EMAIL = os.environ.get("BOT_JIRA_EMAIL", "")


def _jira_issue(key):
    return jira_call(
        "jira_get_issue",
        {
            "issue_key": key,
            "fields": "summary,status,assignee,labels,issuelinks",
            "comment_limit": 10,
        },
    )


def _has_new_jira_feedback(task, issue):
    if not issue:
        return False
    comments = issue.get("comments", [])
    if not comments:
        return False
    last_addressed = task.get("last_addressed", "")
    if not last_addressed:
        return bool(comments)
    return any(
        (c.get("created", "") or c.get("t", ""))[:16] > last_addressed[:16]
        for c in comments
    )


def _jira_search(jql, limit=10):
    return jira_call(
        "jira_search",
        {
            "jql": jql,
            "fields": "summary,status,assignee,labels,created",
            "limit": limit,
        },
    )


def _get_candidates():
    if not BOT_LABEL:
        return []

    jql = (
        f'labels = "{BOT_LABEL}" AND status in ("New", "Backlog", "To Do", "Open") '
        f"AND assignee is EMPTY "
        f"ORDER BY priority DESC, created ASC"
    )
    result = _jira_search(jql, limit=10)
    if not result:
        return []
    return result.get("issues", [])


def _fmt_candidate(issue):
    key = issue.get("key", "?")
    fields = issue.get("fields", {})
    summary = fields.get("summary", "?")
    status = fields.get("status", {}).get("name", "?")
    labels = ", ".join(fields.get("labels", []))
    return f"  {key} [{status}] {summary} (labels: {labels})"


def main():
    if not INSTANCE_ID:
        output_result("error", "BOT_INSTANCE_ID not set")
        return

    tasks = get_tasks()
    active, capacity_max = get_capacity()
    lines = []
    has_work = False

    # Phase 1: Triage active onboarding tasks
    active_tasks = [t for t in tasks if t.get("status") in ("in_progress", "pr_open", "pr_changes")]

    for task in active_tasks:
        key = task.get("external_key", "")
        if not key:
            continue

        task_lines = fmt_task_header(task)
        meta = task.get("metadata") or {}
        last_step = meta.get("last_step", "")
        task_lines.append(f"  onboarding_phase: {last_step}")

        issue = _jira_issue(key)
        if issue:
            new_feedback = _has_new_jira_feedback(task, issue)
            if new_feedback:
                task_lines.append("  *** HAS NEW JIRA FEEDBACK ***")
                has_work = True
            comments = issue.get("comments", [])
            task_lines.append(fmt_comments(comments, "jira_comments", task.get("last_addressed")))
        else:
            task_lines.append("  [jira unavailable]")

        prs = get_task_prs(task)
        if prs:
            for pr in prs:
                task_lines.append(f"  pr: {pr.get('host', 'github')} #{pr.get('number', '?')} ({pr.get('repo', '?')})")

        phases_with_auto_advance = ("scaffolding_pr_opened", "konflux_mr_opened", "app_interface_mr_opened")
        if last_step in phases_with_auto_advance:
            task_lines.append(f"  *** CHECK FOR PHASE ADVANCE (current: {last_step}) ***")
            has_work = True

        lines.append("\n".join(task_lines))

    # Phase 2: Find new onboarding candidates
    candidates = _get_candidates()
    candidate_lines = []
    if candidates:
        for c in candidates:
            candidate_lines.append(_fmt_candidate(c))
        has_work = True

    save_state({
        "active_onboarding_count": len(active_tasks),
        "candidate_count": len(candidates),
    })

    jira_cleanup()

    # Build output
    output_parts = []

    if active_tasks:
        output_parts.append(f"ACTIVE ONBOARDING TASKS ({len(active_tasks)}):")
        output_parts.extend(lines)

    output_parts.append(f"\nCAPACITY: {active}/{capacity_max} active tasks")

    if candidate_lines:
        output_parts.append(f"\nNEW ONBOARDING CANDIDATES ({len(candidates)}):")
        output_parts.extend(candidate_lines)
    elif not active_tasks:
        output_parts.append("\nNo active tasks and no new candidates.")

    content = "\n".join(output_parts)

    if has_work:
        output_result("start", content)
    else:
        output_result("skip", content)


if __name__ == "__main__":
    main()
