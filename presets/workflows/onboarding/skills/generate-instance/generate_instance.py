#!/usr/bin/env python3
"""Generate all scaffolding files for a new Rehor bot instance runner repo.

Usage:
    python3 generate_instance.py '<json_requirements>' <output_dir>

Writes the complete directory tree for a new instance repo.
"""

import json
import os
import sys
from pathlib import Path

GH_FORK_ACCOUNT = "platex-rehor-bot"
GL_FORK_ACCOUNT = "platform-experience-services-bot"

DEFAULT_KEDA = {
    "timezone": "America/New_York",
    "start": "0 9 * * 1-5",
    "end": "0 18 * * 1-5",
}

PERSONA_TEMPLATES = {
    "frontend": (
        "Frontend persona for React/PatternFly applications.\n\n"
        "## Stack\n\n"
        "- React + TypeScript\n"
        "- PatternFly component library\n"
        "- Webpack/Vite bundler\n"
        "- Jest + React Testing Library\n\n"
        "## Conventions\n\n"
        "- `npm test` for tests, `npm run lint` for linting\n"
        "- Conventional commits: `fix(scope): description`\n"
        "- CSS modules or PatternFly utility classes\n"
    ),
    "backend": (
        "Backend persona for Go or Python services.\n\n"
        "## Conventions\n\n"
        "- Follow existing test patterns in the repo\n"
        "- Conventional commits: `fix(scope): description`\n"
    ),
    "config": (
        "Config persona for YAML/configuration-heavy repos.\n\n"
        "## Conventions\n\n"
        "- Validate YAML structure before committing\n"
        "- Follow existing naming patterns\n"
    ),
    "tooling": (
        "Tooling persona for infrastructure and build tooling.\n\n"
        "## Conventions\n\n"
        "- Shell scripts must pass shellcheck\n"
        "- Dockerfiles follow multi-stage build patterns\n"
    ),
    "operator": (
        "Operator persona for Kubernetes/OpenShift operators.\n\n"
        "## Stack\n\n"
        "- Go + controller-runtime / operator-sdk\n"
        "- CRDs and reconciliation loops\n\n"
        "## Conventions\n\n"
        "- `make test` for unit tests, `make e2e` for integration\n"
        "- Follow controller-runtime patterns for reconcile logic\n"
        "- Conventional commits: `fix(scope): description`\n"
    ),
}


def _parse_repo_basename(url, host_domain):
    stripped = url.strip(":/").removesuffix(".git")
    for sep in (f"{host_domain}:", f"{host_domain}/"):
        if sep in stripped:
            return stripped.split(sep, 1)[-1].split("/")[-1]
    return stripped.split("/")[-1]


def _build_project_repos(repos):
    result = {}
    for repo in repos:
        name = repo["name"]
        url = repo["url"]
        host = repo.get("host", "github")
        fork_account = repo.get("fork_account", GH_FORK_ACCOUNT if host == "github" else GL_FORK_ACCOUNT)
        fork_repo_name = repo.get("fork_name")
        readonly = repo.get("readonly", False)

        entry = {}
        if readonly:
            entry["url"] = url
            entry["readonly"] = True
        elif host == "github":
            repo_basename = fork_repo_name or _parse_repo_basename(url, "github.com")
            entry["url"] = f"https://github.com/{fork_account}/{repo_basename}.git"
            entry["upstream"] = url
        elif host == "gitlab":
            repo_basename = fork_repo_name or _parse_repo_basename(url, "gitlab.cee.redhat.com")
            entry["url"] = f"https://gitlab.cee.redhat.com/{fork_account}/{repo_basename}.git"
            entry["upstream"] = url
            entry["host"] = "gitlab"
        else:
            entry["url"] = url

        result[name] = entry
    return result


