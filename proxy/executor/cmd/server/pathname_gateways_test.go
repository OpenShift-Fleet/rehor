package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	executor "github.com/RedHatInsights/platform-frontend-ai-dev/proxy/executor"
)

// TestApplyPathnameDestinations verifies the environment mapping for the
// REHOR-263 pathname destinations: Jira reuses the JIRA_* credential of
// the :8445 listener, GitHub and GitLab reuse GH_TOKEN / GITLAB_TOKEN, and
// only the two API upstream URLs are new. Upstream URLs are trimmed like
// the other gateway availability inputs; tokens are passed through
// verbatim.
func TestApplyPathnameDestinations(t *testing.T) {
	for _, k := range []string{
		"JIRA_URL", "JIRA_USERNAME", "JIRA_API_TOKEN",
		"GITHUB_API_URL", "GH_TOKEN", "GITLAB_API_URL", "GITLAB_TOKEN",
	} {
		t.Setenv(k, "")
	}

	cfg := executor.DefaultGatewayConfig()
	applyPathnameDestinations(&cfg)
	if cfg.JiraAPI != (executor.PathnameDestination{}) ||
		cfg.GitHubAPI != (executor.PathnameDestination{}) ||
		cfg.GitLabAPI != (executor.PathnameDestination{}) {
		t.Fatalf("empty environment must leave destinations unconfigured, got %+v", cfg)
	}

	t.Setenv("JIRA_URL", "  https://redhat.atlassian.net  ")
	t.Setenv("JIRA_USERNAME", "bot@example.com")
	t.Setenv("JIRA_API_TOKEN", "jira-token")
	t.Setenv("GITHUB_API_URL", "https://api.github.com")
	t.Setenv("GH_TOKEN", "gh-token")
	t.Setenv("GITLAB_API_URL", "https://gitlab.cee.redhat.com")
	t.Setenv("GITLAB_TOKEN", "gl-token")
	applyPathnameDestinations(&cfg)

	want := executor.GatewayConfig{
		JiraAPI:   executor.PathnameDestination{Upstream: "https://redhat.atlassian.net", Username: "bot@example.com", Token: "jira-token"},
		GitHubAPI: executor.PathnameDestination{Upstream: "https://api.github.com", Token: "gh-token"},
		GitLabAPI: executor.PathnameDestination{Upstream: "https://gitlab.cee.redhat.com", Token: "gl-token"},
	}
	if cfg.JiraAPI != want.JiraAPI || cfg.GitHubAPI != want.GitHubAPI || cfg.GitLabAPI != want.GitLabAPI {
		t.Fatalf("destination mapping mismatch:\ngot  %+v %+v %+v\nwant %+v %+v %+v",
			cfg.JiraAPI, cfg.GitHubAPI, cfg.GitLabAPI,
			want.JiraAPI, want.GitHubAPI, want.GitLabAPI)
	}
}

// TestPathnameGatewayHandlerFailClosed runs the wiring end to end: a
// GitHub destination with an upstream but no token must fail closed per
// request with a clear error naming GH_TOKEN, and the upstream must see no
// request. The destination is never silently disabled.
func TestPathnameGatewayHandlerFailClosed(t *testing.T) {
	var hits int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	t.Setenv("GITHUB_API_URL", upstream.URL)
	t.Setenv("GH_TOKEN", "")

	handler, err := httpGatewayHandler(backendAvailability{}, "http://127.0.0.1:9090")
	if err != nil {
		t.Fatalf("httpGatewayHandler: %v", err)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest("GET", "/github/repos/o/r", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (body %q)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "GH_TOKEN") {
		t.Fatalf("error must name the missing credential variable, got %q", rec.Body.String())
	}
	if hits != 0 {
		t.Fatalf("upstream saw %d requests; missing credential must fail closed", hits)
	}
}
