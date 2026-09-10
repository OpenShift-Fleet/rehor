package executor

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/oauth2"
)

type staticTokenSource struct{ token string }

func (s *staticTokenSource) Token() (*oauth2.Token, error) {
	return &oauth2.Token{AccessToken: s.token}, nil
}

func TestRewritePath(t *testing.T) {
	tests := []struct {
		path    string
		project string
		region  string
		want    string
	}{
		{
			"/v1/projects/dummy-id/locations/global/publishers/anthropic/models/claude-sonnet-4-20250514:rawPredict",
			"real-project", "us-east5",
			"/v1/projects/real-project/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-20250514:rawPredict",
		},
		{
			"/v1/projects/foo/locations/bar/publishers/anthropic/models/claude-opus-4-20250514:streamRawPredict",
			"my-proj", "us-central1",
			"/v1/projects/my-proj/locations/us-central1/publishers/anthropic/models/claude-opus-4-20250514:streamRawPredict",
		},
	}

	for _, tt := range tests {
		got := rewritePath(tt.path, tt.project, tt.region)
		if got != tt.want {
			t.Errorf("rewritePath(%q, %q, %q) = %q, want %q", tt.path, tt.project, tt.region, got, tt.want)
		}
	}
}

func TestHealthz(t *testing.T) {
	ts := &staticTokenSource{token: "test-token"}
	policy := NewVertexPolicy([]string{"claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"})
	handler := NewVertexProxy("proj", "us-east5", ts, policy)

	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("/healthz status = %d, want 200", w.Code)
	}
}

func TestBlockedModel(t *testing.T) {
	ts := &staticTokenSource{token: "test-token"}
	policy := NewVertexPolicy([]string{"claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"})
	handler := NewVertexProxy("proj", "us-east5", ts, policy)

	req := httptest.NewRequest("POST",
		"/v1/projects/dummy/locations/global/publishers/anthropic/models/gemini-pro:rawPredict",
		strings.NewReader("{}"))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("blocked model status = %d, want 403", w.Code)
	}
}

func TestMalformedPath(t *testing.T) {
	ts := &staticTokenSource{token: "test-token"}
	policy := NewVertexPolicy([]string{"claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"})
	handler := NewVertexProxy("proj", "us-east5", ts, policy)

	req := httptest.NewRequest("POST", "/v1/bad/path", strings.NewReader("{}"))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("malformed path status = %d, want 400", w.Code)
	}
}

func TestAllowedModelForwarded(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-token-123" {
			t.Errorf("upstream got Authorization = %q, want 'Bearer test-token-123'", auth)
		}
		if !strings.Contains(r.URL.Path, "projects/real-proj") {
			t.Errorf("upstream path = %q, want projects/real-proj", r.URL.Path)
		}
		if !strings.Contains(r.URL.Path, "locations/us-east5") {
			t.Errorf("upstream path = %q, want locations/us-east5", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	_ = upstream
}
