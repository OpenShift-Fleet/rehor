#!/usr/bin/env python3
"""Pre-triage data gatherer. Output = caveman-compressed markdown.

Runs as !`command` in SKILL.md. Gathers tasks, PR statuses, Jira comments,
PR comments, capacity. Groups by action bucket.
"""

import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from jira_mcp import jira_call

MEMORY_URL = os.environ.get("BOT_MEMORY_URL", "http://localhost:8080").rstrip("/mcp").rstrip("/")
PROJECT_REPOS = Path(__file__).resolve().parent.parent.parent.parent / "project-repos.json"


def http_get(url, headers=None, timeout=10):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f"ERR GET {url}: {e}", file=sys.stderr)
        return None


def get_tasks():
    data = http_get(f"{MEMORY_URL}/api/tasks?exclude_status=archived&limit=50")
    return data.get("items", []) if data else []


def get_capacity():
    data = http_get(f"{MEMORY_URL}/api/tasks?exclude_status=archived&exclude_status=done&exclude_status=paused&limit=50")
    if data and "items" in data:
        n = len([t for t in data["items"] if t.get("status") in ("in_progress", "pr_open", "pr_changes")])
        return n, 10
    return 0, 10


def gh_pr(owner_repo, num):
    try:
        r = subprocess.run(
            ["gh", "pr", "view", str(num), "--repo", owner_repo,
             "--json", "state,mergeable,statusCheckRollup,reviewDecision,reviews,url,title,isDraft"],
            capture_output=True, text=True, timeout=15)
        return json.loads(r.stdout) if r.returncode == 0 else None
    except Exception:
        return None


def gl_mr(project_path, num):
    encoded = project_path.replace("/", "%2F")
    try:
        r = subprocess.run(
            ["glab", "api", f"projects/{encoded}/merge_requests/{num}",
             "--hostname", "gitlab.cee.redhat.com"],
            capture_output=True, text=True, timeout=15)
        return json.loads(r.stdout) if r.returncode == 0 else None
    except Exception:
        return None


def gh_pr_comments(owner_repo, num):
    comments = []
    for ep in [f"repos/{owner_repo}/pulls/{num}/comments",
               f"repos/{owner_repo}/issues/{num}/comments"]:
        try:
            r = subprocess.run(
                ["gh", "api", ep, "--jq",
                 '.[] | {a: .user.login, t: .created_at, b: .body}'],
                capture_output=True, text=True, timeout=15)
            if r.returncode == 0 and r.stdout.strip():
                for line in r.stdout.strip().split("\n"):
                    try:
                        comments.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
        except Exception:
            pass
    return comments


def gl_mr_notes(project_path, num):
    encoded = project_path.replace("/", "%2F")
    try:
        r = subprocess.run(
            ["glab", "api", f"projects/{encoded}/merge_requests/{num}/notes?per_page=50&sort=asc",
             "--hostname", "gitlab.cee.redhat.com"],
            capture_output=True, text=True, timeout=15)
        if r.returncode == 0:
            return [{"a": n.get("author", {}).get("username", "?"),
                      "t": n.get("created_at", "")[:16],
                      "b": n.get("body", "")}
                     for n in json.loads(r.stdout) if not n.get("system")]
    except Exception:
        pass
    return []


def jira_issue(key):
    return jira_call("jira_get_issue", {
        "issue_key": key,
        "fields": "summary,status,assignee,labels,issuelinks",
        "comment_limit": 10,
    })


def _parse_repo_path(url):
    if ":" in url and "@" in url:
        return url.split(":")[-1].replace(".git", "")
    return "/".join(url.split("/")[-2:]).replace(".git", "")


def upstream_repo(repo_name):
    try:
        repos = json.loads(PROJECT_REPOS.read_text())
        entry = repos.get(repo_name, {})
        up = entry.get("upstream", "")
        parsed = urllib.parse.urlparse(up if "://" in up else f"ssh://{up}")
        host = parsed.hostname or ""
        if host == "github.com":
            return _parse_repo_path(up), "github"
        if host in ("gitlab.com", "gitlab.cee.redhat.com"):
            return _parse_repo_path(up), "gitlab"
    except Exception:
        pass
    return "", entry.get("host", "github") if 'entry' in dir() else "github"