def _gen_instance_yaml(req):
    lines = [
        f"workflow: {req.get('workflow', 'jira-sprint')}",
        f"source: {req.get('source', 'jira')}",
    ]
    envs = req.get("envs", [])
    if envs:
        lines.append("envs:")
        for env in envs:
            lines.append(f"  - {env}")

    strategy = req.get("claude_md_strategy", "append")
    lines.append("claude_md:")
    lines.append(f"  strategy: {strategy}")

    return "\n".join(lines) + "\n"


def _gen_mcp_json():
    return json.dumps(
        {
            "mcpServers": {
                "mcp-atlassian": {
                    "type": "http",
                    "url": "${JIRA_MCP_URL}",
                }
            }
        },
        indent=2,
    ) + "\n"


def _gen_setup_sh(instance_name):
    return (
        '#!/bin/bash\nset -e\n\n'
        f'echo "{instance_name}" > /home/botuser/app/.instance-id\n\n'
        '# Instance-specific packages and tools go here:\n'
        '# dnf install -y --nodocs <package>\n'
        '# pip3.12 install <package>\n'
        '# npm install -g <package>\n\n'
        f'echo "Instance setup complete: {instance_name}"\n'
    )


def _gen_claude_md(req):
    instance_name = req["instance_name"]
    team_name = req.get("team_name", instance_name)
    repos = req.get("repos", [])
    tech_stacks = req.get("tech_stacks", [])

    lines = [f"# {instance_name} — Additional Instructions\n"]

    if repos:
        lines.append("## Target Repos\n")
        for r in repos:
            lines.append(f"- **{r['name']}**: `{r['url']}`")
        lines.append("")

    if tech_stacks:
        lines.append("## Detected Tech Stacks\n")
        for ts in tech_stacks:
            envs = ", ".join(ts.get("envs", []))
            personas = ", ".join(ts.get("personas", []))
            lines.append(f"- **{ts.get('repo', '?')}**: envs=[{envs}], personas=[{personas}]")
        lines.append("")

    lines.append("## Team Conventions\n")
    lines.append("<!-- Fill in team-specific conventions after scaffolding -->")
    lines.append("<!-- Examples: version managers, test commands, PR review norms -->\n")

    return "\n".join(lines) + "\n"


def _gen_gitmodules():
    return (
        '[submodule "dev-bot"]\n'
        "\tpath = dev-bot\n"
        "\turl = https://github.com/OpenShift-Fleet/rehor.git\n"
    )


def _gen_readme(instance_name, team_name):
    return (
        f"# {instance_name}\n\n"
        f"Rehor bot instance for {team_name}.\n\n"
        "## Setup\n\n"
        "```bash\n"
        "git clone --recurse-submodules <this-repo-url>\n"
        "cd " + instance_name + "\n"
        "```\n\n"
        "## Submodule Update\n\n"
        "```bash\n"
        "git submodule update --remote dev-bot\n"
        "git add dev-bot\n"
        'git commit -m "chore: bump dev-bot submodule"\n'
        "```\n\n"
        "## Build\n\n"
        "Builds are handled by Konflux CI. The `.tekton/` pipeline files are generated by the\n"
        "Konflux UI after Component registration. The Dockerfile is at `dev-bot/Dockerfile.runner`.\n"
    )


def _workflow_env_vars(workflow):
    if workflow == "jira-sprint":
        return (
            "- name: BOT_BOARD_NAME\n"
            "            value: ${BOT_BOARD_NAME}\n"
            "          - name: BOT_SPRINT_PREFIX\n"
            "            value: ${BOT_SPRINT_PREFIX}\n"
            "          - name: BOT_INCLUDE_BACKLOG\n"
            "            value: ${BOT_INCLUDE_BACKLOG}"
        )
    elif workflow == "jira-kanban":
        return (
            "- name: BOT_BOARD_ID\n"
            "            value: ${BOT_BOARD_ID}\n"
            "          - name: BOT_JIRA_PROJECT\n"
            "            value: ${BOT_JIRA_PROJECT}"
        )
    return "# No workflow-specific env vars"


