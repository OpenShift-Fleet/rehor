package executor

import (
	"bytes"
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestGitAuthProxy_GitHub(t *testing.T) {
	var gotAuth, gotPath, gotQuery string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	upstreamURL, _ := url.Parse(upstream.URL)

	registry := map[string]*GitHost{
		"github.com": {
			Scheme:   upstreamURL.Scheme,
			Host:     upstreamURL.Host,
			AuthType: "bearer",
			Token:    func() string { return "test-gh-token-123" },
			Username: nil,
		},
	}

	handler := newGitAuthProxyWithRegistry(registry)

	req := httptest.NewRequest("GET", "/github.com/org/repo.git/info/refs?service=git-upload-pack", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	wantAuth := "Bearer test-gh-token-123"
	if gotAuth != wantAuth {
		t.Errorf("Authorization = %q, want %q", gotAuth, wantAuth)
	}
	if gotPath != "/org/repo.git/info/refs" {
		t.Errorf("Path = %q, want /org/repo.git/info/refs", gotPath)
	}
	if gotQuery != "service=git-upload-pack" {
		t.Errorf("Query = %q, want service=git-upload-pack", gotQuery)
	}
}

func TestGitAuthProxy_GitLab(t *testing.T) {
	var gotAuth, gotPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	upstreamURL, _ := url.Parse(upstream.URL)

	registry := map[string]*GitHost{
		"gitlab.cee.redhat.com": {
			Scheme:   upstreamURL.Scheme,
			Host:     upstreamURL.Host,
			AuthType: "basic",
			Token:    func() string { return "test-gl-token" },
			Username: func() string { return "gitlab-bot" },
		},
	}

	handler := newGitAuthProxyWithRegistry(registry)

	req := httptest.NewRequest("POST", "/gitlab.cee.redhat.com/team/project.git/git-receive-pack", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	wantAuth := "Basic Z2l0bGFiLWJvdDp0ZXN0LWdsLXRva2Vu"
	if gotAuth != wantAuth {
		t.Errorf("Authorization = %q, want %q", gotAuth, wantAuth)
	}
	if gotPath != "/team/project.git/git-receive-pack" {
		t.Errorf("Path = %q, want /team/project.git/git-receive-pack", gotPath)
	}
}

func TestGitAuthProxy_UnknownHost(t *testing.T) {
	registry := map[string]*GitHost{
		"github.com": {
			Scheme:   "https",
			Host:     "github.com",
			AuthType: "bearer",
			Token:    func() string { return "token" },
			Username: nil,
		},
	}

	handler := newGitAuthProxyWithRegistry(registry)

	req := httptest.NewRequest("GET", "/evil.com/repo.git/info/refs", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, "unknown host") {
		t.Errorf("body = %q, want 'unknown host'", body)
	}
}

func TestGitAuthProxy_NoHost(t *testing.T) {
	registry := map[string]*GitHost{}
	handler := newGitAuthProxyWithRegistry(registry)

	req := httptest.NewRequest("GET", "/info/refs", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, "no host in path") {
		t.Errorf("body = %q, want 'no host in path'", body)
	}
}

func TestGitAuthProxy_Healthz(t *testing.T) {
	handler := NewGitAuthProxy()

	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	body := w.Body.String()
	if body != "ok\n" {
		t.Errorf("body = %q, want 'ok\\n'", body)
	}
}

func TestGitAuthProxy_LargeBody(t *testing.T) {
	var gotBody []byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := new(bytes.Buffer)
		_, err := buf.ReadFrom(r.Body)
		if err != nil {
			t.Errorf("failed to read request body: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		gotBody = buf.Bytes()
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	upstreamURL, _ := url.Parse(upstream.URL)

	registry := map[string]*GitHost{
		"github.com": {
			Scheme:   upstreamURL.Scheme,
			Host:     upstreamURL.Host,
			AuthType: "bearer",
			Token:    func() string { return "token" },
			Username: nil,
		},
	}

	handler := newGitAuthProxyWithRegistry(registry)

	largeBody := bytes.Repeat([]byte("PACK"), 100000)
	req := httptest.NewRequest("POST", "/github.com/org/repo.git/git-upload-pack", bytes.NewReader(largeBody))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	if len(gotBody) != len(largeBody) {
		t.Errorf("body length = %d, want %d", len(gotBody), len(largeBody))
	}
	if !bytes.Equal(gotBody, largeBody) {
		t.Error("body mismatch")
	}
}

func TestGitAuthProxy_MissingToken(t *testing.T) {
	registry := map[string]*GitHost{
		"github.com": {
			Scheme:   "https",
			Host:     "github.com",
			AuthType: "bearer",
			Token:    func() string { return "" },
			Username: nil,
		},
	}

	handler := newGitAuthProxyWithRegistry(registry)

	req := httptest.NewRequest("GET", "/github.com/org/repo.git/info/refs", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, "missing token") {
		t.Errorf("body = %q, want 'missing token'", body)
	}
}

func TestGitAuthProxy_EncodedHost(t *testing.T) {
	registry := map[string]*GitHost{
		"github.com": {
			Scheme:   "https",
			Host:     "github.com",
			AuthType: "bearer",
			Token:    func() string { return "token" },
			Username: nil,
		},
	}

	handler := newGitAuthProxyWithRegistry(registry)

	req := httptest.NewRequest("GET", "/%67ithub.com/org/repo.git/info/refs", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
}

func TestGitAuthProxy_PathTraversal(t *testing.T) {
	registry := map[string]*GitHost{
		"github.com": {
			Scheme:   "https",
			Host:     "github.com",
			AuthType: "bearer",
			Token:    func() string { return "token" },
			Username: nil,
		},
	}

	handler := newGitAuthProxyWithRegistry(registry)

	req := httptest.NewRequest("GET", "/github.com/../evil.com/repo.git/info/refs", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, "path traversal") {
		t.Errorf("body = %q, want 'path traversal'", body)
	}
}

func TestValidateGitAuthConfig(t *testing.T) {
	tests := []struct {
		name        string
		ghToken     string
		glToken     string
		glUsername  string
		wantErr     bool
		errContains string
	}{
		{
			name:    "valid github only",
			ghToken: "gh_token",
			wantErr: false,
		},
		{
			name:       "valid gitlab only",
			glToken:    "gl_token",
			glUsername: "gitlab-user",
			wantErr:    false,
		},
		{
			name:       "valid both",
			ghToken:    "gh_token",
			glToken:    "gl_token",
			glUsername: "gitlab-user",
			wantErr:    false,
		},
		{
			name:        "no tokens",
			wantErr:     true,
			errContains: "at least one git host must be configured",
		},
		{
			name:        "gitlab token without username",
			glToken:     "gl_token",
			wantErr:     true,
			errContains: "GL_USERNAME is required when GITLAB_TOKEN is set",
		},
		{
			name:        "gitlab username without token",
			glUsername:  "gitlab-user",
			wantErr:     true,
			errContains: "GITLAB_TOKEN is required when GL_USERNAME is set",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("GH_TOKEN", tt.ghToken)
			t.Setenv("GITLAB_TOKEN", tt.glToken)
			t.Setenv("GL_USERNAME", tt.glUsername)

			err := ValidateGitAuthConfig()
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateGitAuthConfig() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if err != nil && !strings.Contains(err.Error(), tt.errContains) {
				t.Errorf("ValidateGitAuthConfig() error = %v, want error containing %q", err, tt.errContains)
			}
		})
	}
}

func TestGetEnvAsBool(t *testing.T) {
	tests := []struct {
		name         string
		envValue     string
		defaultValue bool
		want         bool
	}{
		{
			name:         "empty env var returns default true",
			envValue:     "",
			defaultValue: true,
			want:         true,
		},
		{
			name:         "empty env var returns default false",
			envValue:     "",
			defaultValue: false,
			want:         false,
		},
		{
			name:         "true string returns true",
			envValue:     "true",
			defaultValue: false,
			want:         true,
		},
		{
			name:         "false string returns false",
			envValue:     "false",
			defaultValue: true,
			want:         false,
		},
		{
			name:         "1 returns true",
			envValue:     "1",
			defaultValue: false,
			want:         true,
		},
		{
			name:         "0 returns false",
			envValue:     "0",
			defaultValue: true,
			want:         false,
		},
		{
			name:         "invalid value returns default",
			envValue:     "invalid",
			defaultValue: true,
			want:         true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("TEST_BOOL_VAR", tt.envValue)
			got := getEnvAsBool("TEST_BOOL_VAR", tt.defaultValue)
			if got != tt.want {
				t.Errorf("getEnvAsBool() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestPerHostTransportManager_TLSConfig(t *testing.T) {
	tests := []struct {
		name                   string
		host                   string
		hostRegistry           map[string]*GitHost
		wantInsecureSkipVerify bool
		wantMinVersion         uint16
	}{
		{
			name: "gitlab with InsecureSkipVerify true",
			host: "gitlab.cee.redhat.com",
			hostRegistry: map[string]*GitHost{
				"gitlab.cee.redhat.com": {
					Scheme:                "https",
					Host:                  "gitlab.cee.redhat.com",
					AuthType:              AuthTypeBasic,
					Token:                 func() string { return "token" },
					Username:              func() string { return "user" },
					TLSInsecureSkipVerify: true,
				},
			},
			wantInsecureSkipVerify: true,
			wantMinVersion:         tls.VersionTLS12,
		},
		{
			name: "github with InsecureSkipVerify false",
			host: "github.com",
			hostRegistry: map[string]*GitHost{
				"github.com": {
					Scheme:                "https",
					Host:                  "github.com",
					AuthType:              AuthTypeBearer,
					Token:                 func() string { return "token" },
					TLSInsecureSkipVerify: false,
				},
			},
			wantInsecureSkipVerify: false,
			wantMinVersion:         tls.VersionTLS12,
		},
		{
			name:                   "unknown host defaults to secure",
			host:                   "unknown.com",
			hostRegistry:           map[string]*GitHost{},
			wantInsecureSkipVerify: false,
			wantMinVersion:         tls.VersionTLS12,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			manager := NewPerHostTransportManager(tt.hostRegistry)
			tlsConfig := manager.getTLSConfigForHost(tt.host)

			if tlsConfig.InsecureSkipVerify != tt.wantInsecureSkipVerify {
				t.Errorf("InsecureSkipVerify = %v, want %v", tlsConfig.InsecureSkipVerify, tt.wantInsecureSkipVerify)
			}
			if tlsConfig.MinVersion != tt.wantMinVersion {
				t.Errorf("MinVersion = %v, want %v", tlsConfig.MinVersion, tt.wantMinVersion)
			}
		})
	}
}

func TestPerHostTransportManager_CachesTransports(t *testing.T) {
	hostRegistry := map[string]*GitHost{
		"github.com": {
			Scheme:   "https",
			Host:     "github.com",
			AuthType: AuthTypeBearer,
			Token:    func() string { return "token" },
		},
	}

	manager := NewPerHostTransportManager(hostRegistry)

	// Create a mock request
	req1, _ := http.NewRequest("GET", "https://github.com/test", nil)
	req2, _ := http.NewRequest("GET", "https://github.com/test2", nil)

	// The manager should cache the transport for the same host
	_, _ = manager.RoundTrip(req1)
	transport1 := manager.transports["github.com"]

	_, _ = manager.RoundTrip(req2)
	transport2 := manager.transports["github.com"]

	// Should be the same transport instance (cached)
	if transport1 != transport2 {
		t.Error("Expected transport to be cached for the same host")
	}
}

func TestGitAuthProxy_GitLabWithTLSInsecureSkipVerify(t *testing.T) {
	var gotAuth, gotPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	upstreamURL, _ := url.Parse(upstream.URL)

	registry := map[string]*GitHost{
		"gitlab.cee.redhat.com": {
			Scheme:                upstreamURL.Scheme,
			Host:                  upstreamURL.Host,
			AuthType:              "basic",
			Token:                 func() string { return "test-gl-token" },
			Username:              func() string { return "gitlab-bot" },
			TLSInsecureSkipVerify: true,
		},
	}

	handler := newGitAuthProxyWithRegistry(registry)

	req := httptest.NewRequest("POST", "/gitlab.cee.redhat.com/team/project.git/git-receive-pack", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	wantAuth := "Basic Z2l0bGFiLWJvdDp0ZXN0LWdsLXRva2Vu"
	if gotAuth != wantAuth {
		t.Errorf("Authorization = %q, want %q", gotAuth, wantAuth)
	}
	if gotPath != "/team/project.git/git-receive-pack" {
		t.Errorf("Path = %q, want /team/project.git/git-receive-pack", gotPath)
	}
}
