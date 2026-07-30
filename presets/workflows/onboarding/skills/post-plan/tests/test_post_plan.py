from post_plan import _build_comment

BASE_CONFIG = {
    "epic_key": "RHCLOUD-123",
    "instance_name": "test-agent-dev",
    "config_name": "test-config",
    "bot_name": "devbot-test",
    "bot_label": "rehor-ai-test",
    "workflow": "jira-sprint",
    "repos": [{"name": "my-app", "url": "https://github.com/Org/my-app"}],
    "tech_stacks": {"my-app": {"stack": ["react", "typescript"]}},
    "envs_and_personas": "node | frontend",
    "dedicated_proxy": False,
}


class TestBuildComment:
    def test_includes_instance_name(self):
        comment = _build_comment(BASE_CONFIG)
        assert "test-agent-dev" in comment

    def test_includes_config_name(self):
        comment = _build_comment(BASE_CONFIG)
        assert "test-config" in comment

    def test_shared_infra_label(self):
        comment = _build_comment(BASE_CONFIG)
        assert "shared" in comment
        assert "dedicated" not in comment.split("Infrastructure")[1].split("\n")[0]

    def test_dedicated_infra_label(self):
        cfg = {**BASE_CONFIG, "dedicated_proxy": True}
        comment = _build_comment(cfg)
        assert "dedicated" in comment

    def test_dedicated_shows_extra_requirements(self):
        cfg = {**BASE_CONFIG, "dedicated_proxy": True}
        comment = _build_comment(cfg)
        assert "GCP project" in comment
        assert "Bot accounts" in comment
        assert "App-interface service tree" in comment

    def test_shared_no_extra_requirements(self):
        comment = _build_comment(BASE_CONFIG)
        assert "Dedicated infrastructure — additional requirements" not in comment

    def test_tech_stacks_as_dict(self):
        comment = _build_comment(BASE_CONFIG)
        assert "react, typescript" in comment

    def test_tech_stacks_as_list(self):
        cfg = {
            **BASE_CONFIG,
            "tech_stacks": [{"repo": "my-app", "stack": ["react"]}],
        }
        comment = _build_comment(cfg)
        assert "**my-app**: react" in comment

    def test_unsupported_stacks_warning(self):
        cfg = {
            **BASE_CONFIG,
            "tech_stacks": {"my-app": {"stack": ["go"], "unsupported_stacks": ["cobol"]}},
        }
        comment = _build_comment(cfg)
        assert "cobol" in comment
        assert "not yet supported" in comment

    def test_repos_as_dicts_with_links(self):
        comment = _build_comment(BASE_CONFIG)
        assert "[my-app](https://github.com/Org/my-app)" in comment

    def test_repos_as_strings(self):
        cfg = {**BASE_CONFIG, "repos": ["https://github.com/Org/my-app"]}
        comment = _build_comment(cfg)
        assert "https://github.com/Org/my-app" in comment

    def test_defaults_without_optional_fields(self):
        comment = _build_comment({"epic_key": "X-1"})
        assert "Instance name" in comment
        assert "?" in comment

    def test_phase_header(self):
        comment = _build_comment(BASE_CONFIG)
        assert "## [Phase 1/3]" in comment

    def test_missing_workflow_fields_warning(self):
        cfg = {**BASE_CONFIG, "requirements": {}}
        comment = _build_comment(cfg)
        assert "Action needed" in comment
        assert "`board_name`" in comment

    def test_newlines_stripped_from_instance_name(self):
        cfg = {**BASE_CONFIG, "instance_name": "test\ninjected"}
        comment = _build_comment(cfg)
        assert "\ninjected" not in comment
        assert "test injected" in comment

    def test_newlines_stripped_from_repo_name(self):
        cfg = {
            **BASE_CONFIG,
            "repos": [{"name": "my-app\n## Injected", "url": "https://evil.com\nmore"}],
        }
        comment = _build_comment(cfg)
        assert "\n## Injected" not in comment
        assert "my-app " in comment

    def test_newlines_stripped_from_bot_label(self):
        cfg = {**BASE_CONFIG, "bot_label": "label\r\ninjected: true"}
        comment = _build_comment(cfg)
        assert "\ninjected" not in comment

    def test_no_warning_when_fields_present(self):
        cfg = {**BASE_CONFIG, "requirements": {"board_name": "My Board"}}
        comment = _build_comment(cfg)
        assert "Action needed" not in comment
