#!/usr/bin/env python3
"""Generate app-interface SaaS deploy file for a new bot instance.

Usage:
    python3 generate_app_interface.py '<json_config>' <app_interface_repo_path>
"""

import json
import re
import sys
from pathlib import Path

import yaml

SHARED_SAAS_PATH = "data/services/insights/platform-frontend-ai-dev/deploy.yml"
QUAY_ORG_REF = "/dependencies/quay/redhat-services-prod.yml"
AUTH_REF = "/services/app-sre/saas-file-auth/global.yml"
APP_REF = "/services/insights/platform-frontend-ai-dev/app.yml"
PIPELINES_REF = "/services/insights/platform-frontend-ai-dev/pipelines/saas-openshift.yaml"


def _discover_namespace_ref(saas_content):
    """Extract the namespace $ref from an existing resource template entry."""
    match = re.search(r"namespace:\s*\n\s+\$ref:\s*(\S+)", saas_content)
    if match:
        return match.group(1)
    return None


def _discover_gcp_project(repo_path):
    """Discover the shared GCP project ID from existing entries in the shared deploy.yml."""
    saas_path = Path(repo_path) / SHARED_SAAS_PATH
    if not saas_path.exists():
        return None
    content = saas_path.read_text()
    match = re.search(r"GCP_PROJECT_ID:\s*(\S+)", content)
    if match:
        return match.group(1)
    return None


def _build_resource_template(cfg, namespace_ref):
    instance_name = cfg["instance_name"]
    config_name = cfg.get("config_name", instance_name.replace("-agent-dev", "-config").replace("-ai-dev", "-config"))
    bot_name = cfg.get("bot_name", f"devbot-{config_name.removesuffix('-config')}")
    bot_label = cfg.get("bot_label", f"rehor-ai-{config_name.removesuffix('-config')}")
    instance_id = cfg.get("instance_id", instance_name)
    repo_url = cfg["repo_url"]
    quay_org = cfg["quay_org"]
    config_repo = cfg.get("config_repo", repo_url)
    config_path = cfg.get("config_path", f"instance/{config_name}")
    workflow = cfg.get("workflow", "jira-sprint")
    slack_webhook_url = cfg.get("slack_webhook_url", "")

    gcp_project_id = cfg["gcp_project_id"]
    gcp_region = cfg.get("gcp_region", "global")
    vertex_models = cfg.get("vertex_allowed_models", "claude-sonnet-4-6,claude-opus-4-6,claude-haiku-4-5")

    params = [
        f"      BOT_IMAGE: quay.io/redhat-services-prod/{quay_org}/{instance_name}",
        "      BOT_REPLICAS: '0'",
        f"      BOT_NAME: {bot_name}",
        f"      BOT_LABEL: {bot_label}",
    ]

    if workflow == "jira-sprint":
        board_name = cfg.get("board_name", "")
        sprint_prefix = cfg.get("sprint_prefix", "")
        include_backlog = cfg.get("include_backlog", "false")
        if board_name:
            params.append(f"      BOT_BOARD_NAME: {board_name}")
        if sprint_prefix:
            params.append(f"      BOT_SPRINT_PREFIX: {sprint_prefix}")
        params.append(f"      BOT_INCLUDE_BACKLOG: '{include_backlog}'")
    elif workflow == "jira-kanban":
        board_id = cfg.get("board_id", "")
        jira_project = cfg.get("jira_project", "")
        if board_id:
            params.append(f"      BOT_BOARD_ID: '{board_id}'")
        if jira_project:
            params.append(f"      BOT_JIRA_PROJECT: {jira_project}")

    params.append(f"      BOT_INSTANCE_ID: {instance_id}")

    if slack_webhook_url:
        params.append(f"      SLACK_WEBHOOK_URL: {slack_webhook_url}")
    slack_notify_mode = cfg.get("slack_notify_mode", "")
    if slack_notify_mode:
        params.append(f"      SLACK_NOTIFY_MODE: {slack_notify_mode}")

    params.extend(
        [
            f"      GCP_PROJECT_ID: {gcp_project_id}",
            f"      GCP_REGION: {gcp_region}",
            f"      VERTEX_ALLOWED_MODELS: {vertex_models}",
            f"      BOT_CONFIG_REPO: {config_repo}",
            f"      BOT_CONFIG_PATH: {config_path}",
        ]
    )

    params_block = "\n".join(params)

    target_branch = cfg.get("target_branch", "main")

    ns_ref = namespace_ref

    return f"""- name: {instance_name}
  path: /deploy/template.yaml
  url: {repo_url}
  targets:
  - namespace:
      $ref: {ns_ref}
    ref: {target_branch}
    images:
    - org:
        $ref: {QUAY_ORG_REF}
      name: {quay_org}/{instance_name}
    parameters:
{params_block}"""


