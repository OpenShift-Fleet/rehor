"""Jira issue triage — status, comments, links, interrupted tasks.

Fetches active tasks, checks Jira issue state and comments,
identifies new human feedback and interrupted work.
Outputs JSON protocol: start if actionable items found, skip if all clean.
"""

from common import (
    INSTANCE_ID,
    fmt_comments,
    fmt_task_header,
    get_capacity,
    get_task_prs,
    get_tasks,
    load_state,
    output_result,
    save_state,
)
from jira_mcp import jira_call, jira_cleanup


def jira_issue(key):
    """Fetch Jira issue details with comments."""
    return jira_call(
        "jira_get_issue",
        {
            "issue_key": key,
            "fields": "summary,status,assignee,labels,issuelinks",
            "comment_limit": 10,
        },
    )


def has_new_jira_feedback(jira_comments, last_addressed):
    """Check if there's new human feedback in Jira comments since last_addressed."""
    for c in jira_comments:
        ct = c.get("created", "")[:16]
        if last_addressed and ct > last_addressed[:16]:
            body = c.get("body", "")
            if not ("### " in body or "| " in body or "PR:" in body):
                return True
    return False


def fmt_jira(task, jira_data, jira_comments):
    """Format a task with Jira details."""
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


def main():
    if not INSTANCE_ID:
        output_result("error", "BOT_INSTANCE_ID not set")
        return

    tasks = get_tasks()
    active_n, max_n = get_capacity()
    active = [t for t in tasks if t.get("status") in ("in_progress", "pr_open", "pr_changes")]
    paused = [t for t in tasks if t.get("status") == "paused"]
    done = [t for t in tasks if t.get("status") == "done"]

    lines = [f"## Jira Triage (capacity {active_n}/{max_n})"]
    lines.append("")

    if not active:
        lines.append("No active tasks → Priority 2 (new Jira work)")
        if done:
            lines.append(f"done pending archival: {','.join(t.get('external_key', '?') for t in done)}")
        if paused:
            lines.append(f"paused: {','.join(t.get('external_key', '?') for t in paused)}")
        save_state({"jira": {"feedback": 0, "interrupted": 0}})
        output_result("start", "\n".join(lines))
        jira_cleanup()
        return

    feedback_tasks = []
    interrupted_tasks = []
    clean_tasks = []

    for t in active:
        key = t.get("external_key", "")
        meta = t.get("metadata") or {}
        prs = get_task_prs(t)

        jira = jira_issue(key) if key else None
        jira_comments = []
        if jira:
            jira_comments = (jira.get("fields", {}).get("comment", {}).get("comments") or [])[-10:]

        last_addr = t.get("last_addressed", "")
        is_interrupted = t.get("status") == "in_progress" and not t.get("pr_number") and not meta.get("prs") and not prs

        if has_new_jira_feedback(jira_comments, last_addr):
            feedback_tasks.append((t, jira, jira_comments))
        elif is_interrupted:
            interrupted_tasks.append((t, jira, jira_comments))
        else:
            clean_tasks.append((t, jira, jira_comments))

    actionable = 0

    if feedback_tasks:
        lines.append(f"### JIRA FEEDBACK ({len(feedback_tasks)})")
        for t, jira, jc in feedback_tasks:
            lines.append(fmt_jira(t, jira, jc))
            lines.append("")
        actionable += len(feedback_tasks)

    if interrupted_tasks:
        lines.append(f"### INTERRUPTED ({len(interrupted_tasks)})")
        for t, jira, jc in interrupted_tasks:
            lines.append(fmt_jira(t, jira, jc))
            lines.append("")
        actionable += len(interrupted_tasks)

    if clean_tasks:
        lines.append(f"### CLEAN ({len(clean_tasks)})")
        for t, _, _ in clean_tasks:
            lines.append(f"  {t.get('external_key', '?')} [{t.get('status', '?')}] {t.get('repo', '?')}")
        lines.append("")

    if paused:
        parts = (t.get("external_key", "?") + ":" + str(t.get("paused_reason", "")) for t in paused)
        lines.append(f"PAUSED: {' | '.join(parts)}")
    if done:
        lines.append(f"DONE (archive?): {','.join(t.get('external_key', '?') for t in done)}")

    prev = load_state()
    prev_actionable = prev.get("has_actionable", False)
    save_state(
        {
            "jira": {"feedback": len(feedback_tasks), "interrupted": len(interrupted_tasks)},
            "has_actionable": prev_actionable or actionable > 0,
        }
    )

    content = "\n".join(lines)
    output_result("start" if actionable > 0 else "skip", content)
    jira_cleanup()


if __name__ == "__main__":
    main()
