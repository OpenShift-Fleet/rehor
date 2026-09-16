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
SHARED_SERVICE_TREE = "services/insights/platform-frontend-ai-dev"
QUAY_ORG_REF = "/dependencies/quay/redhat-services-prod.yml"
AUTH_REF = "/services/app-sre/saas-file-auth/global.yml"
APP_REF = "/services/insights/platform-frontend-ai-dev/app.yml"
PIPELINES_REF_FALLBACK = "/services/insights/platform-frontend-ai-dev/pipelines/saas-openshift.yaml"
SAAS_SELF_SERVICE_REF = "/app-interface/changetype/saas-file-self-service.yml"

_YAML_SPECIAL = re.compile(r"[:#\[\]{},&*?|>\n]")


def _yaml_quote(val):
    """Wrap a value in single quotes if it contains YAML-special characters."""
    s = str(val)
    if _YAML_SPECIAL.search(s):
        return "'" + s.replace("'", "''") + "'"
    return s


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


def _discover_pipelines_ref(repo_path):
    saas_path = Path(repo_path) / SHARED_SAAS_PATH
    if not saas_path.exists():
        return None
    content = saas_path.read_text()
    match = re.search(r"pipelinesProvider:\s*\n\s+\$ref:\s*(\S+)", content)
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
        f"      BOT_NAME: {_yaml_quote(bot_name)}",
        f"      BOT_LABEL: {_yaml_quote(bot_label)}",
    ]

    if workflow == "jira-sprint":
        board_name = cfg.get("board_name", "")
        sprint_prefix = cfg.get("sprint_prefix", "")
        include_backlog = cfg.get("include_backlog", "false")
        if board_name:
            params.append(f"      BOT_BOARD_NAME: {_yaml_quote(board_name)}")
        if sprint_prefix:
            params.append(f"      BOT_SPRINT_PREFIX: {_yaml_quote(sprint_prefix)}")
        params.append(f"      BOT_INCLUDE_BACKLOG: '{include_backlog}'")
    elif workflow == "jira-kanban":
        board_name = cfg.get("board_name", "")
        jira_project = cfg.get("jira_project", "")
        if board_name:
            params.append(f"      BOT_BOARD_NAME: {_yaml_quote(board_name)}")
        if jira_project:
            params.append(f"      BOT_JIRA_PROJECT: {_yaml_quote(jira_project)}")

    params.append(f"      BOT_INSTANCE_ID: {_yaml_quote(instance_id)}")

    if slack_webhook_url:
        params.append(f"      SLACK_WEBHOOK_URL: {_yaml_quote(slack_webhook_url)}")
    slack_notify_mode = cfg.get("slack_notify_mode", "")
    if slack_notify_mode:
        params.append(f"      SLACK_NOTIFY_MODE: {_yaml_quote(slack_notify_mode)}")

    params.extend(
        [
            f"      GCP_PROJECT_ID: {_yaml_quote(gcp_project_id)}",
            f"      GCP_REGION: {_yaml_quote(gcp_region)}",
            f"      VERTEX_ALLOWED_MODELS: {_yaml_quote(vertex_models)}",
            f"      BOT_CONFIG_REPO: {_yaml_quote(config_repo)}",
            f"      BOT_CONFIG_PATH: {_yaml_quote(config_path)}",
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
  service: {_yaml_quote(service_label)}
  platform: {_yaml_quote(platform_label)}

name: {_yaml_quote(instance_name)}
displayName: {_yaml_quote(instance_name)}
description: {_yaml_quote("Rehor bot instance for " + cfg.get("team_name", instance_name))}

app:
  $ref: {app_ref}

pipelinesProvider:
  $ref: {pipelines_ref}

slack:
  workspace:
    $ref: /dependencies/slack/redhat-internal.yml
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

    pipelines_ref = _discover_pipelines_ref(repo_path)
    if not pipelines_ref:
        return {"error": f"Could not discover pipelinesProvider $ref from {SHARED_SAAS_PATH}"}

    resource_template = _build_resource_template(cfg, namespace_ref)
    image_pattern = _build_image_pattern(quay_org, instance_name)

    content = _build_saas_file(cfg, instance_name, APP_REF, pipelines_ref, AUTH_REF, image_pattern, resource_template)

    saas_path.write_text(content)
    return {"file": str(saas_path.relative_to(repo_path)), "action": "created"}


def _slugify(name):
    return re.sub(r"[^a-z0-9-]", "-", name.lower()).strip("-")


def _safe_path(base, *parts):
    p = Path(base).joinpath(*parts).resolve()
    if not p.is_relative_to(Path(base).resolve()):
        raise ValueError(f"Path escapes base directory: {'/'.join(str(x) for x in parts)}")
    return p


_SAFE_INSTANCE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


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
    saas_dir = _safe_path(Path(repo_path) / "data" / "services", service_tree)
    saas_dir.mkdir(parents=True, exist_ok=True)
    saas_path = saas_dir / f"{instance_name}.yml"

    if saas_path.exists():
        existing = saas_path.read_text()
        if f"name: {instance_name}" in existing and f"url: {cfg['repo_url']}" in existing:
            return {
                "file": str(saas_path.relative_to(repo_path)),
                "action": "unchanged",
                "reason": "instance already exists",
            }

    app_ref = cfg.get("app_ref", APP_REF)
    namespace_ref = cfg.get("namespace_ref")
    if not namespace_ref:
        raise ValueError(
            "namespace_ref is required for separate pattern — "
            "the team must provide their namespace $ref (do not fall back to shared deploy.yml)"
        )
    pipelines_ref = cfg.get("pipelines_ref")
    if not pipelines_ref:
        raise ValueError(
            "pipelines_ref is required for separate pattern — the team must provide their pipeline provider $ref"
        )
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
    app_path = _safe_path(Path(repo_path) / "data", ref_path)
    if not app_path.exists():
        return None

    content = app_path.read_text()
    if repo_url in content:
        return None

    try:
        data = yaml.safe_load(content)
    except yaml.YAMLError:
        return None
    if not isinstance(data, dict) or "codeComponents" not in data:
        return None

    new_entry = f"- name: {instance_name}\n  resource: upstream\n  url: {repo_url}"
    content = content.rstrip("\n")
    app_path.write_text(content + "\n" + new_entry + "\n")
    return str(app_path.relative_to(repo_path))


def _add_self_service_datafile(cfg, repo_path):
    """Add a saas-file-self-service entry to the team's role file for the new deploy file."""
    team_role_ref = cfg.get("team_role_ref")
    if not team_role_ref:
        return None

    role_ref = team_role_ref.lstrip("/")
    if not role_ref.endswith((".yml", ".yaml")):
        role_ref = f"{role_ref}.yml"
    role_path = _safe_path(Path(repo_path) / "data", role_ref)
    if not role_path.exists():
        return None

    instance_name = cfg["instance_name"]
    pattern = cfg.get("pattern", "shared")
    if pattern == "shared":
        deploy_ref = f"/{SHARED_SERVICE_TREE}/{instance_name}-deploy.yml"
    else:
        service_tree = cfg.get("service_tree", "")
        deploy_ref = f"/services/{service_tree}/{instance_name}.yml"

    content = role_path.read_text()
    if deploy_ref in content:
        return None

    try:
        data = yaml.safe_load(content)
    except yaml.YAMLError:
        return None
    if not isinstance(data, dict):
        return None

    new_datafile_line = f"  - $ref: {deploy_ref}"

    ss_ref_pattern = re.escape(SAAS_SELF_SERVICE_REF)
    ss_match = re.search(rf"\$ref:\s*{ss_ref_pattern}", content)
    if ss_match:
        datafiles_match = re.search(r"datafiles:\s*\n", content[ss_match.end() :])
        if datafiles_match:
            block_start = ss_match.end() + datafiles_match.end()
            last_ref_end = block_start
            for m in re.finditer(r"  - \$ref:\s*\S+[^\n]*\n?", content[block_start:]):
                last_ref_end = block_start + m.end()
            if content[last_ref_end - 1 : last_ref_end] != "\n":
                new_datafile_line = "\n" + new_datafile_line
            updated = (
                content[:last_ref_end].rstrip("\n")
                + "\n"
                + new_datafile_line
                + "\n"
                + content[last_ref_end:].lstrip("\n")
            )
            role_path.write_text(updated)
            return str(role_path.relative_to(repo_path))

    new_ct_block = f"- change_type:\n    $ref: {SAAS_SELF_SERVICE_REF}\n  datafiles:\n{new_datafile_line}\n"

    if "self_service:" in content:
        ss_line_match = re.search(r"^self_service:\s*$", content, re.MULTILINE)
        if ss_line_match:
            insert_pos = ss_line_match.end()
            role_path.write_text(content[:insert_pos] + "\n" + new_ct_block + content[insert_pos:])
            return str(role_path.relative_to(repo_path))

    content = content.rstrip("\n") + "\n\nself_service:\n" + new_ct_block
    role_path.write_text(content)
    return str(role_path.relative_to(repo_path))


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

        role_file = _add_self_service_datafile(cfg, repo_path)
        if role_file:
            result["role_file"] = role_file

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
    if not _SAFE_INSTANCE.match(cfg["instance_name"]):
        print(json.dumps({"error": "Invalid instance_name: must match ^[a-z0-9][a-z0-9-]*$"}))
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