def _build_image_pattern(quay_org, instance_name):
    return f"- quay.io/redhat-services-prod/{quay_org}/{instance_name}"


def _build_saas_file(cfg, instance_name, app_ref, pipelines_ref, auth_ref, image_pattern, resource_template):
    service_label = cfg.get("service_label", "platform-frontend-ai-dev")
    platform_label = cfg.get("platform_label", "insights")
    return f"""---
$schema: /app-sre/saas-file-2.yml

labels:
  service: {service_label}
  platform: {platform_label}

name: {instance_name}
displayName: {instance_name}
description: Rehor bot instance for {cfg.get("team_name", instance_name)}

app:
  $ref: {app_ref}

pipelinesProvider:
  $ref: {pipelines_ref}

slack:
  workspace:
    $ref: /dependencies/slack/coreos.yml
  channel: ''

managedResourceTypes:
- Deployment
- NetworkPolicy
- ScaledObject.keda.sh

imagePatterns:
{image_pattern}

authentication:
  $ref: {auth_ref}

resourceTemplates:
{resource_template}
"""


def _create_shared_saas(cfg, repo_path):
    instance_name = cfg["instance_name"]
    quay_org = cfg["quay_org"]

    shared_saas = Path(repo_path) / SHARED_SAAS_PATH
    if not shared_saas.exists():
        return {"error": f"Shared SaaS file not found at {SHARED_SAAS_PATH}"}

    shared_content = shared_saas.read_text()
    namespace_ref = _discover_namespace_ref(shared_content)
    if not namespace_ref:
        return {"error": f"Could not discover namespace $ref from existing entries in {SHARED_SAAS_PATH}"}

    if not cfg.get("gcp_project_id"):
        discovered = _discover_gcp_project(repo_path)
        if not discovered:
            return {"error": f"Could not discover GCP_PROJECT_ID from {SHARED_SAAS_PATH}"}
        cfg = {**cfg, "gcp_project_id": discovered}

    service_dir = shared_saas.parent
    saas_path = service_dir / f"{instance_name}-deploy.yml"

    if saas_path.exists():
        existing = saas_path.read_text()
        if f"name: {instance_name}" in existing and f"url: {cfg['repo_url']}" in existing:
            return {
                "file": str(saas_path.relative_to(repo_path)),
                "action": "unchanged",
                "reason": "instance already exists",
            }

    resource_template = _build_resource_template(cfg, namespace_ref)
    image_pattern = _build_image_pattern(quay_org, instance_name)

    content = _build_saas_file(cfg, instance_name, APP_REF, PIPELINES_REF, AUTH_REF, image_pattern, resource_template)

    saas_path.write_text(content)
    return {"file": str(saas_path.relative_to(repo_path)), "action": "created"}


def _slugify(name):
    return re.sub(r"[^a-z0-9-]", "-", name.lower()).strip("-")


