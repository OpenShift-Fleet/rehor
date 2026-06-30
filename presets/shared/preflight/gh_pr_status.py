"""GH PR status checks — CI, conflicts, reviews, comments.

Fetches active tasks, checks GitHub PRs, classifies into action buckets.
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
    output_result,
    save_state,
    upstream_repo,
)


def gh_pr(owner_repo, num):
    """Fetch GH PR details via gh CLI."""
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
                "state,mergeable,statusCheckRollup,reviewDecision,reviews,url,title,isDraft",
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return json.loads(r.stdout) if r.returncode == 0 else None
    except Exception:
        return None


def gh_pr_comments(owner_repo, num):
    """Fetch GH PR comments (inline review + general issue comments)."""
    comments = []
    for ep in [
        f"repos/{owner_repo}/pulls/{num}/comments",
        f"repos/{owner_repo}/issues/{num}/comments",
    ]:
        try:
            r = subprocess.run(
                ["gh", "api", ep, "--jq", ".[] | {a: .user.login, t: .created_at, b: .body}"],
                capture_output=True,
                text=True,
                timeout=15,
            )
            if r.returncode == 0 and r.stdout.strip():
                for line in r.stdout.strip().split("\n"):
                    try:
                        comments.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
        except Exception:
            pass
    return comments


def classify_gh(pr):
    """Classify a GH PR into (state, issues_list)."""
    state = pr.get("state", "UNKNOWN")
    if state == "MERGED":
        return "MERGED", ["merged"]
    if state == "CLOSED":
        return "CLOSED", ["closed"]
    issues = []
    if pr.get("mergeable") == "CONFLICTING":
        issues.append("conflict")
    checks = pr.get("statusCheckRollup") or []
    failed = [c.get("name", "?") for c in checks if c.get("conclusion") == "FAILURE"]
    if failed:
        issues.append(f"ci_fail:{','.join(failed)}")
    if pr.get("reviewDecision") == "CHANGES_REQUESTED":
        issues.append("changes_requested")
    for rv in pr.get("reviews") or []:
        rstate = rv.get("state", "")
        author = rv.get("author", {}).get("login", "?")
        if rstate == "CHANGES_REQUESTED":
            issues.append(f"review:{author}")
        elif rstate == "COMMENTED" and len((rv.get("body") or "").strip()) > 20:
            issues.append(f"review_comment:{author}")
    return state, issues


def enrich_gh(task):
    """Enrich a task with GH PR data. Returns dict or None if no GH PRs."""
    prs_info = get_task_prs(task)
    gh_prs = [p for p in prs_info if p.get("host", "github") == "github"]
    if not gh_prs:
        return None

    pr_results = []
    pr_comments = []
    all_issues = []
    repo = task.get("repo", "")

    for p in gh_prs:
        pr_repo = p.get("repo", repo)
        pr_num = p.get("number")
        if not pr_num:
            continue
        up, _ = upstream_repo(pr_repo)
        if not up:
            continue
        data = gh_pr(up, pr_num)
        if not data:
            continue
        state, issues = classify_gh(data)
        pr_results.append(
            {
                "repo": pr_repo,
                "num": pr_num,
                "host": "github",
                "state": state,
                "issues": issues,
                "data": data,
            }
        )
        all_issues.extend(issues)
        pr_comments.extend(gh_pr_comments(up, pr_num))
        for rv in data.get("reviews") or []:
            body = (rv.get("body") or "").strip()
            if body:
                pr_comments.append(
                    {
                        "a": rv.get("author", {}).get("login", "?"),
                        "t": rv.get("submittedAt", "")[:16],
                        "b": f"[REVIEW {rv.get('state', '?')}] {body}",
                    }
                )

    if not pr_results:
        return None

    return {
        "task": task,
        "prs": pr_results,
        "pr_comments": pr_comments,
        "issues": all_issues,
    }


def has_new_feedback(enriched):
    """Check if there's new non-bot PR feedback since last_addressed."""
    last_addr = enriched["task"].get("last_addressed", "")
    for c in enriched["pr_comments"]:
        if is_bot_author(c.get("a", "?")):
            continue
        ct = c.get("t", "")[:16]
        if not last_addr or ct > last_addr[:16]:
            return True
    return False


def fmt_task(enriched):
    """Format a task with GH PR details."""
    lines = fmt_task_header(enriched["task"])
    for p in enriched["prs"]:
        issue_str = ",".join(p["issues"]) if p["issues"] else "clean"
        lines.append(f"  PR {p['repo']}#{p['num']} (github) state={p['state']} [{issue_str}]")
    last_addr = enriched["task"].get("last_addressed")
    if enriched["pr_comments"]:
        lines.append(fmt_comments(enriched["pr_comments"], "pr_comments", since=last_addr))
    return "\n".join(lines)


def main():
    if not INSTANCE_ID:
        output_result("error", "BOT_INSTANCE_ID not set")
        return

    tasks = get_tasks()
    active_n, max_n = get_capacity()
    active = [t for t in tasks if t.get("status") in ("in_progress", "pr_open", "pr_changes")]

    if not active:
        output_result("skip", f"GH PR status: no active tasks (capacity {active_n}/{max_n})")
        return

    enriched = [e for t in active if (e := enrich_gh(t)) is not None]

    if not enriched:
        output_result("skip", f"GH PR status: no GH PRs to check ({len(active)} active tasks)")
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
        elif any(
            i in ("changes_requested",) or i.startswith("review:") or i.startswith("review_comment:") for i in issues
        ):
            feedback.append(e)
        elif has_new_feedback(e):
            feedback.append(e)
        else:
            clean.append(e)

    lines = [f"## GH PR Status ({len(enriched)} PRs checked)"]
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

    save_state(
        {
            "gh_pr": {
                "merged": len(merged),
                "closed": len(closed),
                "ci_fail": len(ci_fail),
                "conflicts": len(conflict),
                "feedback": len(feedback),
                "clean": len(clean),
            },
            "has_actionable": actionable > 0,
        }
    )

    content = "\n".join(lines)
    output_result("start" if actionable > 0 else "skip", content)


if __name__ == "__main__":
    main()
