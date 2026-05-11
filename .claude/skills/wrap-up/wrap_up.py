#!/usr/bin/env python3
"""Post-merge wrap-up: archive task, transition Jira, notify Slack, delete branches.

Usage: python3 .claude/skills/wrap-up/wrap_up.py <JIRA_KEY> [--dry-run]
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
REPOS_DIR = Path(__file__).resolve().parent.parent.parent.parent / "repos"


def http_request(url, method="GET", body=None, headers=None, timeout=15):
    hdrs = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        print(f"  ERR {method} {url}: {e.code} {body_text[:200]}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  ERR {method} {url}: {e}", file=sys.stderr)
        return None



def get_task(jira_key):
    data = http_request(f"{MEMORY_URL}/api/tasks?exclude_status=archived&limit=50")
    if not data or "items" not in data:
        return None
    for t in data["items"]:
        if t.get("jira_key") == jira_key:
            return t
    return None


def parse_repo_path(url):
    if not url:
        return ""
    parsed = urllib.parse.urlparse(url if "://" in url else f"https://{url}")
    path = parsed.path.lstrip("/").replace(".git", "")
    return path


def get_upstream_info(repo_name):
    try:
        repos = json.loads(PROJECT_REPOS.read_text())
        entry = repos.get(repo_name, {})
        upstream = entry.get("upstream", "")
        host = entry.get("host", "github")
        parsed = urllib.parse.urlparse(upstream if "://" in upstream else f"https://{upstream}")
        hostname = parsed.hostname or ""
        if "gitlab" in hostname:
            host = "gitlab"
        return parse_repo_path(upstream), host
    except Exception:
        return "", "github"


def jira_transition_release_pending(jira_key):
    data = jira_call("jira_get_transitions", {"issue_key": jira_key})
    if not data:
        return False, "failed to get transitions"
    transitions = data if isinstance(data, list) else data.get("transitions", [])
    target = None
    for t in transitions:
        name = t.get("name", "").lower()
        if "release pending" in name:
            target = t
            break
    if not target:
        avail = [t.get("name") for t in transitions]
        return False, f"'Release Pending' not available. Available: {avail}"
    result = jira_call("jira_transition_issue", {
        "issue_key": jira_key,
        "transition_id": str(target["id"]),
    })
    if result is None:
        return False, "transition failed"
    return True, target["name"]


def jira_comment(jira_key, pr_info):
    pr_lines = []
    for p in pr_info:
        repo = p.get("repo", "?")
        num = p.get("number", "?")
        pr_url = p.get("url", "")
        host = p.get("host", "github")
        if pr_url:
            pr_lines.append(f"- [{repo}#{num}]({pr_url})")
        else:
            pr_lines.append(f"- {repo}#{num} ({host})")

    body = (
        f"### PR Merged — Release Pending\n\n"
        f"{''.join(pr_lines) if pr_lines else '(no PR info)'}\n\n"
        f"Changes will be deployed to stage with the next release."
    )
    result = jira_call("jira_add_comment", {
        "issue_key": jira_key,
        "body": body,
    })
    return result is not None


def archive_task(jira_key, summary):
    result = http_request(
        f"{MEMORY_URL}/api/tasks/{jira_key}",
        method="DELETE",
    )
    return result is not None


def slack_notify(jira_key, pr_info):
    pr_links = []
    for p in pr_info:
        pr_url = p.get("url", "")
        repo = p.get("repo", "?")
        num = p.get("number", "?")
        if pr_url:
            pr_links.append(f"<{pr_url}|{repo}#{num}>")
        else:
            pr_links.append(f"{repo}#{num}")
    msg = f"{jira_key} merged → Release Pending. PR: {', '.join(pr_links) if pr_links else '(unknown)'}"
    result = http_request(
        f"{MEMORY_URL}/mcp",
        method="POST",
        body={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "slack_notify",
                "arguments": {
                    "jira_key": jira_key,
                    "event_type": "release_pending",
                    "message": msg,
                },
            },
        },
    )
    if result and "result" in result:
        return True, result["result"]
    return False, str(result)


def delete_remote_branch(repo_name, branch, host, upstream_path):
    if not branch:
        return True, "no branch to delete"
    if host == "gitlab":
        encoded_branch = urllib.parse.quote(branch, safe="")
        encoded_project = urllib.parse.quote(upstream_path, safe="")
        try:
            r = subprocess.run(
                ["glab", "api", f"projects/{encoded_project}/repository/branches/{encoded_branch}",
                 "-X", "DELETE", "--hostname", "gitlab.cee.redhat.com"],
                capture_output=True, text=True, timeout=15,
            )
            out = r.stderr.strip() or r.stdout.strip()
            if r.returncode == 0:
                return True, "deleted"
            if "404" in out or "not found" in out.lower():
                return True, "already gone (auto-deleted on merge)"
            return False, out
        except Exception as e:
            return False, str(e)
    else:
        ref = f"heads/{branch}"
        targets = [f"repos/{upstream_path}/git/refs/{ref}"]
        fork_path = parse_repo_path(
            json.loads(PROJECT_REPOS.read_text()).get(repo_name, {}).get("url", "")
        )
        if fork_path and fork_path != upstream_path:
            targets.append(f"repos/{fork_path}/git/refs/{ref}")
        results = []
        for target in targets:
            try:
                r = subprocess.run(
                    ["gh", "api", target, "-X", "DELETE"],
                    capture_output=True, text=True, timeout=15,
                )
                out = r.stderr.strip() or r.stdout.strip()
                if r.returncode == 0:
                    results.append(f"{target.split('/')[1]}: deleted")
                elif "Not Found" in out or "Reference does not exist" in out:
                    results.append(f"{target.split('/')[1]}: already gone")
                else:
                    results.append(f"{target.split('/')[1]}: {out[:100]}")
            except Exception as e:
                results.append(f"{target.split('/')[1]}: {e}")
        return True, "; ".join(results)


def delete_local_branch(repo_name, branch):
    repo_dir = REPOS_DIR / repo_name
    if not repo_dir.exists():
        return True, "repo dir not cloned locally"
    try:
        r = subprocess.run(
            ["git", "branch", "-D", branch],
            capture_output=True, text=True, timeout=10,
            cwd=str(repo_dir),
        )
        out = r.stderr.strip() or r.stdout.strip()
        if r.returncode == 0:
            return True, "deleted"
        if "not found" in out.lower() or "error: branch" in out.lower():
            return True, "already gone"
        return False, out
    except Exception as e:
        return False, str(e)


def main():
    if len(sys.argv) < 2:
        print("Usage: wrap_up.py <JIRA_KEY> [--dry-run]")
        sys.exit(1)

    jira_key = sys.argv[1]
    dry_run = "--dry-run" in sys.argv

    if dry_run:
        print(f"[DRY RUN] wrap-up for {jira_key}")

    task = get_task(jira_key)
    if not task:
        print(f"ERR: task {jira_key} not found in memory server")
        sys.exit(1)

    repo = task.get("repo", "")
    branch = task.get("branch", "")
    meta = task.get("metadata") or {}
    pr_info = meta.get("prs", [])

    if not pr_info and task.get("pr_number"):
        _, host = get_upstream_info(repo)
        pr_info = [{"repo": repo, "number": task["pr_number"], "url": task.get("pr_url", ""), "host": host}]

    print(f"WRAP-UP {jira_key}")
    print(f"  repo: {repo}")
    print(f"  branch: {branch}")
    print(f"  PRs: {json.dumps(pr_info)}")
    print()

    # 1. Transition Jira to "Release Pending"
    print("1. Jira transition → Release Pending")
    if dry_run:
        print("  [skip]")
    else:
        ok, detail = jira_transition_release_pending(jira_key)
        print(f"  {'OK' if ok else 'FAIL'}: {detail}")

    # 2. Post Jira comment
    print("2. Jira comment")
    if dry_run:
        print("  [skip]")
    else:
        ok = jira_comment(jira_key, pr_info)
        print(f"  {'OK' if ok else 'FAIL'}")

    # 3. Archive task
    print("3. Archive task")
    if dry_run:
        print("  [skip]")
    else:
        ok = archive_task(jira_key, task.get("summary", ""))
        print(f"  {'OK' if ok else 'FAIL'}")

    # 4. Slack notification
    print("4. Slack notify (release_pending)")
    if dry_run:
        print("  [skip]")
    else:
        ok, detail = slack_notify(jira_key, pr_info)
        print(f"  {'OK' if ok else 'FAIL'}: {detail}")

    # 5. Delete remote branch
    all_repos = set()
    if repo:
        all_repos.add(repo)
    for r in meta.get("repos", []):
        all_repos.add(r)

    print("5. Delete remote branch(es)")
    for r in all_repos:
        upstream_path, host = get_upstream_info(r)
        if not upstream_path:
            print(f"  {r}: no upstream path, skip")
            continue
        if dry_run:
            print(f"  {r} ({host}): {upstream_path}/refs/heads/{branch} [skip]")
        else:
            ok, detail = delete_remote_branch(r, branch, host, upstream_path)
            print(f"  {r}: {'OK' if ok else 'FAIL'} {detail}")

    # 6. Delete local branch
    print("6. Delete local branch(es)")
    for r in all_repos:
        if dry_run:
            print(f"  {r}: git branch -D {branch} [skip]")
        else:
            ok, detail = delete_local_branch(r, branch)
            print(f"  {r}: {'OK' if ok else 'FAIL'} {detail}")

    print()
    print(f"DONE — {jira_key} wrapped up")


if __name__ == "__main__":
    main()
