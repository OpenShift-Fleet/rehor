import subprocess

import pytest
import yaml
from generate_app_interface import (
    SAAS_SELF_SERVICE_REF,
    _add_self_service_datafile,
    _discover_gcp_project,
    _discover_namespace_ref,
    _discover_pipelines_ref,
    _yaml_quote,
    generate,
)

SHARED_CONFIG = {
    "instance_name": "test-agent-dev",
    "bot_name": "devbot-test",
    "bot_label": "rehor-ai-test",
    "instance_id": "Test Bot",
    "repo_url": "https://github.com/TestOrg/test-agent-dev",
    "quay_org": "test-tenant",
    "config_name": "test-config",
    "workflow": "jira-sprint",
    "board_name": "Test Board",
    "sprint_prefix": "Sprint",
    "gcp_project_id": "test-gcp-project",
    "gcp_region": "global",
    "target_branch": "main",
    "pattern": "shared",
}

SEPARATE_CONFIG = {
    **SHARED_CONFIG,
    "pattern": "separate",
    "team_name": "testteam",
    "service_tree": "testplatform/testteam",
    "namespace_ref": "/services/testplatform/testteam/namespaces/stage.testns01.yml",
    "pipelines_ref": "/services/testplatform/testteam/pipelines/tekton-test.yml",
}

KANBAN_CONFIG = {
    **SHARED_CONFIG,
    "workflow": "jira-kanban",
    "board_name": "123",
    "jira_project": "TEST",
}

EXISTING_DEPLOY_CONTENT = """\
---
$schema: /app-sre/saas-file-2.yml

name: platform-frontend-ai-dev
app:
  $ref: /services/insights/platform-frontend-ai-dev/app.yml

pipelinesProvider:
  $ref: /services/insights/platform-frontend-ai-dev/pipelines/tekton-test-pipelines.testcluster01.yml

imagePatterns:
- quay.io/redhat-services-prod/existing-org/existing-agent

resourceTemplates:
- name: existing-agent
  path: /deploy/template.yaml
  url: https://github.com/ExistingOrg/existing-agent
  targets:
  - namespace:
      $ref: /services/insights/platform-frontend-ai-dev/namespaces/stage.testns01.yml
    ref: main
    images:
    - org:
        $ref: /dependencies/quay/redhat-services-prod.yml
      name: existing-org/existing-agent
    parameters:
      BOT_REPLICAS: '0'
      GCP_PROJECT_ID: test-shared-gcp-project
"""

APP_YML_CONTENT = """\
---
name: platform-frontend-ai-dev
codeComponents:
- name: existing-agent
  resource: upstream
  url: https://github.com/ExistingOrg/existing-agent
"""

ROLE_FILE_CONTENT = """\
---
labels:
  team: test-team
self_service:
- change_type:
    $ref: /app-interface/changetype/saas-file-self-service.yml
  datafiles:
  - $ref: /services/insights/platform-frontend-ai-dev/existing-deploy.yml
"""

ROLE_FILE_NO_SS_CONTENT = """\
---
labels:
  team: test-team
"""

ROLE_FILE_OTHER_CT_CONTENT = """\
---
labels:
  team: test-team
self_service:
- change_type:
    $ref: /app-interface/changetype/other-change-type.yml
  datafiles:
  - $ref: /some/other/file.yml
"""


@pytest.fixture()
def app_interface_repo(tmp_path):
    subprocess.run(
        ["git", "init"],
        cwd=tmp_path,
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.email", "test@test.com"],
        cwd=tmp_path,
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=tmp_path,
        capture_output=True,
        check=True,
    )

    svc_dir = tmp_path / "data" / "services" / "insights" / "platform-frontend-ai-dev"
    svc_dir.mkdir(parents=True)
    (svc_dir / "deploy.yml").write_text(EXISTING_DEPLOY_CONTENT)
    (svc_dir / "app.yml").write_text(APP_YML_CONTENT)

    ns_dir = svc_dir / "namespaces"
    ns_dir.mkdir()
    (ns_dir / "stage.testns01.yml").write_text("---\nname: testns01\n")

    auth_dir = tmp_path / "data" / "services" / "app-sre" / "saas-file-auth"
    auth_dir.mkdir(parents=True)
    (auth_dir / "global.yml").write_text("---\n")

    quay_dir = tmp_path / "data" / "dependencies" / "quay"
    quay_dir.mkdir(parents=True)
    (quay_dir / "redhat-services-prod.yml").write_text("---\n")

    role_dir = tmp_path / "data" / "teams" / "insights" / "roles"
    role_dir.mkdir(parents=True)
    (role_dir / "test-role.yml").write_text(ROLE_FILE_CONTENT)

    return tmp_path


