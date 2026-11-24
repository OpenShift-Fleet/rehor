"""Tests for preflight repo label matching with org/repo support."""

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
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


@pytest.fixture
def preflight(monkeypatch):
    """Import preflight helpers with a scoped sys.path that unwinds after the test."""
    monkeypatch.syspath_prepend(ROOT / "presets" / "shared" / "preflight")
    import common as preflight_common

    return preflight_common


@pytest.fixture
def lookup(preflight):
    return preflight.build_repo_lookup(SAMPLE_REPOS)


class TestBuildRepoLookup:
    def test_bare_keys(self, lookup):
        assert lookup["insights-chrome"] == "insights-chrome"
        assert lookup["notifications-frontend"] == "notifications-frontend"
        assert lookup["app-interface"] == "app-interface"

    def test_github_org_repo(self, lookup):
        assert lookup["RedHatInsights/insights-chrome"] == "insights-chrome"
        assert lookup["RedHatInsights/notifications-frontend"] == "notifications-frontend"

    def test_gitlab_org_repo(self, lookup):
        assert lookup["service/app-interface"] == "app-interface"

    def test_other_org(self, lookup):
        assert lookup["some-other-org/other-org-repo"] == "other-org-repo"

    def test_empty_dict(self, preflight):
        assert preflight.build_repo_lookup({}) == {}

    def test_missing_upstream(self, preflight):
        lookup = preflight.build_repo_lookup({"my-repo": {"url": "https://x.com/my-repo.git"}})
        assert lookup["my-repo"] == "my-repo"
        assert len(lookup) == 1


class TestMatchRepoLabels:
    def test_bare_label(self, preflight, lookup):
        labels = ["hcc-ai-bot", "repo:insights-chrome"]
        assert preflight.match_repo_labels(labels, lookup) == ["insights-chrome"]

    def test_org_label(self, preflight, lookup):
        labels = ["hcc-ai-bot", "repo:RedHatInsights/insights-chrome"]
        assert preflight.match_repo_labels(labels, lookup) == ["insights-chrome"]

    def test_other_org_label(self, preflight, lookup):
        labels = ["repo:some-other-org/other-org-repo"]
        assert preflight.match_repo_labels(labels, lookup) == ["other-org-repo"]

    def test_gitlab_org_label(self, preflight, lookup):
        labels = ["repo:service/app-interface"]
        assert preflight.match_repo_labels(labels, lookup) == ["app-interface"]

    def test_multi_repo_labels(self, preflight, lookup):
        labels = ["repo:insights-chrome", "repo:RedHatInsights/notifications-frontend"]
        result = preflight.match_repo_labels(labels, lookup)
        assert result == ["insights-chrome", "notifications-frontend"]

    def test_no_repo_labels(self, preflight, lookup):
        labels = ["hcc-ai-bot", "needs-investigation"]
        assert preflight.match_repo_labels(labels, lookup) == []

    def test_empty_labels(self, preflight, lookup):
        assert preflight.match_repo_labels([], lookup) == []

    def test_unmatched_returns_empty(self, preflight, lookup):
        labels = ["repo:nonexistent-repo"]
        assert preflight.match_repo_labels(labels, lookup) == []

    def test_partial_match_returns_empty(self, preflight, lookup):
        labels = ["repo:insights-chrome", "repo:nonexistent"]
        assert preflight.match_repo_labels(labels, lookup) == []

    def test_unmatched_org_returns_empty(self, preflight, lookup):
        labels = ["repo:WrongOrg/insights-chrome"]
        assert preflight.match_repo_labels(labels, lookup) == []