def _gen_deploy_template(req):
    instance_name = req["instance_name"]
    config_name = req.get("config_name", req["instance_name"].replace("-agent-dev", "-config").replace("-ai-dev", "-config"))
    bot_name = req.get("bot_name", f"devbot-{config_name.removesuffix('-config')}")
    bot_label = req.get("bot_label", f"hcc-ai-{config_name.removesuffix('-config')}")
    quay_image = f"quay.io/redhat-services-prod/REPLACE-WITH-KONFLUX-TENANT/{instance_name}"
    keda = req.get("keda_schedule", DEFAULT_KEDA)
    workflow = req.get("workflow", "jira-sprint")
    envs = req.get("envs", [])
    has_browser = "browser" in envs
    resources = req.get("resources", {})
    cpu_req = resources.get("cpu_request", "1")
    cpu_lim = resources.get("cpu_limit", "4" if has_browser else "2")
    mem_req = resources.get("memory_request", "4Gi" if has_browser else "2Gi")
    mem_lim = resources.get("memory_limit", "6Gi" if has_browser else "4Gi")
    eph_req = resources.get("ephemeral_request", "4Gi")
    eph_lim = resources.get("ephemeral_limit", "8Gi")

    workflow_params = ""
    if workflow == "jira-sprint":
        workflow_params = (
            "- name: BOT_BOARD_NAME\n"
            '  value: ""\n'
            "- name: BOT_SPRINT_PREFIX\n"
            '  value: ""\n'
            "- name: BOT_INCLUDE_BACKLOG\n"
            '  value: "false"\n'
        )
    elif workflow == "jira-kanban":
        workflow_params = (
            "- name: BOT_BOARD_ID\n"
            '  value: ""\n'
            "- name: BOT_JIRA_PROJECT\n"
            '  value: ""\n'
        )

    return f"""apiVersion: template.openshift.io/v1
kind: Template
metadata:
  name: {instance_name}
parameters:
- name: NAMESPACE
  value: ${{NAMESPACE}}
- name: BOT_IMAGE
  value: {quay_image}
- name: IMAGE_TAG
  required: true
- name: BOT_LABEL
  value: {bot_label}
- name: BOT_REPLICAS
  value: "0"
{workflow_params}- name: BOT_INSTANCE_ID
  value: ""
- name: BOT_CONFIG_REPO
  value: ""
- name: BOT_NAME
  value: {bot_name}
- name: BOT_CONFIG_PATH
  value: ""
- name: GCP_PROJECT_ID
  required: true
- name: GCP_REGION
  required: true
- name: VERTEX_ALLOWED_MODELS
  required: true
- name: SLACK_WEBHOOK_URL
  value: ""
objects:

# Bot-only deployment for {instance_name} runner instance.
# Shared infrastructure (proxy, memory-server, secrets) deployed by
# platform-frontend-ai-dev template in the same namespace.

# --- Bot Deployment ---
- apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: ${{BOT_NAME}}
    labels:
      app.kubernetes.io/name: ${{BOT_NAME}}
      app.kubernetes.io/component: bot
      app.kubernetes.io/part-of: devbot
  spec:
    replicas: ${{{{BOT_REPLICAS}}}}
    selector:
      matchLabels:
        app.kubernetes.io/name: ${{BOT_NAME}}
    template:
      metadata:
        labels:
          app.kubernetes.io/name: ${{BOT_NAME}}
          app.kubernetes.io/component: bot
          app.kubernetes.io/part-of: devbot
      spec:
        containers:
        - name: bot
          image: ${{BOT_IMAGE}}:${{IMAGE_TAG}}
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            seccompProfile:
              type: RuntimeDefault
            capabilities:
              drop: ["ALL"]
          env:
          - name: BOT_LABEL
            value: ${{BOT_LABEL}}
          - name: BOT_MEMORY_URL
            value: http://devbot-memory-server:8080/mcp
          - name: BOT_MEMORY_HEALTH_URL
            value: http://devbot-memory-server:8080/health
          - name: BOT_MEMORY_HEALTH_TIMEOUT
            value: "120"
          - name: CLAUDE_CODE_SKIP_VERTEX_AUTH
            value: "true"
          - name: ANTHROPIC_VERTEX_BASE_URL
            value: http://devbot-proxy:8443
          - name: ANTHROPIC_VERTEX_PROJECT_ID
            value: dummy-project
          - name: CLOUD_ML_REGION
            value: global
          - name: EXECUTOR_ADDR
            value: devbot-proxy:9090
          - name: HUSKY
            value: "0"
          - name: GH_USER_NAME
            valueFrom:
              secretKeyRef:
                name: devbot-secrets
                key: bot-gh-username
          - name: GH_USER_EMAIL
            valueFrom:
              secretKeyRef:
                name: devbot-secrets
                key: bot-email
          - name: GL_USER_NAME
            valueFrom:
              secretKeyRef:
                name: devbot-secrets
                key: bot-gl-name
          - name: GL_USER_EMAIL
            valueFrom:
              secretKeyRef:
                name: devbot-secrets
                key: bot-gl-email
          - name: BOT_JIRA_EMAIL
            valueFrom:
              secretKeyRef:
                name: devbot-secrets
                key: jira-email
          {"- name: SSO_USERNAME" + chr(10) + "            valueFrom:" + chr(10) + "              secretKeyRef:" + chr(10) + "                name: devbot-secrets" + chr(10) + "                key: e2e-username" + chr(10) + "          - name: SSO_PASSWORD" + chr(10) + "            valueFrom:" + chr(10) + "              secretKeyRef:" + chr(10) + "                name: devbot-secrets" + chr(10) + "                key: e2e-password" if "browser" in envs else "# No SSO credentials (no browser env)"}
          {_workflow_env_vars(workflow)}
          - name: BOT_INSTANCE_ID
            value: ${{BOT_INSTANCE_ID}}
          - name: BOT_CONFIG_REPO
            value: ${{BOT_CONFIG_REPO}}
          - name: BOT_CONFIG_PATH
            value: ${{BOT_CONFIG_PATH}}
          - name: BOT_DASHBOARD_URL
            value: http://devbot-memory-server:8080/api/bot-status
          - name: COSTS_API_URL
            value: http://devbot-memory-server:8080/api/costs
          - name: SLACK_WEBHOOK_URL
            value: ${{SLACK_WEBHOOK_URL}}
          - name: PROXY_HOST
            value: devbot-proxy
          - name: HTTP_PROXY
            value: http://devbot-proxy:3128
          - name: HTTPS_PROXY
            value: http://devbot-proxy:3128
          - name: http_proxy
            value: http://devbot-proxy:3128
          - name: https_proxy
            value: http://devbot-proxy:3128
          - name: NO_PROXY
            value: devbot-memory-server,devbot-proxy,localhost,127.0.0.1
          - name: no_proxy
            value: devbot-memory-server,devbot-proxy,localhost,127.0.0.1
          - name: JIRA_MCP_URL
            value: http://devbot-proxy:8444/mcp
          - name: GH_RELEASE_UPLOAD_URL
            value: http://devbot-proxy:8446/upload
          resources:
            requests:
              cpu: "{cpu_req}"
              memory: {mem_req}
              ephemeral-storage: {eph_req}
            limits:
              cpu: "{cpu_lim}"
              memory: {mem_lim}
              ephemeral-storage: {eph_lim}

# --- NetworkPolicy: Bot can only reach proxy + memory-server ---
- apiVersion: networking.k8s.io/v1
  kind: NetworkPolicy
  metadata:
    name: ${{BOT_NAME}}-egress
    labels:
      app.kubernetes.io/part-of: devbot
  spec:
    podSelector:
      matchLabels:
        app.kubernetes.io/name: ${{BOT_NAME}}
    policyTypes:
    - Egress
    egress:
    - to:
      - podSelector:
          matchLabels:
            app.kubernetes.io/name: devbot-proxy
      ports:
      - port: 3128
        protocol: TCP
      - port: 9090
        protocol: TCP
      - port: 8443
        protocol: TCP
      - port: 8444
        protocol: TCP
      - port: 8446
        protocol: TCP
    - to:
      - podSelector:
          matchLabels:
            app.kubernetes.io/name: memory-server
      ports:
      - port: 8080
        protocol: TCP
    - to:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: openshift-dns
      ports:
      - port: 5353
        protocol: UDP
      - port: 5353
        protocol: TCP

# --- Cron Scaler ---
- apiVersion: keda.sh/v1alpha1
  kind: ScaledObject
  metadata:
    name: ${{BOT_NAME}}-cron-scaler
    labels:
      app.kubernetes.io/name: ${{BOT_NAME}}
      app.kubernetes.io/part-of: devbot
  spec:
    scaleTargetRef:
      apiVersion: apps/v1
      kind: Deployment
      name: ${{BOT_NAME}}
    minReplicaCount: 0
    maxReplicaCount: 1
    triggers:
    - type: cron
      metadata:
        timezone: "{keda['timezone']}"
        start: "{keda['start']}"
        end: "{keda['end']}"
        desiredReplicas: "1"
"""


