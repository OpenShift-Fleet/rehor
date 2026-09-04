#!/usr/bin/env python3
"""Find Jira projects, labels, and boards missing from saved filter coverage."""

import json
import re
import urllib.parse
from collections import Counter, defaultdict
from pathlib import Path

from collect_rehor_impact import fetch_jira, fetch_memory, jira_client, load_dotenv

JIRA_RE = re.compile(r"\b[A-Z][A-Z0-9]+-\d+\b(?!-\d)")


def main():
    root = Path(__file__).resolve().parent.parent
    load_dotenv(root / ".env")
    load_dotenv(root / ".env.report")
    filter_id = __import__("os").environ.get("JIRA_FILTER_ID", "107017")
    api = __import__("os").environ.get(
        "REHOR_MEMORY_API",
        "https://devbot-memory-server-platform-frontend-ai-dev-stage.apps.rosa.hcmais01ue1.s9m2.p3.openshiftapps.com/api",
    )

    memory = fetch_memory(api, False)
    task_keys = set()
    for task in memory.get("tasks", []):
        task_keys.update(JIRA_RE.findall(json.dumps(task, ensure_ascii=False, default=str)))
    client = jira_client()
    filtered = fetch_jira(client, filter_id)
    filter_keys = {issue.get("key") for issue in filtered.get("issues", [])}
    missing_keys = sorted(task_keys - filter_keys)

    issues = []
    for index, key in enumerate(missing_keys, 1):
        print(f"[coverage] Jira issue {index}/{len(missing_keys)}: {key}", flush=True)
        try:
            issues.append(
                client.get(
                    f"rest/api/3/issue/{urllib.parse.quote(key)}", {"fields": "project,labels,issuetype,status,summary"}
                )
            )
        except Exception as error:
            issues.append({"key": key, "error": str(error)})

    projects = Counter()
    labels = Counter()
    types = Counter()
    for issue in issues:
        fields = issue.get("fields", {})
        project = fields.get("project", {}).get("key", "UNKNOWN")
        projects[project] += 1
        types[fields.get("issuetype", {}).get("name", "UNKNOWN")] += 1
        labels.update(fields.get("labels", []))

    boards = defaultdict(list)
    for project in projects:
        try:
            data = client.get("rest/agile/1.0/board", {"projectKeyOrId": project, "maxResults": 100})
            boards[project] = [
                {"id": board.get("id"), "name": board.get("name"), "type": board.get("type")}
                for board in data.get("values", [])
            ]
        except Exception as error:
            boards[project] = [{"error": str(error)}]

    output = root / "impact-data" / "jira-filter-audit"
    output.mkdir(parents=True, exist_ok=True)
    result = {
        "filter_id": filter_id,
        "filter_issue_count": len(filter_keys),
        "task_jira_key_count": len(task_keys),
        "missing_key_count": len(missing_keys),
        "missing_keys": missing_keys,
        "projects": projects,
        "labels": labels,
        "issue_types": types,
        "boards": boards,
        "issues": issues,
    }
    (output / "audit.json").write_text(json.dumps(result, indent=2, default=lambda value: dict(value)))
    lines = [
        "# Jira Filter Coverage Audit",
        "",
        f"- Filter: `{filter_id}`",
        f"- Issues in filter: **{len(filter_keys)}**",
        f"- Task-referenced Jira keys: **{len(task_keys)}**",
        f"- Missing from filter: **{len(missing_keys)}**",
        "",
        "## Missing Projects",
        "",
        "| Project | Missing issues | Boards |",
        "|---|---:|---|",
    ]
    for project, count in projects.most_common():
        board_names = ", ".join(board.get("name", "error") for board in boards[project])
        lines.append(f"| `{project}` | {count} | {board_names or 'none found'} |")
    lines.extend(["", "## Missing Labels", "", "| Label | Issues |", "|---|---:|"])
    lines.extend(f"| `{label}` | {count} |" for label, count in labels.most_common())
    lines.extend(["", "## Missing Issue Types", "", "| Type | Issues |", "|---|---:|"])
    lines.extend(f"| {issue_type} | {count} |" for issue_type, count in types.most_common())
    lines.extend(
        [
            "",
            "## Interpretation",
            "",
            "These keys were referenced by persisted Rehor task records but were absent from saved filter at collection time. Add only confirmed Rehor labels/projects to filter JQL; do not blindly add every label found.",
            "",
        ]
    )
    (output / "report.md").write_text("\n".join(lines))
    print(f"[coverage] report: {output / 'report.md'}", flush=True)


if __name__ == "__main__":
    main()