class TestDiscovery:
    def test_discovers_namespace_ref(self):
        ref = _discover_namespace_ref(EXISTING_DEPLOY_CONTENT)
        assert ref == "/services/insights/platform-frontend-ai-dev/namespaces/stage.testns01.yml"

    def test_returns_none_when_no_namespace(self):
        assert _discover_namespace_ref("no namespace here") is None

    def test_handles_extra_whitespace(self):
        content = "  - namespace:\n        $ref:   /some/path/ns.yml  \n"
        assert _discover_namespace_ref(content) == "/some/path/ns.yml"

    def test_discovers_gcp_project(self, app_interface_repo):
        gcp = _discover_gcp_project(str(app_interface_repo))
        assert gcp == "test-shared-gcp-project"

    def test_gcp_project_returns_none_when_no_deploy(self, tmp_path):
        assert _discover_gcp_project(str(tmp_path)) is None

    def test_gcp_project_returns_none_when_no_param(self, app_interface_repo):
        deploy = app_interface_repo / "data" / "services" / "insights" / "platform-frontend-ai-dev" / "deploy.yml"
        deploy.write_text("---\nname: empty\n")
        assert _discover_gcp_project(str(app_interface_repo)) is None

    def test_discovers_pipelines_ref(self, app_interface_repo):
        ref = _discover_pipelines_ref(str(app_interface_repo))
        assert ref == "/services/insights/platform-frontend-ai-dev/pipelines/tekton-test-pipelines.testcluster01.yml"

    def test_pipelines_ref_returns_none_when_no_deploy(self, tmp_path):
        assert _discover_pipelines_ref(str(tmp_path)) is None

    def test_pipelines_ref_returns_none_when_no_provider(self, app_interface_repo):
        deploy = app_interface_repo / "data" / "services" / "insights" / "platform-frontend-ai-dev" / "deploy.yml"
        deploy.write_text("---\nname: empty\n")
        assert _discover_pipelines_ref(str(app_interface_repo)) is None


