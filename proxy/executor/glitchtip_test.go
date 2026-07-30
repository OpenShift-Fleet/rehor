package executor

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGlitchTipHealthz(t *testing.T) {
	handler := NewGlitchTipProxy("https://glitchtip.example.com", "tok-123")

	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("/healthz status = %d, want 200", w.Code)
	}
}

func TestGlitchTipBearerTokenInjected(t *testing.T) {
	var gotAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	handler := NewGlitchTipProxy(upstream.URL, "my-secret-token")

	req := httptest.NewRequest("GET", "/api/0/organizations/", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	want := "Bearer my-secret-token"
	if gotAuth != want {
		t.Errorf("upstream got Authorization = %q, want %q", gotAuth, want)
	}
}

func TestGlitchTipPathPreserved(t *testing.T) {
	var gotPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	handler := NewGlitchTipProxy(upstream.URL, "token")

	req := httptest.NewRequest("POST", "/api/0/projects/my-org/my-proj/issues/", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if gotPath != "/api/0/projects/my-org/my-proj/issues/" {
		t.Errorf("upstream path = %q, want /api/0/projects/my-org/my-proj/issues/", gotPath)
	}
}

func TestGlitchTipQueryParamsPreserved(t *testing.T) {
	var gotQuery string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	handler := NewGlitchTipProxy(upstream.URL, "token")

	req := httptest.NewRequest("GET", "/api/0/issues/?query=is:unresolved&limit=25", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	want := "query=is:unresolved&limit=25"
	if gotQuery != want {
		t.Errorf("upstream query = %q, want %q", gotQuery, want)
	}
}

func TestGlitchTipValidateConfig(t *testing.T) {
	if err := ValidateGlitchTipConfig("https://glitchtip.example.com", "token"); err != nil {
		t.Errorf("valid config returned error: %v", err)
	}
	if err := ValidateGlitchTipConfig("", "token"); err == nil {
		t.Error("empty URL should fail")
	}
	if err := ValidateGlitchTipConfig("https://glitchtip.example.com", ""); err == nil {
		t.Error("empty token should fail")
	}
}
