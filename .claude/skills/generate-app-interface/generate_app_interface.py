#!/usr/bin/env python3
"""Generate app-interface SaaS file changes for deploying a new bot instance.

Usage:
    python3 generate_app_interface.py '<json_config>' <app_interface_repo_path>

Modifies the shared deploy.yml (RedHatInsights) or creates a new SaaS file
(external org) for deployment to hcmais cluster.
"""

import json
import re
import sys
from pathlib import Path

SHARED_SAAS_PATH = "data/services/insights/platform-frontend-ai-dev/deploy.yml"
NAMESPACE_REF = "/services/insights/platform-frontend-ai-dev/namespaces/stage.hcmais01ue1.yml"
QUAY_ORG_REF = "/dependencies/quay/redhat-services-prod.yml"
AUTH_REF = "/services/app-sre/saas-file-auth/global.yml"
APP_REF = "/services/insights/platform-frontend-ai-dev/app.yml"
PIPELINES_REF = "/services/insights/platform-frontend-ai-dev/pipelines/saas-openshift.yaml"


def _build_resource_template(cfg):
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

    params = [
        f"          BOT_IMAGE: quay.io/redhat-services-prod/{quay_org}/{instance_name}",
        f"          BOT_NAME: {bot_name}",
        f"          BOT_LABEL: {bot_label}",
        "          BOT_REPLICAS: '0'",
        f"          BOT_INSTANCE_ID: {instance_id}",
        "          GCP_PROJECT_ID: ${GCP_PROJECT_ID}",
        "          GCP_REGION: ${GCP_REGION}",
        "          VERTEX_ALLOWED_MODELS: ${VERTEX_ALLOWED_MODELS}",
        f"          BOT_CONFIG_REPO: {config_repo}",
        f"          BOT_CONFIG_PATH: {config_path}",
    ]

    if workflow == "jira-sprint":
        board_name = cfg.get("board_name", "")
        sprint_prefix = cfg.get("sprint_prefix", "")
        include_backlog = cfg.get("include_backlog", "false")
        params.extend(
            [
                f"          BOT_BOARD_NAME: {board_name}",
                f"          BOT_SPRINT_PREFIX: {sprint_prefix}",
                f"          BOT_INCLUDE_BACKLOG: '{include_backlog}'",
            ]
        )
    elif workflow == "jira-kanban":
        board_id = cfg.get("board_id", "")
        jira_project = cfg.get("jira_project", "")
        if board_id:
            params.append(f"          BOT_BOARD_ID: '{board_id}'")
        if jira_project:
            params.append(f"          BOT_JIRA_PROJECT: {jira_project}")

    if slack_webhook_url:
        params.append(f"          SLACK_WEBHOOK_URL: {slack_webhook_url}")

    params_block = "\n".join(params)

    target_branch = cfg.get("target_branch", "master")

    return f"""    - name: {instance_name}
      path: /deploy/template.yaml
      url: {repo_url}
      targets:
      - namespace:
          $ref: {NAMESPACE_REF}
        ref: {target_branch}
        images:
        - name: {quay_org}/{instance_name}
          org:
            $ref: {QUAY_ORG_REF}
        parameters:
{params_block}"""


def _build_image_pattern(quay_org, instance_name):
    return f"  - quay.io/redhat-services-prod/{quay_org}/{instance_name}"


def _modify_shared_saas(cfg, repo_path):
    saas_path = Path(repo_path) / SHARED_SAAS_PATH
    if not saas_path.exists():
        return {"error": f"Shared SaaS file not found at {SHARED_SAAS_PATH}"}

    content = saas_path.read_text()
    quay_org = cfg["quay_org"]
    instance_name = cfg["instance_name"]

    image_pattern = _build_image_pattern(quay_org, instance_name)
    if image_pattern.strip() not in content:
        image_patterns_marker = "imagePatterns:"
        idx = content.find(image_patterns_marker)
        if idx >= 0:
            end_of_line = content.find("\n", idx)
            content = content[: end_of_line + 1] + image_pattern + "\n" + content[end_of_line + 1 :]

    resource_template = _build_resource_template(cfg)
    content = content.rstrip() + "\n" + resource_template + "\n"

    saas_path.write_text(content)
    return {"file": SHARED_SAAS_PATH, "action": "modified"}


def _slugify(name):
    return re.sub(r"[^a-z0-9-]", "-", name.lower()).strip("-")


def _create_separate_saas(cfg, repo_path):
    instance_name = cfg["instance_name"]
    team = _slugify(cfg.get("team_name", instance_name))
    quay_org = cfg["quay_org"]

    saas_dir = Path(repo_path) / "data" / "services" / "insights" / team
    saas_dir.mkdir(parents=True, exist_ok=True)
    saas_path = saas_dir / f"{instance_name}.yml"

    resource_template = _build_resource_template(cfg)
    image_pattern = _build_image_pattern(quay_org, instance_name)

    content = f"""---
$schema: /app-sre/saas-file-2.yml

labels:
  service: platform-frontend-ai-dev
  platform: insights

name: {instance_name}
displayName: {instance_name}
description: Rehor bot instance for {cfg.get("team_name", instance_name)}

app:
  $ref: {APP_REF}

pipelinesProvider:
  $ref: {PIPELINES_REF}

slack:
  workspace:
    $ref: /dependencies/slack/coreos.yml
  channel: ''

takeover: true

managedResourceTypes:
- Deployment
- NetworkPolicy
- ScaledObject.keda.sh

imagePatterns:
{image_pattern}

authentication:
  $ref: {AUTH_REF}

resourceTemplates:
{resource_template}
"""

    saas_path.write_text(content)
    return {"file": str(saas_path.relative_to(repo_path)), "action": "created"}


def generate(cfg, repo_path):
    pattern = cfg.get("pattern", "shared")

    if pattern == "shared":
        return _modify_shared_saas(cfg, repo_path)
    else:
        return _create_separate_saas(cfg, repo_path)


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

    result = generate(cfg, repo_path)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
