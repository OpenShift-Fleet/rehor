#!/usr/bin/env python3
"""Generate all scaffolding files for a new Rehor bot instance runner repo.

Usage:
    python3 generate_instance.py '<json_requirements>' <output_dir>
    python3 generate_instance.py --validate-only '<json_requirements>'

Writes the complete directory tree for a new instance repo.
"""

import json
import os
import stat
import sys
import tempfile
from pathlib import Path

import jsonschema
import yaml
from jinja2 import Environment, FileSystemLoader

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

SKILL_DIR = Path(__file__).parent
TEMPLATES_DIR = SKILL_DIR / "templates"
SCHEMA_PATH = SKILL_DIR / "schema.json"


def _load_jinja_env():
    return Environment(
        loader=FileSystemLoader(str(TEMPLATES_DIR)),
        variable_start_string="<<",
        variable_end_string=">>",
        block_start_string="<%",
        block_end_string="%>",
        comment_start_string="{#",
        comment_end_string="#}",
        keep_trailing_newline=True,
        trim_blocks=True,
        lstrip_blocks=True,
    )


def _validate_input(req):
    schema = json.loads(SCHEMA_PATH.read_text())
    jsonschema.validate(req, schema)


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
        fork_account = repo.get(
            "fork_account",
            GH_FORK_ACCOUNT if host == "github" else GL_FORK_ACCOUNT,
        )
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
    return (
        json.dumps(
            {
                "mcpServers": {
                    "mcp-atlassian": {
                        "type": "http",
                        "url": "${JIRA_MCP_URL}",
                    }
                }
            },
            indent=2,
        )
        + "\n"
    )


def _gen_gitmodules():
    return '[submodule "dev-bot"]\n\tpath = dev-bot\n\turl = https://github.com/OpenShift-Fleet/rehor.git\n'


def _build_deploy_context(req):
    instance_name = req["instance_name"]
    default_config = instance_name.replace("-agent-dev", "-config").replace("-ai-dev", "-config")
    config_name = req.get("config_name", default_config)
    bot_name = req.get("bot_name", f"devbot-{config_name.removesuffix('-config')}")
    bot_label = req.get("bot_label", f"rehor-ai-{config_name.removesuffix('-config')}")
    quay_image = f"quay.io/redhat-services-prod/REPLACE-WITH-KONFLUX-TENANT/{instance_name}"
    keda = req.get("keda_schedule", DEFAULT_KEDA)
    workflow = req.get("workflow", "jira-sprint")
    envs = req.get("envs", [])
    has_browser = "browser" in envs
    resources = req.get("resources", {})

    return {
        "instance_name": instance_name,
        "bot_name": bot_name,
        "bot_label": bot_label,
        "quay_image": quay_image,
        "workflow": workflow,
        "has_browser": has_browser,
        "cpu_req": resources.get("cpu_request", "1"),
        "cpu_lim": resources.get("cpu_limit", "4" if has_browser else "2"),
        "mem_req": resources.get("memory_request", "4Gi" if has_browser else "2Gi"),
        "mem_lim": resources.get("memory_limit", "6Gi" if has_browser else "4Gi"),
        "eph_req": resources.get("ephemeral_request", "4Gi"),
        "eph_lim": resources.get("ephemeral_limit", "8Gi"),
        "keda": keda,
    }


def validate_output(output_dir):
    root = Path(output_dir)
    errors = []

    required_files = [".gitmodules", "setup.sh", "README.md"]
    for f in required_files:
        if not (root / f).exists():
            errors.append(f"Missing required file: {f}")

    if not (root / "deploy" / "template.yaml").exists():
        errors.append("Missing required file: deploy/template.yaml")

    instance_dir = root / "instance"
    if not instance_dir.exists():
        errors.append("Missing instance/ directory")
    else:
        config_dirs = [d for d in instance_dir.iterdir() if d.is_dir()]
        if not config_dirs:
            errors.append("No config directory found under instance/")
        for config_dir in config_dirs:
            agent_dir = config_dir / "agent"
            for f in ("instance.yaml", "mcp.json", "project-repos.json"):
                if not (agent_dir / f).exists():
                    errors.append(f"Missing: instance/{config_dir.name}/agent/{f}")

    for json_file in root.rglob("*.json"):
        try:
            json.loads(json_file.read_text())
        except json.JSONDecodeError as e:
            errors.append(f"Invalid JSON in {json_file.relative_to(root)}: {e}")

    for yaml_file in root.rglob("*.yaml"):
        try:
            yaml.safe_load(yaml_file.read_text())
        except yaml.YAMLError as e:
            errors.append(f"Invalid YAML in {yaml_file.relative_to(root)}: {e}")

    setup_sh = root / "setup.sh"
    if setup_sh.exists() and not (setup_sh.stat().st_mode & stat.S_IXUSR):
        errors.append("setup.sh is not executable")

    deploy_yaml = root / "deploy" / "template.yaml"
    if deploy_yaml.exists():
        content = deploy_yaml.read_text()
        for marker in (
            "apiVersion: template.openshift.io/v1",
            "ScaledObject",
            "NetworkPolicy",
        ):
            if marker not in content:
                errors.append(f"deploy/template.yaml missing required marker: {marker}")

    return errors


