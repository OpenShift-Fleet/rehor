#!/usr/bin/env python3
"""Collect reproducible Rehor impact evidence from Jira, memory API, Git CLIs.

Read-only. Credentials are loaded from the process environment or local .env;
raw output contains API responses and deployment metadata, never secret values.

Example:
    python3 impact-data/collect-rehor-impact.py
    python3 impact-data/collect-rehor-impact.py --skip-cycles
"""

import argparse
import base64
import csv
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

DEFAULT_MEMORY_API = (
    "https://devbot-memory-server-platform-frontend-ai-dev-stage.apps.rosa.hcmais01ue1.s9m2.p3.openshiftapps.com/api"
)
JIRA_KEY_RE = re.compile(r"\b[A-Z][A-Z0-9]+-\d+\b(?!-\d)")
GH_URL_RE = re.compile(r"https://github\.com/[^\s\]\)>,]+/pull/\d+")
GL_URL_RE = re.compile(r"https://gitlab\.cee\.redhat\.com/[^\s\]\)>,]+/merge_requests/\d+")


def load_dotenv(path: Path) -> None:
    """Load simple KEY=VALUE entries without executing .env as shell code."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        os.environ.setdefault(key, value)


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True, default=str) + "\n")


class HttpClient:
    def __init__(self, base_url: str, headers=None):
        self.base_url = base_url.rstrip("/")
        self.headers = headers or {}

    def get(self, path: str, params=None):
        query = urllib.parse.urlencode(params or {})
        url = f"{self.base_url}/{path.lstrip('/')}" + (f"?{query}" if query else "")
        request = urllib.request.Request(url, headers={"Accept": "application/json", **self.headers})
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode())


def jira_client():
    url = os.environ.get("JIRA_URL", "https://redhat.atlassian.net")
    username = os.environ.get("JIRA_USERNAME") or os.environ.get("JIRA_EMAIL")
    token = os.environ.get("JIRA_API_TOKEN") or os.environ.get("JIRA_TOKEN")
    if not username or not token:
        raise RuntimeError("JIRA_USERNAME/JIRA_EMAIL and JIRA_API_TOKEN/JIRA_TOKEN required")
    auth = base64.b64encode(f"{username}:{token}".encode()).decode()
    return HttpClient(url, {"Authorization": f"Basic {auth}"})


def fetch_jira(client, filter_id: str):
    filter_info = client.get(f"rest/api/3/filter/{filter_id}")
    issues = []
    token = None
    while True:
        params = {
            "jql": f"filter={filter_id}",
            "fields": "summary,status,issuetype,labels,assignee,created,updated,resolution,resolutiondate,comment",
            "maxResults": 100,
        }
        if token:
            params["nextPageToken"] = token
        page = client.get("rest/api/3/search/jql", params)
        issues.extend(page.get("issues", []))
        token = page.get("nextPageToken")
        if not token:
            break
    return {"filter": filter_info, "issues": issues}


def fetch_memory(api: str, include_cycles: bool):
    client = HttpClient(api)
    instances = client.get("instances")
    costs = client.get("costs", {"days": 3650, "limit": 10000})
    analytics = client.get("analytics", {"days": 3650})
    tasks = []
    offset = 0
    while True:
        page = client.get("tasks", {"limit": 100, "offset": offset})
        batch = page.get("items", [])
        tasks.extend(batch)
        offset += len(batch)
        if not batch or offset >= page.get("total", offset):
            break

    result = {"instances": instances, "tasks": tasks, "costs": costs, "analytics": analytics}
    if include_cycles:
        cycles = []
        offset = 0
        while True:
            page = client.get("cycle-runs", {"limit": 100, "offset": offset})
            batch = page.get("items", [])
            cycles.extend(batch)
            offset += len(batch)
            if not batch or offset >= page.get("total", offset):
                break
        result["cycle_runs"] = cycles
    return result


def cli_json(command, env=None):
    command_env = os.environ.copy()
    if env:
        command_env.update(env)
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=120, env=command_env)
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"ok": False, "command": command, "error": str(error)}
    if result.returncode:
        return {"ok": False, "command": command, "error": result.stderr.strip()[-1000:]}
    try:
        return {"ok": True, "command": command, "data": json.loads(result.stdout)}
    except json.JSONDecodeError:
        return {"ok": False, "command": command, "error": "CLI returned non-JSON output"}


def fetch_git_activity():
    bot_gh_token = os.environ.get("GH_BOT_CLI_TOKEN")
    bot_gl_token = os.environ.get("GL_BOT_CLI_TOKEN")
    gh_env = {"GH_TOKEN": bot_gh_token} if bot_gh_token else None
    gl_env = {"GITLAB_TOKEN": bot_gl_token} if bot_gl_token else None
    authors = [x for x in os.environ.get("GH_AUTHORS", "platex-rehor-bot").split(",") if x]
    github = []
    for author in authors:
        page = 1
        while True:
            query = urllib.parse.quote(f"author:{author} type:pr")
            result = cli_json(["gh", "api", f"search/issues?q={query}&per_page=100&page={page}"], gh_env)
            github.append(result)
            if not result.get("ok") or len(result.get("data", {}).get("items", [])) < 100:
                break
            page += 1

    gitlab = []
    host = os.environ.get("GITLAB_HOST", "gitlab.cee.redhat.com")
    author_id = os.environ.get("GL_AUTHOR_ID", "32231")
    page = 1
    while True:
        result = cli_json(
            [
                "glab",
                "api",
                f"merge_requests?scope=all&author_id={author_id}&state=all&per_page=100&page={page}",
                "--hostname",
                host,
            ],
            gl_env,
        )
        gitlab.append(result)
        if not result.get("ok") or len(result.get("data", [])) < 100:
            break
        page += 1
    return {
        "local_cli_identity": {
            "github": cli_json(["gh", "api", "user"]),
            "gitlab": cli_json(
                [
                    "glab",
                    "api",
                    "/user",
                    "--hostname",
                    os.environ.get("GITLAB_HOST", "gitlab.cee.redhat.com"),
                ]
            ),
        },
        "bot_cli_identity": {
            "github": cli_json(["gh", "api", "user"], gh_env),
            "gitlab": cli_json(
                [
                    "glab",
                    "api",
                    "/user",
                    "--hostname",
                    os.environ.get("GITLAB_HOST", "gitlab.cee.redhat.com"),
                ],
                gl_env,
            ),
        },
        "github": github,
        "gitlab": gitlab,
    }


def inventory_app_interface(path: Path):
    files = []
    config_repos = set()
    if not path.exists():
        return {"path": str(path), "error": "directory not found", "files": files}
    tracked = None
    try:
        result = subprocess.run(
            ["git", "-C", str(path), "ls-files", "--cached"],
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        )
        tracked = {path / item for item in result.stdout.splitlines()}
    except (OSError, subprocess.SubprocessError):
        pass

    candidates = tracked if tracked is not None else path.rglob("*")
    for file_path in sorted(candidates):
        if not file_path.is_file() or ".git" in file_path.parts or ".claude" in file_path.parts:
            continue
        try:
            text = file_path.read_text(errors="replace")
        except OSError:
            continue
        relative = str(file_path.relative_to(path))
        relevant_path = re.search(r"rehor|devbot|platform-frontend-ai-dev", relative, re.I)
        relevant_text = re.search(r"rehor|devbot|platform-frontend-ai-dev", text, re.I)
        if not relevant_path and not relevant_text:
            continue
        config_repos.update(re.findall(r"BOT_CONFIG_REPO:\s*[\"']?([^\s\"']+)", text))
        files.append(
            {
                "path": relative,
                "instance_ids": sorted(set(re.findall(r"(?:instance[_-]?id|name):\s*[\"']?([^\s\"']+)", text, re.I))),
                "secret_refs": sorted(
                    set(re.findall(r"(?:secretName|secretKeyRef:\s*\n?\s*name):\s*([^\s]+)", text, re.I))
                ),
                "github_urls": sorted(set(GH_URL_RE.findall(text))),
                "gitlab_urls": sorted(set(GL_URL_RE.findall(text))),
            }
        )
    return {"path": str(path), "files": files, "config_repos": sorted(config_repos)}


def clone_config_repos(repos, destination: Path):
    destination.mkdir(parents=True, exist_ok=True)
    results = []
    for url in repos:
        name = url.rstrip("/").rsplit("/", 1)[-1].removesuffix(".git")
        target = destination / name
        if (target / ".git").exists():
            print(f"[collector] config repo exists: {target}", flush=True)
            results.append({"url": url, "path": str(target), "status": "exists"})
            continue
        print(f"[collector] cloning config repo: {url}", flush=True)
        try:
            subprocess.run(["git", "clone", url, str(target)], check=True, capture_output=True, text=True, timeout=600)
            results.append({"url": url, "path": str(target), "status": "cloned"})
        except (OSError, subprocess.SubprocessError) as error:
            results.append({"url": url, "path": str(target), "status": "error", "error": str(error)})
    return results


def write_task_reference_export(tasks, output: Path):
    fields = [
        "task_id",
        "external_key",
        "source_type",
        "instance_id",
        "status",
        "repo",
        "branch",
        "jira_keys",
        "github_prs",
        "gitlab_mrs",
        "artifact_types",
        "artifact_count",
    ]
    with (output / "task-references.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for task in tasks:
            blob = json.dumps(task, ensure_ascii=False, default=str)
            writer.writerow(
                {
                    "task_id": task.get("id", ""),
                    "external_key": task.get("external_key", ""),
                    "source_type": task.get("source_type", ""),
                    "instance_id": task.get("instance_id", ""),
                    "status": task.get("status", ""),
                    "repo": task.get("repo", ""),
                    "branch": task.get("branch", ""),
                    "jira_keys": " | ".join(sorted(set(JIRA_KEY_RE.findall(blob)))),
                    "github_prs": " | ".join(sorted(set(GH_URL_RE.findall(blob)))),
                    "gitlab_mrs": " | ".join(sorted(set(GL_URL_RE.findall(blob)))),
                    "artifact_types": " | ".join(
                        sorted({a.get("type", "unknown") for a in task.get("artifacts", []) if isinstance(a, dict)})
                    ),
                    "artifact_count": len(task.get("artifacts", [])),
                }
            )


def reconcile(jira, memory, git_activity, inventory):
    jira_keys = {i.get("key") for i in jira.get("issues", [])}
    label_counts = {}
    label_issue_counts = {}
    for issue in jira.get("issues", []):
        labels = issue.get("fields", {}).get("labels", [])
        for label in labels:
            label_counts[label] = label_counts.get(label, 0) + 1
            if re.match(r"(?:rehor|hcc-ai|devbot)(?:[-_:]|$)", label, re.I):
                label_issue_counts[label] = label_issue_counts.get(label, 0) + 1
    task_keys = set()
    task_urls = set()
    for task in memory.get("tasks", []):
        key = task.get("external_key")
        if key:
            task_keys.update(JIRA_KEY_RE.findall(key))
            task_urls.add(key)
        blob = json.dumps(task, default=str)
        task_keys.update(JIRA_KEY_RE.findall(blob))
        task_urls.update(GH_URL_RE.findall(blob))
        task_urls.update(GL_URL_RE.findall(blob))

    jira_blob = json.dumps(jira, default=str)
    jira_prs = set(GH_URL_RE.findall(jira_blob))
    jira_mrs = set(GL_URL_RE.findall(jira_blob))
    inv_blob = json.dumps(inventory, default=str)
    inv_prs = set(GH_URL_RE.findall(inv_blob))
    inv_mrs = set(GL_URL_RE.findall(inv_blob))

    # Jira keys are canonical. Unlinked tasks and PRs/MRs remain explicit
    # unresolved identities instead of being counted as Jira work silently.
    identities = {}

    def add_identity(identity_key, kind, evidence):
        entry = identities.setdefault(identity_key, {"kinds": set(), "evidence": set()})
        entry["kinds"].add(kind)
        if evidence:
            entry["evidence"].add(evidence)

    for key in jira_keys:
        add_identity(f"jira:{key}", "jira", key)
    for task in memory.get("tasks", []):
        blob = json.dumps(task, default=str)
        keys = set(JIRA_KEY_RE.findall(blob))
        if keys:
            for key in keys:
                add_identity(f"jira:{key}", "task", task.get("external_key", key))
        else:
            external = task.get("external_key") or f"task-{task.get('id', 'unknown')}"
            add_identity(f"task:{task.get('source_type', 'unknown')}:{external}", "task", external)
    for pages, kind, url_key in (
        (git_activity.get("github", []), "github_pr", "html_url"),
        (git_activity.get("gitlab", []), "gitlab_mr", "web_url"),
    ):
        for page in pages:
            if not page.get("ok"):
                continue
            items = page.get("data", {}).get("items", []) if kind == "github_pr" else page.get("data", [])
            for item in items:
                value = item.get(url_key, "")
                keys = set(JIRA_KEY_RE.findall(json.dumps(item, default=str)))
                if keys:
                    for key in keys:
                        add_identity(f"jira:{key}", kind, value)
                elif value:
                    add_identity(f"{kind}:{value}", kind, value)

    canonical_identities = [
        {
            "identity": key,
            "kinds": sorted(value["kinds"]),
            "evidence": sorted(value["evidence"]),
        }
        for key, value in sorted(identities.items())
    ]
    canonical_jira = [x for x in canonical_identities if x["identity"].startswith("jira:")]

    return {
        "jira_issue_count": len(jira_keys),
        "memory_task_count": len(memory.get("tasks", [])),
        "memory_instance_count": len(memory.get("instances", [])),
        "memory_cycle_count": len(memory.get("cycle_runs", [])),
        "jira_labels": dict(sorted(label_counts.items())),
        "candidate_bot_labels_in_filter": dict(sorted(label_issue_counts.items())),
        "jira_keys_missing_from_tasks": sorted(jira_keys - task_keys),
        "task_jira_keys_missing_from_filter": sorted(task_keys - jira_keys),
        "jira_pr_links": sorted(jira_prs),
        "jira_mr_links": sorted(jira_mrs),
        "deployment_pr_links": sorted(inv_prs),
        "deployment_mr_links": sorted(inv_mrs),
        "task_external_keys_or_urls": sorted(task_urls),
        "canonical_identity_count": len(canonical_identities),
        "canonical_jira_identity_count": len(canonical_jira),
        "canonical_unresolved_identity_count": len(canonical_identities) - len(canonical_jira),
        "canonical_identities": canonical_identities,
        "cli_status": {
            "github": [x.get("ok", False) for x in git_activity.get("github", [])],
            "gitlab": [x.get("ok", False) for x in git_activity.get("gitlab", [])],
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output-dir", default="impact-data/runs")
    parser.add_argument("--app-interface", default=os.path.expanduser("~/insights/app-interface"))
    parser.add_argument("--memory-api", default=os.environ.get("REHOR_MEMORY_API", DEFAULT_MEMORY_API))
    parser.add_argument("--jira-filter", default=os.environ.get("JIRA_FILTER_ID", "107017"))
    parser.add_argument("--skip-cycles", action="store_true")
    parser.add_argument("--no-clone-config-repos", action="store_true")
    args = parser.parse_args()

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    load_dotenv(Path(__file__).resolve().parent.parent / ".env.report")
    run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    output = Path(args.output_dir) / run_id
    output.mkdir(parents=True, exist_ok=True)
    print(f"Run: {run_id}", file=sys.stderr)
    print(f"[collector] output={output}", flush=True)

    sources = {
        "run_id": run_id,
        "generated_at": datetime.now(UTC).isoformat(),
        "config": {"jira_filter": args.jira_filter, "memory_api": args.memory_api, "app_interface": args.app_interface},
    }
    write_json(output / "manifest.json", sources)

    try:
        print("[collector] Jira: fetching filter and issues", flush=True)
        jira = fetch_jira(jira_client(), args.jira_filter)
        write_json(output / "jira.json", jira)
        print(f"[collector] Jira: {len(jira.get('issues', []))} issues", flush=True)
    except Exception as error:
        jira = {"error": str(error), "issues": []}
        write_json(output / "jira-error.json", jira)

    try:
        print(
            f"[collector] Rehor API: fetching tasks and instances{' plus cycles' if not args.skip_cycles else ''}",
            flush=True,
        )
        memory = fetch_memory(args.memory_api, not args.skip_cycles)
        write_json(output / "memory.json", memory)
        write_task_reference_export(memory.get("tasks", []), output)
        print(
            f"[collector] Rehor API: {len(memory.get('tasks', []))} tasks, "
            f"{len(memory.get('instances', []))} instances, "
            f"{len(memory.get('cycle_runs', []))} cycles",
            flush=True,
        )
    except Exception as error:
        memory = {"error": str(error), "tasks": [], "instances": []}
        write_json(output / "memory-error.json", memory)

    print("[collector] GitHub/GitLab: fetching bot identities and activity", flush=True)
    git_activity = fetch_git_activity()
    print("[collector] app-interface: scanning tracked deployment/config files", flush=True)
    inventory = inventory_app_interface(Path(args.app_interface))
    if not args.no_clone_config_repos:
        clone_dir = Path(os.environ.get("REHOR_CONFIG_REPOS_DIR", str(Path.home() / "rehor"))).expanduser()
        inventory["cloned_config_repos"] = clone_config_repos(inventory.get("config_repos", []), clone_dir)
    write_json(output / "git-activity.json", git_activity)
    write_json(output / "app-interface.json", inventory)
    reconciliation = reconcile(jira, memory, git_activity, inventory)
    write_json(output / "reconciliation.json", reconciliation)
    print(
        f"[collector] identities: {reconciliation['canonical_identity_count']} canonical, "
        f"{reconciliation['canonical_unresolved_identity_count']} unresolved",
        flush=True,
    )

    summary = """# Rehor Impact Collection\n\n"""
    summary += f"- Run: `{run_id}`\n- Jira filter issues: **{reconciliation['jira_issue_count']}**\n"
    summary += (
        f"- Rehor tasks: **{reconciliation['memory_task_count']}**\n"
        f"- Rehor instances: **{reconciliation['memory_instance_count']}**\n"
    )
    summary += f"- Cycle runs: **{reconciliation['memory_cycle_count']}**\n"
    summary += f"- Jira keys absent from task records: **{len(reconciliation['jira_keys_missing_from_tasks'])}**\n"
    summary += f"- Task Jira keys absent from filter: **{len(reconciliation['task_jira_keys_missing_from_filter'])}**\n"
    summary += "\nRaw source files and reconciliation data are in this run directory.\n"
    (output / "summary.md").write_text(summary)
    print(f"Output: {output}", file=sys.stderr)


if __name__ == "__main__":
    main()