def generate(req, output_dir):
    root = Path(output_dir)
    instance_name = req["instance_name"]
    config_name = req.get("config_name", instance_name.replace("-agent-dev", "-config").replace("-ai-dev", "-config"))
    team_name = req.get("team_name", instance_name)

    agent_dir = root / "instance" / config_name / "agent"
    deploy_dir = root / "deploy"

    for d in (agent_dir, deploy_dir):
        d.mkdir(parents=True, exist_ok=True)

    (root / ".gitmodules").write_text(_gen_gitmodules())
    (root / "setup.sh").write_text(_gen_setup_sh(instance_name))
    os.chmod(root / "setup.sh", 0o755)
    (root / "README.md").write_text(_gen_readme(instance_name, team_name))

    (agent_dir / "instance.yaml").write_text(_gen_instance_yaml(req))
    (agent_dir / "mcp.json").write_text(_gen_mcp_json())

    strategy = req.get("claude_md_strategy", "append")
    if strategy != "ignore":
        (agent_dir / "CLAUDE.md").write_text(_gen_claude_md(req))

    repos = req.get("repos", [])
    project_repos = _build_project_repos(repos)
    (agent_dir / "project-repos.json").write_text(json.dumps(project_repos, indent=2) + "\n")

    tech_stacks = req.get("tech_stacks", [])
    personas_seen = set()
    for ts in tech_stacks:
        for persona in ts.get("personas", []):
            if persona not in personas_seen:
                personas_seen.add(persona)
                persona_dir = agent_dir / "personas" / persona
                persona_dir.mkdir(parents=True, exist_ok=True)
                template = PERSONA_TEMPLATES.get(persona, f"{persona} persona.\n")
                (persona_dir / "prompt.md").write_text(template)
                stub_mcp = {"mcpServers": {}}
                (persona_dir / "mcp.json").write_text(json.dumps(stub_mcp, indent=2) + "\n")

    if not personas_seen:
        persona_dir = agent_dir / "personas" / "default"
        persona_dir.mkdir(parents=True, exist_ok=True)
        (persona_dir / "prompt.md").write_text("Default persona. Adapt to the repo's conventions.\n")
        stub_mcp = {"mcpServers": {}}
        (persona_dir / "mcp.json").write_text(json.dumps(stub_mcp, indent=2) + "\n")

    (deploy_dir / "template.yaml").write_text(_gen_deploy_template(req))

    files = sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())
    return {"output_dir": str(root), "files": files}


def main():
    if len(sys.argv) < 3:
        print("Usage: generate_instance.py '<json_requirements>' <output_dir>", file=sys.stderr)
        sys.exit(1)

    try:
        req = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
        sys.exit(1)

    output_dir = sys.argv[2]
    if not req.get("instance_name"):
        print(json.dumps({"error": "instance_name is required"}))
        sys.exit(1)

    result = generate(req, output_dir)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
