from post_manual_steps import _build_comment

BASE_CONFIG = {
    "epic_key": "RHCLOUD-123",
    "bot_label": "rehor-ai-test",
    "bot_name": "devbot-test",
    "instance_name": "test-agent-dev",
    "dedicated_proxy": False,
    "workflow": "jira-sprint",
}


class TestBuildComment:
    def test_includes_bot_name(self):
        comment = _build_comment(BASE_CONFIG)
        assert "devbot-test" in comment

    def test_includes_bot_label(self):
        comment = _build_comment(BASE_CONFIG)
        assert "rehor-ai-test" in comment

    def test_sprint_mentions_active_sprint(self):
        comment = _build_comment(BASE_CONFIG)
        assert "active sprint" in comment

    def test_kanban_no_active_sprint(self):
        cfg = {**BASE_CONFIG, "workflow": "jira-kanban"}
        comment = _build_comment(cfg)
        assert "active sprint" not in comment

    def test_kanban_still_has_test_step(self):
        cfg = {**BASE_CONFIG, "workflow": "jira-kanban"}
        comment = _build_comment(cfg)
        assert "Test the bot" in comment

    def test_dedicated_proxy_credentials_step(self):
        cfg = {**BASE_CONFIG, "dedicated_proxy": True}
        comment = _build_comment(cfg)
        assert "Credentials" in comment
        assert "dedicated proxy" in comment

    def test_shared_no_credentials_step(self):
        comment = _build_comment(BASE_CONFIG)
        assert "Credentials" not in comment

    def test_phase_header(self):
        comment = _build_comment(BASE_CONFIG)
        assert "## [Phase 3/3]" in comment

    def test_defaults_without_optional_fields(self):
        comment = _build_comment({"epic_key": "X-1"})
        assert "Phase 3/3" in comment
        assert "<bot_label>" in comment
        assert "<bot_name>" in comment