def generate(req, output_dir):
    env = _load_jinja_env()
    root = Path(output_dir)
    instance_name = req["instance_name"]
    config_name = req.get(
        "config_name",
        instance_name.replace("-agent-dev", "-config").replace("-ai-dev", "-config"),
    )
    team_name = req.get("team_name", instance_name)
    agent_dir = root / "instance" / config_name / "agent"
    deploy_dir = root / "deploy"

    for d in (agent_dir, deploy_dir):
        d.mkdir(parents=True, exist_ok=True)

    (root / ".gitmodules").write_text(_gen_gitmodules())

    setup_tpl = env.get_template("setup.sh.j2")
    (root / "setup.sh").write_text(setup_tpl.render(instance_name=instance_name))
    os.chmod(root / "setup.sh", 0o755)

    readme_tpl = env.get_template("readme.md.j2")
    (root / "README.md").write_text(readme_tpl.render(instance_name=instance_name, team_name=team_name))

    (agent_dir / "instance.yaml").write_text(_gen_instance_yaml(req))
    (agent_dir / "mcp.json").write_text(_gen_mcp_json())

    strategy = req.get("claude_md_strategy", "append")
    if strategy != "ignore":
        claude_tpl = env.get_template("claude.md.j2")
        (agent_dir / "CLAUDE.md").write_text(
            claude_tpl.render(
                instance_name=instance_name,
                repos=req.get("repos", []),
                tech_stacks=req.get("tech_stacks", []),
            )
        )

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

    deploy_tpl = env.get_template("deploy-template.yaml.j2")
    deploy_ctx = _build_deploy_context(req)
    (deploy_dir / "template.yaml").write_text(deploy_tpl.render(**deploy_ctx))

    github_org = req.get("github_org", "RedHatInsights")
    manifest = {
        "repos": [
            {
                "name": instance_name,
                "upstream": (f"https://github.com/{github_org}/{instance_name}"),
                "host": "github",
            }
        ]
    }
    (root / "fork-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    files = sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())
    return {
        "output_dir": str(root),
        "files": files,
        "fork_manifest": str(root / "fork-manifest.json"),
    }


def main():
    validate_only = "--validate-only" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--validate-only"]

    if validate_only:
        if len(args) < 1:
            print(
                "Usage: generate_instance.py --validate-only '<json>'",
                file=sys.stderr,
            )
            sys.exit(1)
    elif len(args) < 2:
        print(
            "Usage: generate_instance.py '<json_requirements>' <output_dir>",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        req = json.loads(args[0])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
        sys.exit(1)

    try:
        _validate_input(req)
    except jsonschema.ValidationError as e:
        print(json.dumps({"error": f"Schema validation failed: {e.message}"}))
        sys.exit(1)

    if validate_only:
        with tempfile.TemporaryDirectory() as tmpdir:
            try:
                generate(req, tmpdir)
            except Exception as e:
                print(json.dumps({"error": f"Template rendering failed: {e}"}))
                sys.exit(1)
            errors = validate_output(tmpdir)
        if errors:
            print(json.dumps({"valid": False, "errors": errors}, indent=2))
            sys.exit(1)
        print(json.dumps({"valid": True, "errors": []}))
        sys.exit(0)

    output_dir = args[1]
    result = generate(req, output_dir)

    errors = validate_output(output_dir)
    if errors:
        result["validation_warnings"] = errors
        print(
            f"WARNING: {len(errors)} validation issue(s):",
            file=sys.stderr,
        )
        for e in errors:
            print(f"  - {e}", file=sys.stderr)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
