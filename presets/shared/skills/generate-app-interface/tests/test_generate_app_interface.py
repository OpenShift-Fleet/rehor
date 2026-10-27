import json
import subprocess

import pytest
import yaml
from generate_app_interface import (
    SAAS_SELF_SERVICE_REF,
    _add_self_service_datafile,
    _discover_gcp_project,
    _discover_namespace_ref,
    _discover_pipelines_ref,
    _prepare_code_component,
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

    def test_explicit_config_path_is_preserved(self, app_interface_repo):
        cfg = {**SHARED_CONFIG, "config_name": "selected-config", "config_path": "instance/selected-profile"}
        result = generate(cfg, str(app_interface_repo))
        deploy = yaml.safe_load((app_interface_repo / result["file"]).read_text())
        params = deploy["resourceTemplates"][0]["targets"][0]["parameters"]
        assert params["BOT_CONFIG_PATH"] == cfg["config_path"]

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
    @pytest.mark.parametrize(
        "content",
        [
            "codeComponents: []\n",
            "'codeComponents': [] # keep this comment\nowner: {team: test}\n",
            'codeComponents: [ ]\nnotes: "quoted: value # retained"\n',
            "codeComponents: [\n  # Keep the empty flow list comment.\n]\nowner: test\n",
            "codeComponents: [{name: old, url: 'https://example.test/old'}]\nowner: test\n",
            "codeComponents: [ # Keep the flow list comment.\n  {name: old, url: 'https://example.test/old'},\n]\nowner: test\n",
            APP_YML_CONTENT,
            APP_YML_CONTENT + "# Owner comment\nowner:\n  codeComponents: []\n  nested: [one, two]\n",
            "codeComponents:\n  # Component comment\n  - name: old\n    url: 'https://example.test/old' # URL comment\nowner:\n  nested: true\n",
            "codeComponents:\n    - name: old\n      url: https://example.test/old\nowner: test\n",
            APP_YML_CONTENT.rstrip("\n"),
            "codeComponents: []\r\nowner: test\r\n",
            "owner: &owner {team: test}\ncodeComponents: []\nsecondary: *owner\n",
        ],
        ids=[
            "empty-seed",
            "quoted-key-inline-comment",
            "spaced-flow",
            "empty-multiline-flow",
            "nonempty-flow",
            "multiline-flow-trailing-comma",
            "block",
            "following-nested-sibling",
            "indented-block-comments",
            "four-space-block",
            "no-final-newline",
            "crlf",
            "unrelated-anchor",
        ],
    )
    def test_full_generate_preserves_yaml_and_is_byte_idempotent(self, app_interface_repo, content):
        app_path = app_interface_repo / "data/services/insights/platform-frontend-ai-dev/app.yml"
        app_path.write_bytes(content.encode())
        original = yaml.safe_load(content)
        cfg = {**SHARED_CONFIG, "team_role_ref": "teams/insights/roles/test-role"}

        result = generate(cfg, str(app_interface_repo))

        assert result["action"] == "created"
        assert result["app_file"] == str(app_path.relative_to(app_interface_repo))
        updated = app_path.read_bytes().decode()
        parsed = yaml.safe_load(updated)
        new_component = {
            "name": cfg["instance_name"],
            "resource": "upstream",
            "url": cfg["repo_url"],
        }
        assert parsed == {**original, "codeComponents": [new_component, *original["codeComponents"]]}
        # Only an insertion is needed: every original byte remains in order.
        sequence = next(v for k, v in yaml.compose(content).value if k.value == "codeComponents")
        if sequence.flow_style:
            start = sequence.start_mark.index + 1
        else:
            start = sequence.start_mark.index - sequence.start_mark.column
        assert updated.startswith(content[:start])
        assert updated.endswith(content[start:])
        before_rerun = {p: p.read_bytes() for p in app_interface_repo.rglob("*.yml")}
        for payload in before_rerun.values():
            yaml.safe_load(payload)

        assert generate(cfg, str(app_interface_repo))["action"] == "unchanged"
        assert {p: p.read_bytes() for p in before_rerun} == before_rerun

    @pytest.mark.parametrize("quote", ["'", '"'])
    def test_duplicate_matches_decoded_component_url(self, app_interface_repo, quote):
        app_path = app_interface_repo / "data/services/insights/platform-frontend-ai-dev/app.yml"
        url = SHARED_CONFIG["repo_url"]
        quoted = f"{quote}{url}{quote}" if quote == "'" else f'"{url[:-1]}\\u{ord(url[-1]):04x}"'
        content = f"codeComponents:\n- name: another-name\n  url: {quoted} # Keep quoted URL\nowner: test\n"
        app_path.write_text(content)
        result = generate(SHARED_CONFIG, str(app_interface_repo))
        assert "error" not in result
        assert "app_file" not in result
        assert app_path.read_text() == content

    def test_url_elsewhere_does_not_suppress_component(self, app_interface_repo):
        app_path = app_interface_repo / "data/services/insights/platform-frontend-ai-dev/app.yml"
        url = SHARED_CONFIG["repo_url"]
        content = f"# {url}\nnotes: {url}\ncodeComponents:\n- name: old\n  url: {url}/other\n"
        app_path.write_text(content)
        assert "app_file" in generate(SHARED_CONFIG, str(app_interface_repo))
        parsed = yaml.safe_load(app_path.read_text())
        assert [c["url"] for c in parsed["codeComponents"]] == [url, url + "/other"]
        assert parsed["notes"] == url

    @pytest.mark.parametrize(
        "existing_suffix,requested_suffix",
        [(".git", ""), ("", ".git"), ("/", ""), ("", "/"), (".git/", ""), ("", ".git/"), (".git///", "/")],
    )
    @pytest.mark.parametrize("same_name", [False, True])
    def test_equivalent_urls_preserve_existing_component(
        self, app_interface_repo, existing_suffix, requested_suffix, same_name
    ):
        app_path = app_interface_repo / "data/services/insights/platform-frontend-ai-dev/app.yml"
        name = SHARED_CONFIG["instance_name"] if same_name else "another-name"
        url = SHARED_CONFIG["repo_url"]
        content = f"codeComponents: [{{name: {name}, url: '{url}{existing_suffix}'}}] # Keep\n"
        app_path.write_text(content)
        cfg = {**SHARED_CONFIG, "repo_url": url + requested_suffix}

        assert _prepare_code_component(cfg, str(app_interface_repo)) is None
        result = generate(cfg, str(app_interface_repo))
        assert result["action"] == "created"
        assert "app_file" not in result
        assert app_path.read_text() == content
        before = {p: p.read_bytes() for p in app_interface_repo.rglob("*.yml")}
        assert generate(cfg, str(app_interface_repo))["action"] == "unchanged"
        assert {p: p.read_bytes() for p in before} == before

    @pytest.mark.parametrize("cfg", [SHARED_CONFIG, SEPARATE_CONFIG], ids=["shared", "separate"])
    @pytest.mark.parametrize("matching_url_position", [None, "before", "after"])
    @pytest.mark.parametrize("existing_deploy", [False, True])
    def test_name_collision_fails_before_any_write(
        self, app_interface_repo, cfg, matching_url_position, existing_deploy
    ):
        if existing_deploy:
            assert "error" not in generate(cfg, str(app_interface_repo))
        app_path = app_interface_repo / "data/services/insights/platform-frontend-ai-dev/app.yml"
        entries = [{"name": cfg["instance_name"], "url": "https://example.test/different.git/"}]
        equivalent = {"name": "another-name", "url": cfg["repo_url"] + ".git/"}
        if matching_url_position == "before":
            entries.insert(0, equivalent)
        elif matching_url_position == "after":
            entries.append(equivalent)
        app_path.write_text(yaml.safe_dump({"codeComponents": entries}))
        before = {p: p.read_bytes() for p in app_interface_repo.rglob("*.yml")}

        result = generate({**cfg, "team_role_ref": "teams/insights/roles/test-role"}, str(app_interface_repo))

        assert "component name 'test-agent-dev' already uses a different URL" in result["error"]
        assert "action" not in result
        assert {p: p.read_bytes() for p in app_interface_repo.rglob("*.yml")} == before
        if cfg["pattern"] == "separate" and not existing_deploy:
            assert not (app_interface_repo / "data/services/testplatform").exists()

    @pytest.mark.parametrize(
        "url",
        [
            "http://github.com/TestOrg/test-agent-dev",
            "git@github.com:TestOrg/test-agent-dev",
            "https://GitHub.com/TestOrg/test-agent-dev",
            "https://github.com/testorg/test-agent-dev",
            "https://github.com/TestOrg/test-agent-dev/other",
        ],
    )
    def test_other_url_differences_are_not_normalized(self, app_interface_repo, url):
        app_path = app_interface_repo / "data/services/insights/platform-frontend-ai-dev/app.yml"
        app_path.write_text(yaml.safe_dump({"codeComponents": [{"name": "other", "url": url}]}))
        result = generate(SHARED_CONFIG, str(app_interface_repo))
        assert "app_file" in result
        assert [c["url"] for c in yaml.safe_load(app_path.read_text())["codeComponents"]] == [
            SHARED_CONFIG["repo_url"],
            url,
        ]

    @pytest.mark.parametrize(
        "content",
        [
            "codeComponents:",
            "codeComponents:\n",
            "codeComponents: # Inline comment\n# Sibling comment\nowner: {team: test}\n...\n",
            "'codeComponents':\r\n# Keep CRLF\r\nowner:\r\n  nested: [one, two]\r\n...\r\n",
            "codeComponents: null # Keep\nowner: test\n...\n",
            "codeComponents: ~ # Keep\r\nowner: [one, two]\r\n...\r\n",
            "codeComponents: NULL\nowner: test\n",
            "codeComponents:\n  null # Keep\nowner: test\n",
            "{codeComponents: , owner: {team: test}} # Keep\n",
            "{codeComponents: null, owner: [one, two]}\n",
            "{codeComponents: ~, owner: test}\r\n...\r\n",
        ],
    )
    def test_null_component_field_preserves_surroundings_and_is_idempotent(self, app_interface_repo, content):
        app_path = app_interface_repo / "data/services/insights/platform-frontend-ai-dev/app.yml"
        app_path.write_bytes(content.encode())
        original = yaml.safe_load(content)
        scalar = next(v for k, v in yaml.compose(content).value if k.value == "codeComponents")
        update = _prepare_code_component(SHARED_CONFIG, str(app_interface_repo))
        assert update is not None
        prepared_path, prepared = update
        assert prepared_path == app_path
        assert app_path.read_bytes() == content.encode()

        result = generate(SHARED_CONFIG, str(app_interface_repo))

        assert result["action"] == "created"
        updated = app_path.read_bytes().decode()
        assert updated == prepared
        assert updated.startswith(content[: scalar.start_mark.index])
        suffix = content[scalar.end_mark.index :]
        if suffix:
            assert updated.endswith(suffix)
        assert yaml.safe_load(updated) == {
            **original,
            "codeComponents": [
                {
                    "name": SHARED_CONFIG["instance_name"],
                    "resource": "upstream",
                    "url": SHARED_CONFIG["repo_url"],
                }
            ],
        }
        if "\r\n" in content:
            assert "\n" not in updated.replace("\r\n", "")
        before = {p: p.read_bytes() for p in app_interface_repo.rglob("*.yml")}
        assert generate(SHARED_CONFIG, str(app_interface_repo))["action"] == "unchanged"
        assert {p: p.read_bytes() for p in before} == before

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
    def test_cli_exits_with_error_for_invalid_app(self, app_interface_repo, monkeypatch, capsys):
        from generate_app_interface import main

        app_path = app_interface_repo / "data/services/insights/platform-frontend-ai-dev/app.yml"
        app_path.write_text("codeComponents: {}\n")
        monkeypatch.setattr(
            "sys.argv", ["generate_app_interface.py", json.dumps(SHARED_CONFIG), str(app_interface_repo)]
        )
        with pytest.raises(SystemExit, match="1"):
            main()
        error = json.loads(capsys.readouterr().out)["error"]
        assert "app.yml" in error
        assert "codeComponents must be a YAML list" in error

    @pytest.mark.parametrize(
        "content",
        [
            ": [bad yaml\n  :\n",
            "codeComponents: {}\n",
            "codeComponents: wrong\n",
            "- not-an-app\n",
            "",
            f"# {SHARED_CONFIG['repo_url']}\ncodeComponents: [\n",
            "codeComponents: []\ncodeComponents: []\n",
            "components: &components []\ncodeComponents: *components\n",
            "codeComponents: &components []\nother: *components\n",
            "<<: {codeComponents: []}\n",
        ],
    )
    @pytest.mark.parametrize("existing_deploy", [False, True])
    def test_generate_reports_invalid_app_without_writing(self, app_interface_repo, content, existing_deploy):
        if existing_deploy:
            generate(SHARED_CONFIG, str(app_interface_repo))
        app_path = app_interface_repo / "data/services/insights/platform-frontend-ai-dev/app.yml"
        app_path.write_text(content)
        before = {p: p.read_bytes() for p in app_interface_repo.rglob("*.yml")}

        with pytest.raises(ValueError, match="Cannot update"):
            _prepare_code_component(SHARED_CONFIG, str(app_interface_repo))
        result = generate(SHARED_CONFIG, str(app_interface_repo))

        assert "app.yml" in result["error"]
        assert "action" not in result
        assert {p: p.read_bytes() for p in app_interface_repo.rglob("*.yml")} == before

    def test_malformed_app_yml_raises(self, app_interface_repo):
        app_yml = app_interface_repo / "data" / "services" / "insights" / "platform-frontend-ai-dev" / "app.yml"
        app_yml.write_text(": [bad yaml\n  :\n")
        with pytest.raises(ValueError, match="invalid YAML"):
            _prepare_code_component(SHARED_CONFIG, str(app_interface_repo))


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
        cfg = {
            **SHARED_CONFIG,
            "app_ref": "/../../etc/passwd",
        }
        # _safe_path raises ValueError
        with pytest.raises(ValueError, match="Path escapes"):
            _prepare_code_component(cfg, str(app_interface_repo))


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