def fmt_comments(comments, label, since=None):
    if not comments:
        return f"  {label}: (none)"
    if since:
        since_prefix = since[:16]
        comments = [c for c in comments
                    if (c.get("t", c.get("created", ""))[:16]) > since_prefix]
    if not comments:
        return f"  {label}: (none since last_addressed)"
    comments = list(reversed(comments))
    lines = [f"  {label} ({len(comments)}, newest first):"]
    for c in comments:
        author = c.get("a", c.get("author", {}).get("displayName", "?") if isinstance(c.get("author"), dict) else c.get("author", "?"))
        t = c.get("t", c.get("created", ""))[:16]
        body = c.get("b", c.get("body", ""))
        lines.append(f"    [{t}] {author}:")
        for bl in body.strip().split("\n"):
            lines.append(f"      {bl}")
    return "\n".join(lines)


def classify_gh(pr):
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
    for r in (pr.get("reviews") or []):
        rstate = r.get("state", "")
        author = r.get("author", {}).get("login", "?")
        if rstate == "CHANGES_REQUESTED":
            issues.append(f"review:{author}")
        elif rstate == "COMMENTED" and len((r.get("body") or "").strip()) > 20:
            issues.append(f"review_comment:{author}")
    return state, issues


def classify_gl(mr):
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


def enrich(task):
    repo = task.get("repo", "")
    meta = task.get("metadata") or {}
    prs_info = meta.get("prs", [])
    if not prs_info and task.get("pr_number"):
        _, host = upstream_repo(repo)
        prs_info = [{"repo": repo, "number": task["pr_number"], "host": host}]

    pr_results = []
    pr_comments = []
    all_issues = []

    for p in prs_info:
        pr_repo, pr_num, pr_host = p.get("repo", repo), p.get("number"), p.get("host", "github")
        if not pr_num:
            continue
        up, dh = upstream_repo(pr_repo)
        host = pr_host or dh

        if host == "github" and up:
            data = gh_pr(up, pr_num)
            if data:
                state, issues = classify_gh(data)
                pr_results.append({"repo": pr_repo, "num": pr_num, "host": host, "state": state, "issues": issues, "data": data})
                all_issues.extend(issues)
                pr_comments.extend(gh_pr_comments(up, pr_num))
                for rv in (data.get("reviews") or []):
                    body = (rv.get("body") or "").strip()
                    if body:
                        pr_comments.append({
                            "a": rv.get("author", {}).get("login", "?"),
                            "t": rv.get("submittedAt", "")[:16],
                            "b": f"[REVIEW {rv.get('state', '?')}] {body}",
                        })
        elif host == "gitlab" and up:
            data = gl_mr(up, pr_num)
            if data:
                state, issues = classify_gl(data)
                pr_results.append({"repo": pr_repo, "num": pr_num, "host": host, "state": state, "issues": issues, "data": data})
                all_issues.extend(issues)
                pr_comments.extend(gl_mr_notes(up, pr_num))

    jira = jira_issue(task.get("jira_key", ""))
    jira_comments = []
    if jira:
        jira_comments = (jira.get("fields", {}).get("comment", {}).get("comments") or [])[-10:]

    return {"task": task, "prs": pr_results, "pr_comments": pr_comments,
            "jira": jira, "jira_comments": jira_comments, "issues": all_issues}


def fmt_task(e):
    t = e["task"]
    key, status, repo = t.get("jira_key", "?"), t.get("status", "?"), t.get("repo", "?")
    meta = t.get("metadata") or {}
    lines = [f"{key} [{status}] {repo}"]
    if t.get("title"):
        lines.append(f"  title: {t['title']}")
    if t.get("summary"):
        lines.append(f"  summary: {t['summary'][:150]}")
    if meta.get("last_step"):
        lines.append(f"  last_step: {meta['last_step']}")
    if t.get("last_addressed"):
        lines.append(f"  last_addressed: {t['last_addressed']}")

    for p in e["prs"]:
        issue_str = ",".join(p["issues"]) if p["issues"] else "clean"
        lines.append(f"  PR {p['repo']}#{p['num']} ({p['host']}) state={p['state']} [{issue_str}]")

    last_addr = t.get("last_addressed")
    if e["pr_comments"]:
        lines.append(fmt_comments(e["pr_comments"], "pr_comments", since=last_addr))
    if e["jira"]:
        fields = e["jira"].get("fields", {})
        lines.append(f"  jira_status: {fields.get('status', {}).get('name', '?')}")
        labels = fields.get("labels", [])
        if labels:
            lines.append(f"  labels: {','.join(labels)}")
        links = fields.get("issuelinks", [])
        for lk in links[:5]:
            lt = lk.get("type", {}).get("name", "?")
            linked = lk.get("inwardIssue") or lk.get("outwardIssue", {})
            if linked:
                lines.append(f"  link: {lt} {linked.get('key','?')} [{linked.get('fields',{}).get('status',{}).get('name','?')}]")
        jc = [{"author": c.get("author", {}).get("displayName", "?"),
               "t": c.get("created", "")[:16],
               "b": c.get("body", "")} for c in e["jira_comments"]]
        lines.append(fmt_comments(jc, "jira_comments", since=last_addr))
    else:
        lines.append("  [jira unavailable — use jira_get_issue]")

    return "\n".join(lines)


