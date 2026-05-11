package executor

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestJiraHealthz(t *testing.T) {
	handler := NewJiraProxy("https://example.atlassian.net", "user@example.com", "token123")

	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("/healthz status = %d, want 200", w.Code)
	}
}

func TestJiraAuthHeaderInjected(t *testing.T) {
	var gotAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	handler := NewJiraProxy(upstream.URL, "bot@redhat.com", "secret-token")

	req := httptest.NewRequest("GET", "/rest/api/2/issue/PROJ-123", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	// base64("bot@redhat.com:secret-token") = "Ym90QHJlZGhhdC5jb206c2VjcmV0LXRva2Vu"
	want := "Basic Ym90QHJlZGhhdC5jb206c2VjcmV0LXRva2Vu"
	if gotAuth != want {
		t.Errorf("upstream got Authorization = %q, want %q", gotAuth, want)
	}
}

func TestJiraPathPreserved(t *testing.T) {
	var gotPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	handler := NewJiraProxy(upstream.URL, "user", "token")

	req := httptest.NewRequest("POST", "/rest/api/2/search/jql", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if gotPath != "/rest/api/2/search/jql" {
		t.Errorf("upstream path = %q, want /rest/api/2/search/jql", gotPath)
	}
}

func TestJiraQueryParamsPreserved(t *testing.T) {
	var gotQuery string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	handler := NewJiraProxy(upstream.URL, "user", "token")

	req := httptest.NewRequest("GET", "/rest/api/2/issue/PROJ-1?fields=summary,status&expand=changelog", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	want := "fields=summary,status&expand=changelog"
	if gotQuery != want {
		t.Errorf("upstream query = %q, want %q", gotQuery, want)
	}
}

func TestJiraValidateConfig(t *testing.T) {
	if err := ValidateJiraConfig("https://example.com", "user", "token"); err != nil {
		t.Errorf("valid config returned error: %v", err)
	}
	if err := ValidateJiraConfig("", "user", "token"); err == nil {
		t.Error("empty URL should fail")
	}
	if err := ValidateJiraConfig("https://example.com", "", "token"); err == nil {
		t.Error("empty username should fail")
	}
	if err := ValidateJiraConfig("https://example.com", "user", ""); err == nil {
		t.Error("empty token should fail")
	}
}