class TestSharedPattern:
    def _read_shared_deploy(self, app_interface_repo):
        return (
            app_interface_repo
            / "data"
            / "services"
            / "insights"
            / "platform-frontend-ai-dev"
            / "test-agent-dev-deploy.yml"
        ).read_text()

    def test_returns_created(self, app_interface_repo):
        result = generate(SHARED_CONFIG, str(app_interface_repo))
        assert result["action"] == "created"
        assert "test-agent-dev-deploy.yml" in result["file"]

    def test_discovers_gcp_project_when_omitted(self, app_interface_repo):
        cfg = {k: v for k, v in SHARED_CONFIG.items() if k != "gcp_project_id"}
        result = generate(cfg, str(app_interface_repo))
        assert result["action"] == "created"
        content = self._read_shared_deploy(app_interface_repo)
        assert "GCP_PROJECT_ID: test-shared-gcp-project" in content

    def test_discovers_pipelines_ref(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = self._read_shared_deploy(app_interface_repo)
        assert "tekton-test-pipelines.testcluster01.yml" in content

    def test_pipelines_discovery_error_when_missing(self, app_interface_repo):
        deploy = app_interface_repo / "data" / "services" / "insights" / "platform-frontend-ai-dev" / "deploy.yml"
        deploy.write_text("---\nname: no-pipelines\n")
        cfg = {**SHARED_CONFIG, "gcp_project_id": "explicit"}
        result = generate(cfg, str(app_interface_repo))
        assert "error" in result

    def test_gcp_discovery_error_when_no_deploy(self, app_interface_repo):
        cfg = {k: v for k, v in SHARED_CONFIG.items() if k != "gcp_project_id"}
        deploy = app_interface_repo / "data" / "services" / "insights" / "platform-frontend-ai-dev" / "deploy.yml"
        deploy.write_text("---\nname: empty\n")
        result = generate(cfg, str(app_interface_repo))
        assert "error" in result

    def test_creates_separate_file(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        assert (
            app_interface_repo
            / "data"
            / "services"
            / "insights"
            / "platform-frontend-ai-dev"
            / "test-agent-dev-deploy.yml"
        ).exists()

    def test_does_not_modify_main_deploy(self, app_interface_repo):
        original = (
            app_interface_repo / "data" / "services" / "insights" / "platform-frontend-ai-dev" / "deploy.yml"
        ).read_text()
        generate(SHARED_CONFIG, str(app_interface_repo))
        after = (
            app_interface_repo / "data" / "services" / "insights" / "platform-frontend-ai-dev" / "deploy.yml"
        ).read_text()
        assert original == after

    def test_deploy_has_instance_name(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = self._read_shared_deploy(app_interface_repo)
        assert "- name: test-agent-dev" in content

    def test_deploy_has_image_pattern(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = self._read_shared_deploy(app_interface_repo)
        assert "test-tenant/test-agent-dev" in content

    def test_sprint_params(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = self._read_shared_deploy(app_interface_repo)
        assert "BOT_BOARD_NAME: Test Board" in content
        assert "BOT_SPRINT_PREFIX: Sprint" in content

    def test_bot_replicas_is_string_zero(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = self._read_shared_deploy(app_interface_repo)
        assert "BOT_REPLICAS: '0'" in content

    def test_uses_discovered_namespace_ref(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = self._read_shared_deploy(app_interface_repo)
        assert "/services/insights/platform-frontend-ai-dev/namespaces/stage.testns01.yml" in content

    def test_has_shared_app_ref(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = self._read_shared_deploy(app_interface_repo)
        assert "/services/insights/platform-frontend-ai-dev/app.yml" in content

    def test_instance_id_sets_bot_instance_id(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = self._read_shared_deploy(app_interface_repo)
        assert "BOT_INSTANCE_ID: Test Bot" in content

    def test_instance_id_defaults_to_instance_name(self, app_interface_repo):
        cfg = {k: v for k, v in SHARED_CONFIG.items() if k != "instance_id"}
        generate(cfg, str(app_interface_repo))
        content = self._read_shared_deploy(app_interface_repo)
        assert "BOT_INSTANCE_ID: test-agent-dev" in content

    def test_bot_name_set(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = self._read_shared_deploy(app_interface_repo)
        assert "BOT_NAME: devbot-test" in content

    def test_bot_label_set(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = self._read_shared_deploy(app_interface_repo)
        assert "BOT_LABEL: rehor-ai-test" in content

    def test_bot_config_path_set(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = self._read_shared_deploy(app_interface_repo)
        assert "BOT_CONFIG_PATH: instance/test-config" in content

    def test_bot_image_uses_quay_org_and_instance_name(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = self._read_shared_deploy(app_interface_repo)
        assert "BOT_IMAGE: quay.io/redhat-services-prod/test-tenant/test-agent-dev" in content

    def test_naming_defaults_from_config_name(self, app_interface_repo):
        """bot_name and bot_label derive from config_name slug, not instance_name."""
        cfg = {k: v for k, v in SHARED_CONFIG.items() if k not in ("bot_name", "bot_label")}
        generate(cfg, str(app_interface_repo))
        content = self._read_shared_deploy(app_interface_repo)
        assert "BOT_NAME: devbot-test" in content
        assert "BOT_LABEL: rehor-ai-test" in content

    def test_no_takeover(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = self._read_shared_deploy(app_interface_repo)
        assert "takeover" not in content

    def test_managed_resource_types(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = self._read_shared_deploy(app_interface_repo)
        assert "ScaledObject.keda.sh" in content


class TestDuplicateGuard:
    def test_second_run_unchanged(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        result = generate(SHARED_CONFIG, str(app_interface_repo))
        assert result["action"] == "unchanged"

    def test_no_content_duplication(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = (
            app_interface_repo
            / "data"
            / "services"
            / "insights"
            / "platform-frontend-ai-dev"
            / "test-agent-dev-deploy.yml"
        ).read_text()
        assert content.count("- name: test-agent-dev") == 1


class TestSeparatePattern:
    def test_returns_created(self, app_interface_repo):
        result = generate(SEPARATE_CONFIG, str(app_interface_repo))
        assert result["action"] == "created"

    def test_no_takeover(self, app_interface_repo):
        result = generate(SEPARATE_CONFIG, str(app_interface_repo))
        saas_path = app_interface_repo / result["file"]
        content = saas_path.read_text()
        assert "takeover" not in content

    def test_managed_resource_types(self, app_interface_repo):
        result = generate(SEPARATE_CONFIG, str(app_interface_repo))
        saas_path = app_interface_repo / result["file"]
        content = saas_path.read_text()
        assert "ScaledObject.keda.sh" in content

    def test_uses_explicit_namespace_ref(self, app_interface_repo):
        result = generate(SEPARATE_CONFIG, str(app_interface_repo))
        saas_path = app_interface_repo / result["file"]
        content = saas_path.read_text()
        assert "/services/testplatform/testteam/namespaces/stage.testns01.yml" in content

    def test_requires_namespace_ref(self, app_interface_repo):
        cfg = {k: v for k, v in SEPARATE_CONFIG.items() if k != "namespace_ref"}
        with pytest.raises(ValueError, match="namespace_ref is required"):
            generate(cfg, str(app_interface_repo))

    def test_requires_service_tree(self, app_interface_repo):
        cfg = {**SEPARATE_CONFIG}
        del cfg["service_tree"]
        with pytest.raises(ValueError, match="service_tree is required"):
            generate(cfg, str(app_interface_repo))

    def test_requires_gcp_project_id(self, app_interface_repo):
        cfg = {**SEPARATE_CONFIG}
        del cfg["gcp_project_id"]
        with pytest.raises(ValueError, match="gcp_project_id is required"):
            generate(cfg, str(app_interface_repo))

    def test_requires_pipelines_ref(self, app_interface_repo):
        cfg = {k: v for k, v in SEPARATE_CONFIG.items() if k != "pipelines_ref"}
        with pytest.raises(ValueError, match="pipelines_ref is required"):
            generate(cfg, str(app_interface_repo))

    def test_uses_explicit_pipelines_ref(self, app_interface_repo):
        result = generate(SEPARATE_CONFIG, str(app_interface_repo))
        saas_path = app_interface_repo / result["file"]
        content = saas_path.read_text()
        assert "/services/testplatform/testteam/pipelines/tekton-test.yml" in content


class TestKanbanWorkflow:
    def test_has_board_name(self, app_interface_repo):
        generate(KANBAN_CONFIG, str(app_interface_repo))
        content = (
            app_interface_repo
            / "data"
            / "services"
            / "insights"
            / "platform-frontend-ai-dev"
            / "test-agent-dev-deploy.yml"
        ).read_text()
        assert "BOT_BOARD_NAME: 123" in content

    def test_no_sprint_params(self, app_interface_repo):
        generate(KANBAN_CONFIG, str(app_interface_repo))
        content = (
            app_interface_repo
            / "data"
            / "services"
            / "insights"
            / "platform-frontend-ai-dev"
            / "test-agent-dev-deploy.yml"
        ).read_text()
        assert "BOT_SPRINT_PREFIX" not in content


class TestCodeComponent:
    def test_adds_code_component(self, app_interface_repo):
        result = generate(SHARED_CONFIG, str(app_interface_repo))
        assert "app_file" in result
        content = (
            app_interface_repo / "data" / "services" / "insights" / "platform-frontend-ai-dev" / "app.yml"
        ).read_text()
        assert "https://github.com/TestOrg/test-agent-dev" in content

    def test_no_duplicate_code_component(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        app_content = (
            app_interface_repo / "data" / "services" / "insights" / "platform-frontend-ai-dev" / "app.yml"
        ).read_text()
        count = app_content.count("https://github.com/TestOrg/test-agent-dev")
        generate(SHARED_CONFIG, str(app_interface_repo))
        app_content2 = (
            app_interface_repo / "data" / "services" / "insights" / "platform-frontend-ai-dev" / "app.yml"
        ).read_text()
        assert app_content2.count("https://github.com/TestOrg/test-agent-dev") == count

    def test_preserves_yaml_header(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = (
            app_interface_repo / "data" / "services" / "insights" / "platform-frontend-ai-dev" / "app.yml"
        ).read_text()
        assert content.startswith("---\n")

    def test_no_trailing_newline_produces_valid_yaml(self, app_interface_repo):
        app_yml = app_interface_repo / "data" / "services" / "insights" / "platform-frontend-ai-dev" / "app.yml"
        app_yml.write_text(APP_YML_CONTENT.rstrip("\n"))
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = app_yml.read_text()
        assert "\n- name: test-agent-dev" in content
        for line in content.splitlines():
            assert not (line.startswith("  url:") and "- name:" in line)

    def test_missing_app_yml_no_error(self, app_interface_repo):
        (app_interface_repo / "data" / "services" / "insights" / "platform-frontend-ai-dev" / "app.yml").unlink()
        result = generate(SHARED_CONFIG, str(app_interface_repo))
        assert "app_file" not in result
        assert result["action"] == "created"


class TestSelfServiceDatafile:
    ROLE_REF = "teams/insights/roles/test-role"

    def _role_path(self, app_interface_repo):
        return app_interface_repo / "data" / "teams" / "insights" / "roles" / "test-role.yml"

    def _read_role(self, app_interface_repo):
        return yaml.safe_load(self._role_path(app_interface_repo).read_text())

    def test_adds_datafile_entry(self, app_interface_repo):
        cfg = {**SHARED_CONFIG, "team_role_ref": self.ROLE_REF}
        result = _add_self_service_datafile(cfg, str(app_interface_repo))
        assert result is not None
        data = self._read_role(app_interface_repo)
        ss = [e for e in data["self_service"] if e.get("change_type", {}).get("$ref") == SAAS_SELF_SERVICE_REF]
        assert len(ss) == 1
        refs = [d["$ref"] for d in ss[0]["datafiles"]]
        assert "/services/insights/platform-frontend-ai-dev/test-agent-dev-deploy.yml" in refs
        assert "/services/insights/platform-frontend-ai-dev/existing-deploy.yml" in refs

    def test_idempotent(self, app_interface_repo):
        cfg = {**SHARED_CONFIG, "team_role_ref": self.ROLE_REF}
        _add_self_service_datafile(cfg, str(app_interface_repo))
        result = _add_self_service_datafile(cfg, str(app_interface_repo))
        assert result is None
        data = self._read_role(app_interface_repo)
        ss = [e for e in data["self_service"] if e.get("change_type", {}).get("$ref") == SAAS_SELF_SERVICE_REF]
        refs = [d["$ref"] for d in ss[0]["datafiles"]]
        assert refs.count("/services/insights/platform-frontend-ai-dev/test-agent-dev-deploy.yml") == 1

    def test_creates_self_service_section(self, app_interface_repo):
        self._role_path(app_interface_repo).write_text(ROLE_FILE_NO_SS_CONTENT)
        cfg = {**SHARED_CONFIG, "team_role_ref": self.ROLE_REF}
        result = _add_self_service_datafile(cfg, str(app_interface_repo))
        assert result is not None
        data = self._read_role(app_interface_repo)
        assert "self_service" in data
        assert len(data["self_service"]) == 1
        assert data["self_service"][0]["change_type"]["$ref"] == SAAS_SELF_SERVICE_REF

    def test_adds_change_type_entry(self, app_interface_repo):
        self._role_path(app_interface_repo).write_text(ROLE_FILE_OTHER_CT_CONTENT)
        cfg = {**SHARED_CONFIG, "team_role_ref": self.ROLE_REF}
        result = _add_self_service_datafile(cfg, str(app_interface_repo))
        assert result is not None
        data = self._read_role(app_interface_repo)
        assert len(data["self_service"]) == 2
        ct_refs = [e["change_type"]["$ref"] for e in data["self_service"]]
        assert SAAS_SELF_SERVICE_REF in ct_refs
        assert "/app-interface/changetype/other-change-type.yml" in ct_refs

    def test_missing_role_file(self, app_interface_repo):
        cfg = {**SHARED_CONFIG, "team_role_ref": "teams/insights/roles/nonexistent"}
        result = _add_self_service_datafile(cfg, str(app_interface_repo))
        assert result is None

    def test_not_set(self, app_interface_repo):
        result = _add_self_service_datafile(SHARED_CONFIG, str(app_interface_repo))
        assert result is None

    def test_result_includes_role_file(self, app_interface_repo):
        cfg = {**SHARED_CONFIG, "team_role_ref": self.ROLE_REF}
        result = generate(cfg, str(app_interface_repo))
        assert "role_file" in result
        assert result["role_file"] == "data/teams/insights/roles/test-role.yml"

    def test_separate_pattern_deploy_ref(self, app_interface_repo):
        cfg = {**SEPARATE_CONFIG, "team_role_ref": self.ROLE_REF}
        _add_self_service_datafile(cfg, str(app_interface_repo))
        data = self._read_role(app_interface_repo)
        ss = [e for e in data["self_service"] if e.get("change_type", {}).get("$ref") == SAAS_SELF_SERVICE_REF]
        refs = [d["$ref"] for d in ss[0]["datafiles"]]
        assert "/services/testplatform/testteam/test-agent-dev.yml" in refs

    def test_appends_yml_extension(self, app_interface_repo):
        cfg = {**SHARED_CONFIG, "team_role_ref": "teams/insights/roles/test-role.yml"}
        result = _add_self_service_datafile(cfg, str(app_interface_repo))
        assert result is not None

    def test_preserves_yaml_header(self, app_interface_repo):
        cfg = {**SHARED_CONFIG, "team_role_ref": self.ROLE_REF}
        _add_self_service_datafile(cfg, str(app_interface_repo))
        content = self._role_path(app_interface_repo).read_text()
        assert content.startswith("---\n")


class TestSlackRef:
    def test_uses_redhat_internal(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = (
            app_interface_repo
            / "data"
            / "services"
            / "insights"
            / "platform-frontend-ai-dev"
            / "test-agent-dev-deploy.yml"
        ).read_text()
        assert "/dependencies/slack/redhat-internal.yml" in content
        assert "coreos" not in content


class TestTeamRoleRefEdgeCases:
    ROLE_REF = "teams/insights/roles/test-role"

    def _role_path(self, app_interface_repo):
        return app_interface_repo / "data" / "teams" / "insights" / "roles" / "test-role.yml"

    def test_leading_slash_stripped(self, app_interface_repo):
        cfg = {**SHARED_CONFIG, "team_role_ref": "/teams/insights/roles/test-role"}
        result = _add_self_service_datafile(cfg, str(app_interface_repo))
        assert result is not None

    def test_yaml_extension_preserved(self, app_interface_repo):
        yaml_role = self._role_path(app_interface_repo).parent / "test-role.yaml"
        yaml_role.write_text(ROLE_FILE_CONTENT)
        self._role_path(app_interface_repo).unlink()
        cfg = {**SHARED_CONFIG, "team_role_ref": "teams/insights/roles/test-role.yaml"}
        result = _add_self_service_datafile(cfg, str(app_interface_repo))
        assert result is not None

    def test_yaml_extension_not_doubled(self, app_interface_repo):
        yaml_role = self._role_path(app_interface_repo).parent / "test-role.yaml"
        yaml_role.write_text(ROLE_FILE_CONTENT)
        cfg = {**SHARED_CONFIG, "team_role_ref": "teams/insights/roles/test-role.yaml"}
        result = _add_self_service_datafile(cfg, str(app_interface_repo))
        assert result is not None
        assert ".yaml.yml" not in result

    def test_malformed_yaml_role_file_returns_none(self, app_interface_repo):
        self._role_path(app_interface_repo).write_text(": [invalid yaml\n  :\n")
        cfg = {**SHARED_CONFIG, "team_role_ref": self.ROLE_REF}
        result = _add_self_service_datafile(cfg, str(app_interface_repo))
        assert result is None


class TestMalformedYaml:
    def test_malformed_app_yml_returns_none(self, app_interface_repo):
        from generate_app_interface import _add_code_component

        app_yml = app_interface_repo / "data" / "services" / "insights" / "platform-frontend-ai-dev" / "app.yml"
        app_yml.write_text(": [bad yaml\n  :\n")
        result = _add_code_component(SHARED_CONFIG, str(app_interface_repo))
        assert result is None


class TestSeparateIdempotency:
    def test_second_run_unchanged(self, app_interface_repo):
        generate(SEPARATE_CONFIG, str(app_interface_repo))
        result = generate(SEPARATE_CONFIG, str(app_interface_repo))
        assert result["action"] == "unchanged"


class TestPathTraversal:
    def test_service_tree_traversal_rejected(self, app_interface_repo):
        cfg = {**SEPARATE_CONFIG, "service_tree": "../../etc/passwd"}
        with pytest.raises(ValueError, match="Path escapes"):
            generate(cfg, str(app_interface_repo))

    def test_team_role_ref_traversal_rejected(self, app_interface_repo):
        cfg = {**SHARED_CONFIG, "team_role_ref": "../../etc/passwd"}
        with pytest.raises(ValueError, match="Path escapes"):
            _add_self_service_datafile(cfg, str(app_interface_repo))

    def test_app_ref_traversal_rejected(self, app_interface_repo):
        from generate_app_interface import _add_code_component

        cfg = {
            **SHARED_CONFIG,
            "app_ref": "/../../etc/passwd",
        }
        # _safe_path raises ValueError
        with pytest.raises(ValueError, match="Path escapes"):
            _add_code_component(cfg, str(app_interface_repo))


class TestInstanceNameValidation:
    def test_rejects_invalid_instance_name(self, app_interface_repo):
        import json as json_mod
        import sys

        from generate_app_interface import main

        sys.argv = [
            "generate_app_interface.py",
            json_mod.dumps({**SHARED_CONFIG, "instance_name": "Bad-Name"}),
            str(app_interface_repo),
        ]
        with pytest.raises(SystemExit, match="1"):
            main()


class TestYamlQuoting:
    def test_plain_string_unquoted(self):
        assert _yaml_quote("My Board") == "My Board"

    def test_colon_gets_quoted(self):
        assert _yaml_quote("Acme: Frontend") == "'Acme: Frontend'"

    def test_hash_gets_quoted(self):
        assert _yaml_quote("Board #1") == "'Board #1'"

    def test_no_special_chars_unquoted(self):
        assert _yaml_quote("Team's Board") == "Team's Board"

    def test_single_quote_in_special_escaped(self):
        assert _yaml_quote("Team's Board: #1") == "'Team''s Board: #1'"

    def test_newline_gets_quoted(self):
        assert _yaml_quote("line1\nline2") == "'line1\nline2'"

    def test_team_name_with_colon_produces_valid_yaml(self, app_interface_repo):
        cfg = {**SHARED_CONFIG, "team_name": "Acme: Frontend Team"}
        result = generate(cfg, str(app_interface_repo))
        assert result["action"] == "created"
        deploy_path = (
            app_interface_repo
            / "data"
            / "services"
            / "insights"
            / "platform-frontend-ai-dev"
            / "test-agent-dev-deploy.yml"
        )
        parsed = yaml.safe_load(deploy_path.read_text())
        assert parsed["description"] == "Rehor bot instance for Acme: Frontend Team"

    def test_bot_label_with_colon_quoted(self, app_interface_repo):
        cfg = {**SHARED_CONFIG, "bot_label": "team:label"}
        generate(cfg, str(app_interface_repo))
        content = (
            app_interface_repo
            / "data"
            / "services"
            / "insights"
            / "platform-frontend-ai-dev"
            / "test-agent-dev-deploy.yml"
        ).read_text()
        assert "BOT_LABEL: 'team:label'" in content

    def test_vertex_models_with_commas_quoted(self, app_interface_repo):
        cfg = {**SHARED_CONFIG, "vertex_allowed_models": "claude-sonnet-4-6,claude-opus-4-6"}
        generate(cfg, str(app_interface_repo))
        content = (
            app_interface_repo
            / "data"
            / "services"
            / "insights"
            / "platform-frontend-ai-dev"
            / "test-agent-dev-deploy.yml"
        ).read_text()
        assert "VERTEX_ALLOWED_MODELS: 'claude-sonnet-4-6,claude-opus-4-6'" in content

    def test_config_repo_url_quoted(self, app_interface_repo):
        generate(SHARED_CONFIG, str(app_interface_repo))
        content = (
            app_interface_repo
            / "data"
            / "services"
            / "insights"
            / "platform-frontend-ai-dev"
            / "test-agent-dev-deploy.yml"
        ).read_text()
        assert "BOT_CONFIG_REPO: 'https://github.com/TestOrg/test-agent-dev'" in content

    def test_board_name_with_colon(self, app_interface_repo):
        cfg = {**SHARED_CONFIG, "board_name": "Sprint: Planning"}
        generate(cfg, str(app_interface_repo))
        content = (
            app_interface_repo
            / "data"
            / "services"
            / "insights"
            / "platform-frontend-ai-dev"
            / "test-agent-dev-deploy.yml"
        ).read_text()
        assert "BOT_BOARD_NAME: 'Sprint: Planning'" in content