def _create_separate_saas(cfg, repo_path):
    instance_name = cfg["instance_name"]
    quay_org = cfg["quay_org"]

    if "gcp_project_id" not in cfg:
        raise ValueError("gcp_project_id is required for separate pattern")

    service_tree = cfg.get("service_tree")
    if not service_tree:
        raise ValueError(
            "service_tree is required for separate pattern "
            "(e.g., 'my-platform/my-team'). The team must work with "
            "app-sre to set up the service tree in app-interface first."
        )
    saas_dir = Path(repo_path) / "data" / "services" / service_tree
    saas_dir.mkdir(parents=True, exist_ok=True)
    saas_path = saas_dir / f"{instance_name}.yml"

    app_ref = cfg.get("app_ref", APP_REF)
    namespace_ref = cfg.get("namespace_ref")
    if not namespace_ref:
        raise ValueError(
            "namespace_ref is required for separate pattern — "
            "the team must provide their namespace $ref (do not fall back to shared deploy.yml)"
        )
    pipelines_ref = cfg.get("pipelines_ref", PIPELINES_REF)
    auth_ref = cfg.get("auth_ref", AUTH_REF)

    resource_template = _build_resource_template(cfg, namespace_ref=namespace_ref)
    image_pattern = _build_image_pattern(quay_org, instance_name)

    content = _build_saas_file(cfg, instance_name, app_ref, pipelines_ref, auth_ref, image_pattern, resource_template)

    saas_path.write_text(content)
    return {"file": str(saas_path.relative_to(repo_path)), "action": "created"}


def _add_code_component(cfg, repo_path):
    instance_name = cfg["instance_name"]
    repo_url = cfg["repo_url"]
    app_ref = cfg.get("app_ref", APP_REF)
    ref_path = app_ref.lstrip("/")
    app_path = Path(repo_path) / "data" / ref_path
    if not app_path.exists():
        return None

    content = app_path.read_text()
    if repo_url in content:
        return None

    data = yaml.safe_load(content)
    if not isinstance(data, dict) or "codeComponents" not in data:
        return None

    if not isinstance(data["codeComponents"], list):
        data["codeComponents"] = []

    data["codeComponents"].append({"name": instance_name, "resource": "upstream", "url": repo_url})
    app_path.write_text("---\n" + yaml.dump(data, default_flow_style=False, sort_keys=False))
    return str(app_path.relative_to(repo_path))


def generate(cfg, repo_path):
    pattern = cfg.get("pattern", "shared")

    if pattern == "shared":
        result = _create_shared_saas(cfg, repo_path)
    else:
        result = _create_separate_saas(cfg, repo_path)

    if "error" not in result:
        app_file = _add_code_component(cfg, repo_path)
        if app_file:
            result["app_file"] = app_file

    return result


def main():
    if len(sys.argv) < 3:
        print("Usage: generate_app_interface.py '<json_config>' <app_interface_repo_path>", file=sys.stderr)
        sys.exit(1)

    try:
        cfg = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
        sys.exit(1)

    repo_path = sys.argv[2]
    if not Path(repo_path).is_dir():
        print(json.dumps({"error": f"Directory not found: {repo_path}"}))
        sys.exit(1)
    if not (Path(repo_path) / ".git").exists():
        print(json.dumps({"error": f"Not a git repo: {repo_path}"}))
        sys.exit(1)
    saas_marker = Path(repo_path) / "data" / "services"
    if not saas_marker.is_dir():
        print(json.dumps({"error": f"Not an app-interface repo (missing data/services/): {repo_path}"}))
        sys.exit(1)
    if not cfg.get("instance_name"):
        print(json.dumps({"error": "instance_name is required"}))
        sys.exit(1)
    if not cfg.get("repo_url"):
        print(json.dumps({"error": "repo_url is required"}))
        sys.exit(1)
    if not cfg.get("quay_org"):
        print(json.dumps({"error": "quay_org is required"}))
        sys.exit(1)
    if cfg.get("pattern", "shared") != "shared" and not cfg.get("gcp_project_id"):
        print(json.dumps({"error": "gcp_project_id is required for separate pattern"}))
        sys.exit(1)

    result = generate(cfg, repo_path)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