def _is_bot_author(author):
    if not author or author == "?":
        return False
    a = author.lower()
    return "[bot]" in a or a.endswith("-bot") or a in (
        "github-actions", "dependabot", "renovate",
    )


def has_new_pr_feedback(e):
    last_addr = e["task"].get("last_addressed", "")
    for c in e["pr_comments"]:
        author = c.get("a", "?")
        if _is_bot_author(author):
            continue
        ct = c.get("t", "")[:16]
        if not last_addr or ct > last_addr[:16]:
            return True
    return False


def has_new_jira_feedback(e):
    last_addr = e["task"].get("last_addressed", "")
    for c in e["jira_comments"]:
        ct = c.get("created", "")[:16]
        if last_addr and ct > last_addr[:16]:
            body = c.get("body", "")
            if not ("### " in body or "| " in body or "PR:" in body):
                return True
    return False


def main():
    tasks = get_tasks()
    active_n, max_n = get_capacity()

    active = [t for t in tasks if t.get("status") in ("in_progress", "pr_open", "pr_changes")]
    paused = [t for t in tasks if t.get("status") == "paused"]
    done = [t for t in tasks if t.get("status") == "done"]

    print(f"TRIAGE | capacity: {active_n}/{max_n} | active: {len(active)} | paused: {len(paused)} | done: {len(done)}")
    print()

    if not active:
        print("NO ACTIVE TASKS -> Priority 2 (new Jira work)")
        if done:
            print(f"done pending archival: {','.join(t.get('jira_key','?') for t in done)}")
        if paused:
            print(f"paused: {','.join(t.get('jira_key','?') for t in paused)}")
        return

    enriched = [enrich(t) for t in active]

    merged, closed, ci_fail, conflict, feedback, interrupted, clean = [], [], [], [], [], [], []

    for e in enriched:
        issues = e["issues"]
        t = e["task"]
        meta = t.get("metadata") or {}

        if "merged" in issues:
            merged.append(e)
        elif "closed" in issues:
            closed.append(e)
        elif any(i.startswith("ci_fail") for i in issues):
            ci_fail.append(e)
        elif "conflict" in issues:
            conflict.append(e)
        elif any(i in ("changes_requested", "unresolved_threads") or i.startswith("review:") or i.startswith("review_comment:") for i in issues):
            feedback.append(e)
        elif t.get("status") == "in_progress" and not t.get("pr_number") and not meta.get("prs"):
            interrupted.append(e)
        elif has_new_pr_feedback(e):
            feedback.append(e)
        elif has_new_jira_feedback(e):
            feedback.append(e)
        else:
            clean.append(e)

    if merged:
        print(f"== MERGED ({len(merged)}) — archive + transition ==")
        for e in merged:
            print(fmt_task(e))
            print()

    if closed:
        print(f"== CLOSED ({len(closed)}) — PR closed without merge, investigate + archive or reopen ==")
        for e in closed:
            print(fmt_task(e))
            print()

    if ci_fail:
        print(f"== CI FAILING ({len(ci_fail)}) — fix + push ==")
        for e in ci_fail:
            print(fmt_task(e))
            print()

    if conflict:
        print(f"== CONFLICTS ({len(conflict)}) — rebase ==")
        for e in conflict:
            print(fmt_task(e))
            print()

    if feedback:
        print(f"== FEEDBACK ({len(feedback)}) — respond/impl ==")
        for e in feedback:
            print(fmt_task(e))
            print()

    if interrupted:
        print(f"== INTERRUPTED ({len(interrupted)}) — resume ==")
        for e in interrupted:
            print(fmt_task(e))
            print()

    if clean:
        print(f"== CLEAN ({len(clean)}) — no action ==")
        for e in clean:
            t = e["task"]
            print(f"  {t.get('jira_key','?')} [{t.get('status','?')}] {t.get('repo','?')}")
        print()

    if paused:
        print(f"PAUSED: {' | '.join(t.get('jira_key','?')+':'+str(t.get('paused_reason','')) for t in paused)}")
    if done:
        print(f"DONE (archive?): {','.join(t.get('jira_key','?') for t in done)}")

    total = len(merged) + len(closed) + len(ci_fail) + len(conflict) + len(feedback) + len(interrupted)
    if total == 0:
        print("-> all clean -> Priority 2")
    else:
        print(f"-> {total} task(s) need work. Top bucket first. ONE/cycle.")


if __name__ == "__main__":
    main()
