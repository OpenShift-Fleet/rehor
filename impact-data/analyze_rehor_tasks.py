#!/usr/bin/env python3
"""Analyze Rehor task records and references to Jira/GitHub/GitLab work."""

import argparse
import csv
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_API = "https://devbot-memory-server-platform-frontend-ai-dev-stage.apps.rosa.hcmais01ue1.s9m2.p3.openshiftapps.com/api"
JIRA_RE = re.compile(r"\b[A-Z][A-Z0-9]+-\d+\b(?!-\d)")
GH_RE = re.compile(r"https://github\.com/[^\s\]\)>,]+/pull/\d+")
GL_RE = re.compile(r"https://gitlab\.cee\.redhat\.com/[^\s\]\)>,]+/merge_requests/\d+")


def get_json(api, path, params):
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(f"{api.rstrip('/')}/{path}?{query}")
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read())


def fetch_tasks(api):
    tasks = []
    offset = 0
    while True:
        page = get_json(api, "tasks", {"limit": 100, "offset": offset})
        batch = page.get("items", [])
        tasks.extend(batch)
        offset += len(batch)
        print(f"[task-analysis] fetched {offset}/{page.get('total', offset)} tasks", flush=True)
        if not batch or offset >= page.get("total", offset):
            return tasks


def refs(task):
    blob = json.dumps(task, ensure_ascii=False, default=str)
    return {
        "jira_keys": sorted(set(JIRA_RE.findall(blob))),
        "github_prs": sorted(set(GH_RE.findall(blob))),
        "gitlab_mrs": sorted(set(GL_RE.findall(blob))),
    }


def artifact_types(task):
    return sorted({item.get("type", "unknown") for item in task.get("artifacts", []) if isinstance(item, dict)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output-dir", default="impact-data/task-analysis")
    parser.add_argument("--api", default=DEFAULT_API)
    args = parser.parse_args()

    tasks = fetch_tasks(args.api)
    rows = []
    jira_keys, github_prs, gitlab_mrs = set(), set(), set()
    for task in tasks:
        found = refs(task)
        jira_keys.update(found["jira_keys"])
        github_prs.update(found["github_prs"])
        gitlab_mrs.update(found["gitlab_mrs"])
        rows.append({
            "task_id": task.get("id", ""),
            "external_key": task.get("external_key", ""),
            "source_type": task.get("source_type", ""),
            "instance_id": task.get("instance_id", ""),
            "status": task.get("status", ""),
            "repo": task.get("repo", ""),
            "branch": task.get("branch", ""),
            "title": task.get("title", "") or "",
            "jira_keys": " | ".join(found["jira_keys"]),
            "github_prs": " | ".join(found["github_prs"]),
            "gitlab_mrs": " | ".join(found["gitlab_mrs"]),
            "artifact_types": " | ".join(artifact_types(task)),
            "artifact_count": len(task.get("artifacts", [])),
            "metadata_keys": " | ".join(sorted((task.get("metadata") or {}).keys())),
        })

    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    with (output / "task-references.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]) if rows else ["task_id"])
        writer.writeheader()
        writer.writerows(rows)

    with_jira = sum(bool(row["jira_keys"]) for row in rows)
    with_pr = sum(bool(row["github_prs"] or row["gitlab_mrs"]) for row in rows)
    unresolved = sum(not row["jira_keys"] and not row["github_prs"] and not row["gitlab_mrs"] for row in rows)
    summary = {
        "task_count": len(tasks),
        "tasks_with_jira_reference": with_jira,
        "tasks_with_pr_or_mr_reference": with_pr,
        "tasks_with_jira_and_pr_or_mr": sum(bool(row["jira_keys"] and (row["github_prs"] or row["gitlab_mrs"])) for row in rows),
        "tasks_without_detected_external_reference": unresolved,
        "unique_jira_keys": sorted(jira_keys),
        "unique_github_prs": sorted(github_prs),
        "unique_gitlab_mrs": sorted(gitlab_mrs),
        "unique_jira_count": len(jira_keys),
        "unique_github_pr_count": len(github_prs),
        "unique_gitlab_mr_count": len(gitlab_mrs),
    }
    (output / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    (output / "summary.md").write_text(
        "# Rehor Task Reference Analysis\n\n"
        f"- Tasks: **{summary['task_count']}**\n"
        f"- Tasks with Jira reference: **{with_jira}**\n"
        f"- Tasks with PR/MR reference: **{with_pr}**\n"
        f"- Tasks with both Jira and PR/MR references: **{summary['tasks_with_jira_and_pr_or_mr']}**\n"
        f"- Tasks without detected external reference: **{unresolved}**\n"
        f"- Unique Jira keys: **{len(jira_keys)}**\n"
        f"- Unique GitHub PRs: **{len(github_prs)}**\n"
        f"- Unique GitLab MRs: **{len(gitlab_mrs)}**\n"
    )
    print(output)


if __name__ == "__main__":
    main()
