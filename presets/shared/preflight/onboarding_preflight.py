"""Onboarding preflight — triage active onboarding tasks + find new tickets.

Label-based candidate finder for onboarding requests.
Returns start when there's actionable work:
  - Active tasks with Jira feedback → start
  - Active tasks ready to advance phase → start
  - New onboarding tickets found → start
  - Nothing actionable → skip
"""

import json
import os
import re
import subprocess

from common import (
    INSTANCE_ID,
    fmt_comments,
    fmt_task_header,
    get_capacity,
    get_task_prs,
    get_tasks,
    output_result,
    save_state,
    upstream_repo,
)
from jira_mcp import jira_call, jira_cleanup

BOT_LABEL = os.environ.get("BOT_LABEL", "")
if BOT_LABEL and not re.match(r"^[a-zA-Z0-9:_-]+$", BOT_LABEL):
    raise ValueError(f"Invalid BOT_LABEL: {BOT_LABEL!r}")
BOT_JIRA_EMAIL = os.environ.get("BOT_JIRA_EMAIL", "")


def _jira_issue(key):
    return jira_call(
        "jira_get_issue",
        {
            "issue_key": key,
            "fields": "summary,status,assignee,labels,issuelinks,comment",
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
    return any((c.get("created", "") or c.get("t", ""))[:16] > last_addressed[:16] for c in comments)


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
        f'project = REHOR AND labels = "{BOT_LABEL}" AND status in ("New", "Backlog", "To Do", "Open") '
        f"AND assignee is EMPTY "
        f"ORDER BY priority DESC, created ASC"
    )
    result = _jira_search(jql, limit=10)
    if not result:
        return []
    return result.get("issues", [])


BLOCKED_LABEL = "onboarding:blocked"

STEP_TO_PHASE = {
    "scaffolding-pr": "phase1",
    "konflux-mr": "phase2",
    "app-interface-mr": "phase3",
}


def _is_blocked(issue):
    if not issue:
        return False
    labels = issue.get("labels", [])
    return BLOCKED_LABEL in labels


def _get_onboarding_label(issue):
    if not issue:
        return None
    labels = issue.get("labels", [])
    for lbl in labels:
        if lbl.startswith("onboarding:") and lbl != BLOCKED_LABEL:
            return lbl
    return None


def _phase_ticket_done(task, step):
    """Check if the phase sub-ticket for the given step is already Done."""
    phase_key = STEP_TO_PHASE.get(step)
    if not phase_key:
        return False
    meta = task.get("metadata") or {}
    ticket_key = meta.get("phase_tickets", {}).get(phase_key)
    if not ticket_key:
        return False
    issue = _jira_issue(ticket_key)
    if not issue:
        return False
    status = issue.get("status", {})
    name = (status.get("name", "") if isinstance(status, dict) else str(status)).lower()
    return name in ("done", "closed", "resolved")


def _any_pr_mr_merged(task, step):
    """Check if the PR/MR for the current phase step has been merged.

    Uses the phase sub-ticket as source of truth: if the sub-ticket is
    already Done, the merge was handled in a prior cycle.  Only checks
    the most recent PR/MR matching the step's host to avoid false
    positives from earlier phases' merged PRs/MRs.
    """
    if _phase_ticket_done(task, step):
        return False

    prs = get_task_prs(task)
    if not prs:
        return False

    if step == "scaffolding-pr":
        candidates = [p for p in prs if p.get("host", "github") == "github"]
    else:
        candidates = [p for p in prs if p.get("host") == "gitlab"]

    if not candidates:
        return False

    target = candidates[-1]
    host = target.get("host", "github")
    num = target.get("number")
    repo = target.get("repo", "")
    if not num or not repo:
        return False

    try:
        if host == "github":
            up, _ = upstream_repo(repo)
            if not up:
                return False
            r = subprocess.run(
                ["gh", "pr", "view", str(num), "--repo", up, "--json", "state"],
                capture_output=True,
                text=True,
                timeout=15,
            )
            if r.returncode == 0:
                return json.loads(r.stdout).get("state") == "MERGED"
        else:
            up, _ = upstream_repo(repo)
            if not up:
                return False
            encoded = up.replace("/", "%2F")
            r = subprocess.run(
                ["glab", "api", f"projects/{encoded}/merge_requests/{num}", "--hostname", "gitlab.cee.redhat.com"],
                capture_output=True,
                text=True,
                timeout=15,
            )
            if r.returncode == 0:
                return json.loads(r.stdout).get("state") == "merged"
    except Exception:
        pass
    return False


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

        issue = _jira_issue(key)

        if _is_blocked(issue):
            task_lines.append("  *** BLOCKED — requires Rehor team intervention, skipping ***")
            lines.append("\n".join(task_lines))
            continue

        onboarding_label = _get_onboarding_label(issue) if issue else None
        step_from_label = onboarding_label.split(":", 1)[1] if onboarding_label else meta.get("step", "unknown")
        task_lines.append(f"  onboarding_step: {step_from_label} (label: {onboarding_label or 'none'})")

        phase_tickets = meta.get("phase_tickets", {})
        if phase_tickets:
            p1 = phase_tickets.get("phase1", "?")
            p2 = phase_tickets.get("phase2", "?")
            p3 = phase_tickets.get("phase3", "?")
            task_lines.append(f"  phase_tickets: P1={p1} P2={p2} P3={p3}")

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

        labels_with_auto_advance = ("scaffolding-pr", "konflux-mr", "app-interface-mr")
        if step_from_label in labels_with_auto_advance:
            if _any_pr_mr_merged(task, step_from_label):
                task_lines.append(f"  *** PR/MR MERGED — ADVANCE PHASE (current: {step_from_label}) ***")
                has_work = True
            else:
                task_lines.append(f"  waiting for PR/MR merge (current: {step_from_label})")

        lines.append("\n".join(task_lines))

    # Phase 2: Find new onboarding candidates
    candidates = _get_candidates()
    candidate_lines = []
    if candidates:
        for c in candidates:
            candidate_lines.append(_fmt_candidate(c))
        has_work = True

    save_state(
        {
            "active_onboarding_count": len(active_tasks),
            "candidate_count": len(candidates),
        }
    )

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
