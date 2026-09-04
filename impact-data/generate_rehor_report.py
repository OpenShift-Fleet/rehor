#!/usr/bin/env python3
"""Render report.md.j2 from one Rehor collector run."""

import argparse
import json
import re
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined


def load(run: Path, name: str, default):
    path = run / name
    return json.loads(path.read_text()) if path.exists() else default


def identity(activity, key):
    data = activity.get("bot_cli_identity", {}).get(key, {}).get("data", {})
    return data.get("login") or data.get("username") or "unavailable"


def build_context(run: Path):
    manifest = load(run, "manifest.json", {})
    jira = load(run, "jira.json", {})
    memory = load(run, "memory.json", {})
    activity = load(run, "git-activity.json", {})
    inventory = load(run, "app-interface.json", {})
    reconciliation = load(run, "reconciliation.json", {})
    tasks = memory.get("tasks", [])
    cycles = memory.get("cycle_runs", [])
    instances = []
    for source in memory.get("instances", []):
        instance_id = source.get("instance_id", "")
        owned = [task for task in tasks if task.get("instance_id") == instance_id]
        jira_linked = sum(
            bool(re.search(r"\b[A-Z][A-Z0-9]+-\d+\b(?!-\d)", json.dumps(task, default=str))) for task in owned
        )
        pr_linked = sum("/pull/" in json.dumps(task) or "merge_requests/" in json.dumps(task) for task in owned)
        instances.append(
            {
                "name": instance_id,
                "tasks": len({task.get("id") for task in owned}),
                "jira_linked": jira_linked,
                "non_jira": len(owned) - jira_linked,
                "pr_linked": pr_linked,
                "repos": len({task.get("repo") for task in owned if task.get("repo")}),
                "cycles": sum(cycle.get("instance_id") == instance_id for cycle in cycles),
            }
        )
    gh = [
        item for page in activity.get("github", []) if page.get("ok") for item in page.get("data", {}).get("items", [])
    ]
    gl = [item for page in activity.get("gitlab", []) if page.get("ok") for item in page.get("data", [])]
    jira_completed = sum(
        issue.get("fields", {}).get("status", {}).get("statusCategory", {}).get("key") == "done"
        or bool(issue.get("fields", {}).get("resolution"))
        for issue in jira.get("issues", [])
    )
    gh_merged = sum(bool(item.get("pull_request", {}).get("merged_at")) for item in gh)
    gh_closed_unmerged = sum(
        item.get("state") == "closed" and not item.get("pull_request", {}).get("merged_at") for item in gh
    )
    gl_merged = sum(item.get("state") == "merged" or bool(item.get("merged_at")) for item in gl)
    gl_closed_unmerged = sum(item.get("state") == "closed" and not item.get("merged_at") for item in gl)
    merge_decisions = gh_merged + gh_closed_unmerged + gl_merged + gl_closed_unmerged
    return {
        "run_id": manifest.get("run_id", run.name),
        "generated_at": manifest.get("generated_at", "unknown"),
        "jira_count": len(jira.get("issues", [])),
        "task_count": len(tasks),
        "instance_count": len(memory.get("instances", [])),
        "cycle_count": len(cycles),
        "gh_count": len(gh),
        "gl_count": len(gl),
        "jira_completed": jira_completed,
        "gh_merged": gh_merged,
        "gh_closed_unmerged": gh_closed_unmerged,
        "gl_merged": gl_merged,
        "gl_closed_unmerged": gl_closed_unmerged,
        "merge_decisions": merge_decisions,
        "merge_acceptance_pct": round(100 * (gh_merged + gl_merged) / merge_decisions, 1) if merge_decisions else None,
        "cost_count": len(memory.get("costs", {}).get("items", [])),
        "cost_summary": memory.get("analytics", {}).get("summary", {}),
        "canonical_count": reconciliation.get("canonical_identity_count", "unknown"),
        "canonical_jira_count": reconciliation.get("canonical_jira_identity_count", "unknown"),
        "unresolved_count": reconciliation.get("canonical_unresolved_identity_count", "unknown"),
        "missing_filter_count": len(reconciliation.get("task_jira_keys_missing_from_filter", [])),
        "missing_task_count": len(reconciliation.get("jira_keys_missing_from_tasks", [])),
        "labels": reconciliation.get("candidate_bot_labels_in_filter", {}),
        "instances": instances,
        "bot_github": identity(activity, "github"),
        "bot_gitlab": identity(activity, "gitlab"),
        "inventory": inventory,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("-o", "--output", type=Path)
    args = parser.parse_args()
    context = build_context(args.run)
    environment = Environment(
        loader=FileSystemLoader(Path(__file__).parent),
        undefined=StrictUndefined,
        autoescape=False,
        keep_trailing_newline=True,
    )
    output = args.output or args.run / "report.md"
    output.write_text(environment.get_template("report.md.j2").render(**context))
    print(output)


if __name__ == "__main__":
    main()
