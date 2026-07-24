"""Tests for new_work.py repo label matching with org/repo support."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / ".claude" / "skills" / "new-work"))

from new_work import build_repo_lookup, match_repo_labels

SAMPLE_REPOS = {
    "insights-chrome": {
        "url": "https://github.com/platex-rehor-bot/insights-chrome.git",
        "upstream": "https://github.com/RedHatInsights/insights-chrome.git",
    },
    "notifications-frontend": {
        "url": "https://github.com/platex-rehor-bot/notifications-frontend.git",
        "upstream": "https://github.com/RedHatInsights/notifications-frontend.git",
    },
    "app-interface": {
        "url": "https://gitlab.cee.redhat.com/platform-experience-services-bot/app-interface.git",
        "upstream": "https://gitlab.cee.redhat.com/service/app-interface.git",
        "host": "gitlab",
    },
    "other-org-repo": {
        "url": "https://github.com/platex-rehor-bot/other-org-repo.git",
        "upstream": "https://github.com/some-other-org/other-org-repo.git",
    },
}


class TestBuildRepoLookup:
    def test_bare_keys(self):
        lookup = build_repo_lookup(SAMPLE_REPOS)
        assert lookup["insights-chrome"] == "insights-chrome"
        assert lookup["notifications-frontend"] == "notifications-frontend"
        assert lookup["app-interface"] == "app-interface"

    def test_github_org_repo(self):
        lookup = build_repo_lookup(SAMPLE_REPOS)
        assert lookup["RedHatInsights/insights-chrome"] == "insights-chrome"
        assert lookup["RedHatInsights/notifications-frontend"] == "notifications-frontend"

    def test_gitlab_org_repo(self):
        lookup = build_repo_lookup(SAMPLE_REPOS)
        assert lookup["service/app-interface"] == "app-interface"

    def test_other_org(self):
        lookup = build_repo_lookup(SAMPLE_REPOS)
        assert lookup["some-other-org/other-org-repo"] == "other-org-repo"

    def test_empty_dict(self):
        assert build_repo_lookup({}) == {}

    def test_missing_upstream(self):
        lookup = build_repo_lookup({"my-repo": {"url": "https://x.com/my-repo.git"}})
        assert lookup["my-repo"] == "my-repo"
        assert len(lookup) == 1


class TestMatchRepoLabels:
    def setup_method(self):
        self.lookup = build_repo_lookup(SAMPLE_REPOS)

    def test_bare_label(self):
        labels = ["hcc-ai-bot", "repo:insights-chrome"]
        assert match_repo_labels(labels, self.lookup) == ["insights-chrome"]

    def test_org_label(self):
        labels = ["hcc-ai-bot", "repo:RedHatInsights/insights-chrome"]
        assert match_repo_labels(labels, self.lookup) == ["insights-chrome"]

    def test_other_org_label(self):
        labels = ["repo:some-other-org/other-org-repo"]
        assert match_repo_labels(labels, self.lookup) == ["other-org-repo"]

    def test_gitlab_org_label(self):
        labels = ["repo:service/app-interface"]
        assert match_repo_labels(labels, self.lookup) == ["app-interface"]

    def test_multi_repo_labels(self):
        labels = ["repo:insights-chrome", "repo:RedHatInsights/notifications-frontend"]
        result = match_repo_labels(labels, self.lookup)
        assert result == ["insights-chrome", "notifications-frontend"]

    def test_no_repo_labels(self):
        labels = ["hcc-ai-bot", "needs-investigation"]
        assert match_repo_labels(labels, self.lookup) == []

    def test_empty_labels(self):
        assert match_repo_labels([], self.lookup) == []

    def test_unmatched_returns_empty(self):
        labels = ["repo:nonexistent-repo"]
        assert match_repo_labels(labels, self.lookup) == []

    def test_partial_match_returns_empty(self):
        labels = ["repo:insights-chrome", "repo:nonexistent"]
        assert match_repo_labels(labels, self.lookup) == []

    def test_unmatched_org_returns_empty(self):
        labels = ["repo:WrongOrg/insights-chrome"]
        assert match_repo_labels(labels, self.lookup) == []
