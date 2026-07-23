"""Tests for generate-instance: schema validation, template rendering, output validation."""

import json
import stat

import pytest
import yaml
from generate_instance import _validate_input, generate, validate_output

SPRINT_CONFIG = {
    "instance_name": "test-team-agent-dev",
    "config_name": "test-config",
    "team_name": "Test Team",
    "workflow": "jira-sprint",
    "envs": ["node"],
    "repos": [
        {
            "name": "test-frontend",
            "url": "https://github.com/RedHatInsights/test-frontend.git",
            "host": "github",
        }
    ],
}

KANBAN_CONFIG = {
    "instance_name": "kanban-team-agent-dev",
    "config_name": "kanban-config",
    "team_name": "Kanban Team",
    "workflow": "jira-kanban",
    "envs": ["go"],
    "repos": [
        {
            "name": "kanban-service",
            "url": "https://github.com/RedHatInsights/kanban-service.git",
        }
    ],
}

BROWSER_CONFIG = {
    "instance_name": "browser-team-agent-dev",
    "workflow": "jira-sprint",
    "envs": ["node", "browser"],
    "repos": [
        {
            "name": "browser-app",
            "url": "https://github.com/RedHatInsights/browser-app.git",
        }
    ],
}


class TestSchemaValidation:
    def test_valid_sprint_config(self):
        _validate_input(SPRINT_CONFIG)

    def test_valid_kanban_config(self):
        _validate_input(KANBAN_CONFIG)

    def test_valid_browser_config(self):
        _validate_input(BROWSER_CONFIG)

    def test_minimal_config(self):
        _validate_input({"instance_name": "minimal-bot"})

    def test_missing_instance_name(self):
        with pytest.raises(Exception, match="instance_name"):
            _validate_input({"workflow": "jira-sprint"})

    def test_invalid_instance_name_uppercase(self):
        with pytest.raises(Exception, match="instance_name"):
            _validate_input({"instance_name": "Bad-Name"})

    def test_invalid_instance_name_starts_with_dash(self):
        with pytest.raises(Exception, match="instance_name"):
            _validate_input({"instance_name": "-bad-name"})

    def test_invalid_workflow(self):
        with pytest.raises(Exception, match="workflow"):
            _validate_input({"instance_name": "test-bot", "workflow": "github-issues"})

    def test_invalid_claude_md_strategy(self):
        with pytest.raises(Exception, match="claude_md_strategy"):
            _validate_input({"instance_name": "test-bot", "claude_md_strategy": "merge"})

    def test_repo_missing_url(self):
        with pytest.raises(Exception, match="url"):
            _validate_input({
                "instance_name": "test-bot",
                "repos": [{"name": "my-repo"}],
            })

    def test_repo_missing_name(self):
        with pytest.raises(Exception, match="name"):
            _validate_input({
                "instance_name": "test-bot",
                "repos": [{"url": "https://github.com/org/repo.git"}],
            })

    def test_rejects_extra_root_fields(self):
        with pytest.raises(Exception, match="Additional properties"):
            _validate_input({"instance_name": "test-bot", "unknown_field": "value"})

    def test_rejects_extra_repo_fields(self):
        with pytest.raises(Exception, match="Additional properties"):
            _validate_input({
                "instance_name": "test-bot",
                "repos": [{"name": "r", "url": "https://x.git", "extra": True}],
            })

    def test_invalid_repo_host(self):
        with pytest.raises(Exception, match="host"):
            _validate_input({
                "instance_name": "test-bot",
                "repos": [{"name": "r", "url": "https://x.git", "host": "bitbucket"}],
            })


GITLAB_CONFIG = {
    "instance_name": "gitlab-team-agent-dev",
    "workflow": "jira-sprint",
    "repos": [
        {
            "name": "gl-service",
            "url": "https://gitlab.cee.redhat.com/some-org/gl-service.git",
            "host": "gitlab",
        },
        {
            "name": "gl-custom-fork",
            "url": "https://gitlab.cee.redhat.com/some-org/gl-custom-fork.git",
            "host": "gitlab",
            "fork_account": "custom-bot",
            "fork_name": "my-fork",
        },
    ],
}

PERSONAS_CONFIG = {
    "instance_name": "personas-team-agent-dev",
    "workflow": "jira-sprint",
    "repos": [
        {
            "name": "my-app",
            "url": "https://github.com/RedHatInsights/my-app.git",
        }
    ],
    "tech_stacks": [
        {"repo": "my-app", "personas": ["frontend", "backend"], "envs": ["node", "go"]},
    ],
}


