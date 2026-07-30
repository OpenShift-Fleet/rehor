from post_intake import COMMENT


class TestIntakeComment:
    def test_phase_header(self):
        assert "## [Phase 1/3]" in COMMENT

    def test_required_fields(self):
        assert "Repo name" in COMMENT
        assert "Team name" in COMMENT
        assert "Bot identity" in COMMENT
        assert "Target repo URL" in COMMENT
        assert "Jira project key" in COMMENT

    def test_shared_vs_dedicated_question(self):
        assert "shared or dedicated" in COMMENT

    def test_optional_fields(self):
        assert "Workflow type" in COMMENT
        assert "KEDA schedule" in COMMENT
        assert "Fork accounts" in COMMENT

    def test_phase_2_3_heads_up(self):
        assert "Konflux tenant" in COMMENT
        assert "GCP project" in COMMENT
        assert "Dedicated proxy" in COMMENT
