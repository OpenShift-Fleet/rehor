"""Tests for generate-instance: schema validation, template rendering, output validation."""

import json
import stat

import jsonschema
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

ONBOARDING_CONFIG = {
    "instance_name": "onboarding-agent-dev",
    "config_name": "onboarding-config",
    "team_name": "Onboarding Team",
    "workflow": "onboarding",
    "envs": ["node"],
    "repos": [
        {
            "name": "target-repo",
            "url": "https://github.com/RedHatInsights/target-repo.git",
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
            _validate_input(
                {
                    "instance_name": "test-bot",
                    "repos": [{"name": "my-repo"}],
                }
            )

    def test_repo_missing_name(self):
        with pytest.raises(Exception, match="name"):
            _validate_input(
                {
                    "instance_name": "test-bot",
                    "repos": [{"url": "https://github.com/org/repo.git"}],
                }
            )

    def test_rejects_extra_root_fields(self):
        with pytest.raises(Exception, match="Additional properties"):
            _validate_input({"instance_name": "test-bot", "unknown_field": "value"})

    def test_rejects_extra_repo_fields(self):
        with pytest.raises(Exception, match="Additional properties"):
            _validate_input(
                {
                    "instance_name": "test-bot",
                    "repos": [{"name": "r", "url": "https://x.git", "extra": True}],
                }
            )

    def test_invalid_repo_host(self):
        with pytest.raises(Exception, match="host"):
            _validate_input(
                {
                    "instance_name": "test-bot",
                    "repos": [{"name": "r", "url": "https://x.git", "host": "bitbucket"}],
                }
            )


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

    def test_kanban_has_board_params(self, tmp_path):
        generate(KANBAN_CONFIG, str(tmp_path))
        content = (tmp_path / "deploy" / "template.yaml").read_text()
        assert "BOT_BOARD_NAME" in content
        assert "BOT_JIRA_PROJECT" in content
        assert "BOT_SPRINT_PREFIX" not in content

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
        repos = json.loads((tmp_path / "instance" / "gitlab-team-config" / "agent" / "project-repos.json").read_text())
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


class TestSchemaSanitization:
    def test_rejects_config_name_with_traversal(self):
        with pytest.raises(Exception, match="config_name"):
            _validate_input({"instance_name": "test-bot", "config_name": "../etc"})

    def test_rejects_bot_name_with_spaces(self):
        with pytest.raises(Exception, match="bot_name"):
            _validate_input({"instance_name": "test-bot", "bot_name": "bad name"})

    def test_rejects_bot_label_with_slash(self):
        with pytest.raises(Exception, match="bot_label"):
            _validate_input({"instance_name": "test-bot", "bot_label": "bad/label"})

    def test_rejects_repo_url_without_http(self):
        with pytest.raises(Exception, match="repo_url"):
            _validate_input({"instance_name": "test-bot", "repo_url": "file:///etc/passwd"})

    def test_rejects_github_org_with_slash(self):
        with pytest.raises(Exception, match="github_org"):
            _validate_input({"instance_name": "test-bot", "github_org": "../../etc"})

    def test_rejects_env_with_traversal(self):
        with pytest.raises(Exception, match="envs"):
            _validate_input({"instance_name": "test-bot", "envs": ["../bad"]})

    def test_rejects_fork_account_with_slash(self):
        with pytest.raises(jsonschema.ValidationError):
            _validate_input(
                {
                    "instance_name": "test-bot",
                    "repos": [{"name": "r", "url": "https://x.com/r", "fork_account": "a/b"}],
                }
            )

    def test_rejects_invalid_resource_value(self):
        with pytest.raises(jsonschema.ValidationError):
            _validate_input(
                {
                    "instance_name": "test-bot",
                    "resources": {"cpu_request": "1; echo pwned"},
                }
            )

    def test_rejects_target_branch_with_space(self):
        with pytest.raises(Exception, match="target_branch"):
            _validate_input({"instance_name": "test-bot", "target_branch": "main branch"})

    def test_accepts_valid_target_branch_with_slash(self):
        _validate_input({"instance_name": "test-bot", "target_branch": "release/1.0"})

    def test_rejects_invalid_source(self):
        with pytest.raises(Exception, match="source"):
            _validate_input({"instance_name": "test-bot", "source": "github"})


class TestPathContainment:
    def test_config_name_traversal_rejected(self, tmp_path):
        cfg = {**SPRINT_CONFIG, "config_name": "../../etc"}
        with pytest.raises(ValueError, match="config_name escapes"):
            generate(cfg, str(tmp_path))

    def test_persona_schema_rejects_traversal(self):
        with pytest.raises(jsonschema.ValidationError):
            _validate_input(
                {
                    "instance_name": "test-bot",
                    "tech_stacks": [{"repo": "x", "personas": ["../../etc"]}],
                }
            )

    def test_deep_persona_traversal_rejected(self, tmp_path):
        cfg = {
            **SPRINT_CONFIG,
            "tech_stacks": [{"repo": "x", "personas": ["../../../../../../tmp"]}],
        }
        with pytest.raises(ValueError, match="persona escapes"):
            generate(cfg, str(tmp_path))


class TestReadonlyGitlabHost:
    def test_readonly_gitlab_preserves_host(self, tmp_path):
        cfg = {
            "instance_name": "ro-gitlab-agent-dev",
            "repos": [
                {
                    "name": "gl-readonly",
                    "url": "https://gitlab.cee.redhat.com/org/gl-readonly.git",
                    "host": "gitlab",
                    "readonly": True,
                }
            ],
        }
        generate(cfg, str(tmp_path))
        repos = json.loads((tmp_path / "instance" / "ro-gitlab-config" / "agent" / "project-repos.json").read_text())
        assert repos["gl-readonly"]["host"] == "gitlab"
        assert repos["gl-readonly"]["readonly"] is True

    def test_readonly_github_no_host_field(self, tmp_path):
        cfg = {
            "instance_name": "ro-github-agent-dev",
            "repos": [
                {
                    "name": "gh-readonly",
                    "url": "https://github.com/org/gh-readonly.git",
                    "host": "github",
                    "readonly": True,
                }
            ],
        }
        generate(cfg, str(tmp_path))
        repos = json.loads((tmp_path / "instance" / "ro-github-config" / "agent" / "project-repos.json").read_text())
        assert "host" not in repos["gh-readonly"]


class TestKedaScheduleValidation:
    def test_rejects_partial_keda_schedule(self):
        with pytest.raises(Exception, match="required"):
            _validate_input({"instance_name": "test-bot", "keda_schedule": {"timezone": "UTC"}})

    def test_accepts_full_keda_schedule(self):
        _validate_input(
            {
                "instance_name": "test-bot",
                "keda_schedule": {"timezone": "America/New_York", "start": "0 9 * * 1-5", "end": "0 18 * * 1-5"},
            }
        )


class TestForkManifest:
    def test_no_repo_url_or_org_skips_manifest(self, tmp_path):
        cfg = {"instance_name": "no-url-agent-dev"}
        result = generate(cfg, str(tmp_path))
        assert "fork_manifest" not in result
        assert not (tmp_path / "fork-manifest.json").exists()

    def test_with_repo_url_creates_manifest(self, tmp_path):
        cfg = {"instance_name": "url-agent-dev", "repo_url": "https://github.com/org/url-agent-dev"}
        result = generate(cfg, str(tmp_path))
        assert "fork_manifest" in result
        manifest = json.loads((tmp_path / "fork-manifest.json").read_text())
        assert manifest["repos"][0]["upstream"] == "https://github.com/org/url-agent-dev"


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


class TestOnboardingWorkflow:
    def test_valid_schema(self):
        _validate_input(ONBOARDING_CONFIG)

    def test_generates_all_files(self, tmp_path):
        result = generate(ONBOARDING_CONFIG, str(tmp_path))
        assert "deploy/template.yaml" in result["files"]
        assert "instance/onboarding-config/agent/instance.yaml" in result["files"]

    def test_deploy_has_no_sprint_params(self, tmp_path):
        generate(ONBOARDING_CONFIG, str(tmp_path))
        content = (tmp_path / "deploy" / "template.yaml").read_text()
        assert "BOT_BOARD_NAME" not in content
        assert "BOT_SPRINT_PREFIX" not in content

    def test_deploy_has_no_kanban_params(self, tmp_path):
        generate(ONBOARDING_CONFIG, str(tmp_path))
        content = (tmp_path / "deploy" / "template.yaml").read_text()
        assert "BOT_BOARD_NAME" not in content
        assert "BOT_JIRA_PROJECT" not in content

    def test_deploy_yaml_is_valid(self, tmp_path):
        generate(ONBOARDING_CONFIG, str(tmp_path))
        content = (tmp_path / "deploy" / "template.yaml").read_text()
        parsed = yaml.safe_load(content)
        assert parsed["kind"] == "Template"

    def test_output_validates(self, tmp_path):
        generate(ONBOARDING_CONFIG, str(tmp_path))
        errors = validate_output(str(tmp_path))
        assert errors == []
