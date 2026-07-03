"""GL MR status checks — pipelines, conflicts, unresolved threads, notes.

Fetches active tasks, checks GitLab MRs, classifies into action buckets.
Outputs JSON protocol: start if actionable items found, skip if all clean.
"""

import json
import subprocess

from common import (
    INSTANCE_ID,
    fmt_comments,
    fmt_task_header,
    get_capacity,
    get_task_prs,
    get_tasks,
    is_bot_author,
    load_state,
    output_result,
    save_state,
    upstream_repo,
)


def gl_mr(project_path, num):
    """Fetch GL MR details via glab CLI."""
    encoded = project_path.replace("/", "%2F")
    try:
        r = subprocess.run(
            ["glab", "api", f"projects/{encoded}/merge_requests/{num}", "--hostname", "gitlab.cee.redhat.com"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return json.loads(r.stdout) if r.returncode == 0 else None
    except Exception:
        return None


def gl_mr_notes(project_path, num):
    """Fetch GL MR notes (non-system)."""
    encoded = project_path.replace("/", "%2F")
    try:
        r = subprocess.run(
            [
                "glab",
                "api",
                f"projects/{encoded}/merge_requests/{num}/notes?per_page=50&sort=asc",
                "--hostname",
                "gitlab.cee.redhat.com",
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if r.returncode == 0:
            return [
                {
                    "a": n.get("author", {}).get("username", "?"),
                    "t": n.get("created_at", "")[:16],
                    "b": n.get("body", ""),
                }
                for n in json.loads(r.stdout)
                if not n.get("system")
            ]
    except Exception:
        pass
    return []


def classify_gl(mr):
    """Classify a GL MR into (state, issues_list)."""
    state = mr.get("state", "unknown")
    if state == "merged":
        return "MERGED", ["merged"]
    if state == "closed":
        return "CLOSED", ["closed"]
    issues = []
    if mr.get("has_conflicts"):
        issues.append("conflict")
    pipe = (mr.get("head_pipeline") or {}).get("status", "")
    if pipe == "failed":
        issues.append("ci_fail")
    if not mr.get("blocking_discussions_resolved", True):
        issues.append("unresolved_threads")
    return state.upper(), issues


def enrich_gl(task):
    """Enrich a task with GL MR data. Returns dict or None if no GL MRs."""
    prs_info = get_task_prs(task)
    gl_mrs = [p for p in prs_info if p.get("host") == "gitlab"]
    if not gl_mrs:
        return None

    mr_results = []
    mr_notes_all = []
    all_issues = []
    repo = task.get("repo", "")

    for p in gl_mrs:
        mr_repo = p.get("repo", repo)
        mr_num = p.get("number")
        if not mr_num:
            continue
        up, _ = upstream_repo(mr_repo)
        if not up:
            continue
        data = gl_mr(up, mr_num)
        if not data:
            continue
        state, issues = classify_gl(data)
        mr_results.append(
            {
                "repo": mr_repo,
                "num": mr_num,
                "host": "gitlab",
                "state": state,
                "issues": issues,
                "data": data,
            }
        )
        all_issues.extend(issues)
        mr_notes_all.extend(gl_mr_notes(up, mr_num))

    if not mr_results:
        return None

    return {
        "task": task,
        "prs": mr_results,
        "mr_notes": mr_notes_all,
        "issues": all_issues,
    }


def has_new_feedback(enriched):
    """Check if there's new non-bot MR feedback since last_addressed."""
    last_addr = enriched["task"].get("last_addressed", "")
    for c in enriched["mr_notes"]:
        if is_bot_author(c.get("a", "?")):
            continue
        ct = c.get("t", "")[:16]
        if not last_addr or ct > last_addr[:16]:
            return True
    return False


def fmt_task(enriched):
    """Format a task with GL MR details."""
    lines = fmt_task_header(enriched["task"])
    for p in enriched["prs"]:
        issue_str = ",".join(p["issues"]) if p["issues"] else "clean"
        lines.append(f"  MR {p['repo']}!{p['num']} (gitlab) state={p['state']} [{issue_str}]")
    last_addr = enriched["task"].get("last_addressed")
    if enriched["mr_notes"]:
        lines.append(fmt_comments(enriched["mr_notes"], "mr_notes", since=last_addr))
    return "\n".join(lines)


def main():
    if not INSTANCE_ID:
        output_result("error", "BOT_INSTANCE_ID not set")
        return

    tasks = get_tasks()
    active_n, max_n = get_capacity()
    active = [t for t in tasks if t.get("status") in ("in_progress", "pr_open", "pr_changes")]

    if not active:
        output_result("skip", f"GL MR status: no active tasks (capacity {active_n}/{max_n})")
        return

    enriched = [e for t in active if (e := enrich_gl(t)) is not None]

    if not enriched:
        output_result("skip", f"GL MR status: no GL MRs to check ({len(active)} active tasks)")
        return

    merged, closed, ci_fail, conflict, feedback, clean = [], [], [], [], [], []
    for e in enriched:
        issues = e["issues"]
        if "merged" in issues:
            merged.append(e)
        elif "closed" in issues:
            closed.append(e)
        elif any(i.startswith("ci_fail") for i in issues):
            ci_fail.append(e)
        elif "conflict" in issues:
            conflict.append(e)
        elif "unresolved_threads" in issues:
            feedback.append(e)
        elif has_new_feedback(e):
            feedback.append(e)
        else:
            clean.append(e)

    lines = [f"## GL MR Status ({len(enriched)} MRs checked)"]
    lines.append("")

    actionable = 0
    for label, bucket in [
        ("MERGED", merged),
        ("CLOSED", closed),
        ("CI FAILING", ci_fail),
        ("CONFLICTS", conflict),
        ("FEEDBACK", feedback),
    ]:
        if bucket:
            lines.append(f"### {label} ({len(bucket)})")
            for e in bucket:
                lines.append(fmt_task(e))
                lines.append("")
            actionable += len(bucket)

    if clean:
        lines.append(f"### CLEAN ({len(clean)})")
        for e in clean:
            t = e["task"]
            lines.append(f"  {t.get('external_key', '?')} [{t.get('status', '?')}] {t.get('repo', '?')}")
        lines.append("")

    prev = load_state()
    prev_actionable = prev.get("has_actionable", False)
    save_state(
        {
            "gl_mr": {
                "merged": len(merged),
                "closed": len(closed),
                "ci_fail": len(ci_fail),
                "conflicts": len(conflict),
                "feedback": len(feedback),
                "clean": len(clean),
            },
            "has_actionable": prev_actionable or actionable > 0,
        }
    )

    content = "\n".join(lines)
    output_result("start" if actionable > 0 else "skip", content)


if __name__ == "__main__":
    main()
