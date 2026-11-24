from post_konflux_instructions import _build_comment

BASE_CONFIG = {
    "epic_key": "RHCLOUD-123",
    "instance_name": "test-agent-dev",
    "quay_org": "test-tenant",
}


class TestBuildComment:
    def test_includes_instance_name(self):
        comment = _build_comment(BASE_CONFIG)
        assert "test-agent-dev" in comment

    def test_includes_quay_url(self):
        comment = _build_comment(BASE_CONFIG)
        assert "quay.io/redhat-services-prod/test-tenant/test-agent-dev" in comment

    def test_phase_header(self):
        comment = _build_comment(BASE_CONFIG)
        assert "## [Phase 2/3]" in comment

    def test_mentions_konflux_github_app(self):
        comment = _build_comment(BASE_CONFIG)
        assert "red-hat-konflux" in comment

    def test_defaults_without_optional_fields(self):
        comment = _build_comment({"epic_key": "X-1"})
        assert "<instance_name>" in comment
        assert "<quay_org>" in comment