class TestTemplateRendering:
    def test_sprint_generates_all_files(self, tmp_path):
        result = generate(SPRINT_CONFIG, str(tmp_path))
        assert ".gitmodules" in result["files"]
        assert "setup.sh" in result["files"]
        assert "README.md" in result["files"]
        assert "deploy/template.yaml" in result["files"]
        assert "instance/test-config/agent/instance.yaml" in result["files"]
        assert "instance/test-config/agent/mcp.json" in result["files"]
        assert "instance/test-config/agent/project-repos.json" in result["files"]

    def test_kanban_generates_all_files(self, tmp_path):
        result = generate(KANBAN_CONFIG, str(tmp_path))
        assert "deploy/template.yaml" in result["files"]
        assert "instance/kanban-config/agent/instance.yaml" in result["files"]

    def test_deploy_yaml_is_valid(self, tmp_path):
        generate(SPRINT_CONFIG, str(tmp_path))
        content = (tmp_path / "deploy" / "template.yaml").read_text()
        parsed = yaml.safe_load(content)
        assert parsed["apiVersion"] == "template.openshift.io/v1"
        assert parsed["kind"] == "Template"

    def test_sprint_has_board_params(self, tmp_path):
        generate(SPRINT_CONFIG, str(tmp_path))
        content = (tmp_path / "deploy" / "template.yaml").read_text()
        assert "BOT_BOARD_NAME" in content
        assert "BOT_SPRINT_PREFIX" in content
        assert "BOT_BOARD_ID" not in content

    def test_kanban_has_board_params(self, tmp_path):
        generate(KANBAN_CONFIG, str(tmp_path))
        content = (tmp_path / "deploy" / "template.yaml").read_text()
        assert "BOT_BOARD_ID" in content
        assert "BOT_JIRA_PROJECT" in content
        assert "BOT_BOARD_NAME" not in content

    def test_browser_has_sso_env_vars(self, tmp_path):
        generate(BROWSER_CONFIG, str(tmp_path))
        content = (tmp_path / "deploy" / "template.yaml").read_text()
        assert "SSO_USERNAME" in content
        assert "SSO_PASSWORD" in content

    def test_no_browser_no_sso(self, tmp_path):
        generate(SPRINT_CONFIG, str(tmp_path))
        content = (tmp_path / "deploy" / "template.yaml").read_text()
        assert "SSO_USERNAME" not in content

    def test_setup_sh_is_executable(self, tmp_path):
        generate(SPRINT_CONFIG, str(tmp_path))
        mode = (tmp_path / "setup.sh").stat().st_mode
        assert mode & stat.S_IXUSR

    def test_json_files_are_valid(self, tmp_path):
        generate(SPRINT_CONFIG, str(tmp_path))
        for json_file in tmp_path.rglob("*.json"):
            json.loads(json_file.read_text())

    def test_claude_md_ignored_strategy(self, tmp_path):
        config = {**SPRINT_CONFIG, "claude_md_strategy": "ignore"}
        generate(config, str(tmp_path))
        assert not (tmp_path / "instance" / "test-config" / "agent" / "CLAUDE.md").exists()

    def test_browser_gets_higher_resources(self, tmp_path):
        generate(BROWSER_CONFIG, str(tmp_path))
        content = (tmp_path / "deploy" / "template.yaml").read_text()
        assert "4Gi" in content  # memory_request default for browser

    def test_gitlab_fork_urls(self, tmp_path):
        generate(GITLAB_CONFIG, str(tmp_path))
        repos = json.loads(
            (tmp_path / "instance" / "gitlab-team-config" / "agent" / "project-repos.json").read_text()
        )
        gl = repos["gl-service"]
        assert gl["url"] == "https://gitlab.cee.redhat.com/platform-experience-services-bot/gl-service.git"
        assert gl["upstream"] == "https://gitlab.cee.redhat.com/some-org/gl-service.git"
        assert gl["host"] == "gitlab"
        custom = repos["gl-custom-fork"]
        assert custom["url"] == "https://gitlab.cee.redhat.com/custom-bot/my-fork.git"

    def test_personas_from_tech_stacks(self, tmp_path):
        generate(PERSONAS_CONFIG, str(tmp_path))
        agent_dir = tmp_path / "instance" / "personas-team-config" / "agent"
        assert (agent_dir / "personas" / "frontend" / "prompt.md").exists()
        assert (agent_dir / "personas" / "backend" / "prompt.md").exists()
        assert not (agent_dir / "personas" / "default").exists()
        frontend_prompt = (agent_dir / "personas" / "frontend" / "prompt.md").read_text()
        assert "React" in frontend_prompt


class TestOutputValidation:
    def test_valid_output_no_errors(self, tmp_path):
        generate(SPRINT_CONFIG, str(tmp_path))
        errors = validate_output(str(tmp_path))
        assert errors == []

    def test_valid_kanban_no_errors(self, tmp_path):
        generate(KANBAN_CONFIG, str(tmp_path))
        errors = validate_output(str(tmp_path))
        assert errors == []

    def test_valid_browser_no_errors(self, tmp_path):
        generate(BROWSER_CONFIG, str(tmp_path))
        errors = validate_output(str(tmp_path))
        assert errors == []

    def test_catches_missing_deploy(self, tmp_path):
        generate(SPRINT_CONFIG, str(tmp_path))
        (tmp_path / "deploy" / "template.yaml").unlink()
        errors = validate_output(str(tmp_path))
        assert any("deploy/template.yaml" in e for e in errors)

    def test_catches_missing_setup_sh(self, tmp_path):
        generate(SPRINT_CONFIG, str(tmp_path))
        (tmp_path / "setup.sh").unlink()
        errors = validate_output(str(tmp_path))
        assert any("setup.sh" in e for e in errors)

    def test_catches_invalid_json(self, tmp_path):
        generate(SPRINT_CONFIG, str(tmp_path))
        mcp = tmp_path / "instance" / "test-config" / "agent" / "mcp.json"
        mcp.write_text("{broken json")
        errors = validate_output(str(tmp_path))
        assert any("Invalid JSON" in e for e in errors)

    def test_catches_invalid_yaml(self, tmp_path):
        generate(SPRINT_CONFIG, str(tmp_path))
        deploy = tmp_path / "deploy" / "template.yaml"
        deploy.write_text(":\n  bad:\n    - :\n  :\n")
        errors = validate_output(str(tmp_path))
        assert any("Invalid YAML" in e or "missing required marker" in e for e in errors)
