package main

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testEnv(pairs map[string]string) func(string) string {
	return func(key string) string { return pairs[key] }
}

func TestDeriveHTTPURL(t *testing.T) {
	cases := []struct {
		name     string
		addr     string
		wantURL  string
		wantUnix string
		err      bool
	}{
		{"host port", "devbot-proxy:9090", "http://devbot-proxy:9090/executor/execute", "", false},
		{"ipv4", "127.0.0.1:9090", "http://127.0.0.1:9090/executor/execute", "", false},
		{"ipv6", "[::1]:9090", "http://[::1]:9090/executor/execute", "", false},
		{"dns scheme", "dns:///devbot-proxy:9090", "http://devbot-proxy:9090/executor/execute", "", false},
		{"unix", "unix:///var/run/devbot/executor.sock", "http://executor/executor/execute", "/var/run/devbot/executor.sock", false},
		{"unix temp", "unix:///tmp/x.sock", "http://executor/executor/execute", "/tmp/x.sock", false},
		{"unix empty path", "unix://", "", "", true},
		{"missing port", "devbot-proxy", "", "", true},
		{"unsupported scheme", "https://executor.example", "", "", true},
		{"passthrough scheme", "passthrough:///devbot-proxy:9090", "", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			u, unixPath, err := deriveHTTPURL(tc.addr)
			if tc.err {
				if err == nil {
					t.Fatalf("deriveHTTPURL(%q) = %v, want error", tc.addr, u)
				}
				return
			}
			if err != nil {
				t.Fatalf("deriveHTTPURL(%q): %v", tc.addr, err)
			}
			if u.String() != tc.wantURL {
				t.Errorf("url = %q, want %q", u.String(), tc.wantURL)
			}
			if unixPath != tc.wantUnix {
				t.Errorf("unixPath = %q, want %q", unixPath, tc.wantUnix)
			}
		})
	}
}

func TestParseHTTPURL(t *testing.T) {
	valid := []struct {
		name, raw, want string
	}{
		{"https route", "https://executor.example.com/executor/execute", "https://executor.example.com/executor/execute"},
		{"https host port", "https://hub.example.com:443/executor/execute", "https://hub.example.com:443/executor/execute"},
		{"http loopback", "http://127.0.0.1:9090/executor/execute", "http://127.0.0.1:9090/executor/execute"},
		{"http localhost", "http://localhost:9090/executor/execute", "http://localhost:9090/executor/execute"},
	}
	for _, tc := range valid {
		t.Run(tc.name, func(t *testing.T) {
			u, err := parseHTTPURL(tc.raw)
			if err != nil {
				t.Fatalf("parseHTTPURL(%q): %v", tc.raw, err)
			}
			if u.String() != tc.want {
				t.Errorf("url = %q, want %q", u.String(), tc.want)
			}
		})
	}

	invalid := []struct{ name, raw string }{
		{"http non-loopback", "http://executor.example.com/executor/execute"},
		{"wrong scheme", "grpc://executor.example.com/executor/execute"},
		{"no scheme", "executor.example.com/executor/execute"},
		{"userinfo", "https://user:pass@executor.example.com/executor/execute"},
		{"query", "https://executor.example.com/executor/execute?x=1"},
		{"empty query delimiter", "https://executor.example.com/executor/execute?"},
		{"fragment", "https://executor.example.com/executor/execute#f"},
		{"empty fragment delimiter", "https://executor.example.com/executor/execute#"},
		{"wrong path", "https://executor.example.com/execute"},
		{"wrong path prefix", "https://executor.example.com/api/executor/execute"},
		{"no host", "https:///executor/execute"},
		{"parse error", "://missing-scheme"},
		{"invalid port parse error", "https://user:secretpw@executor.example.com:not^a^port/executor/execute"},
	}
	for _, tc := range invalid {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseHTTPURL(tc.raw)
			if err == nil {
				t.Errorf("parseHTTPURL(%q) accepted", tc.raw)
			}
			// Parse failures must never echo the raw URL: url.Parse errors
			// can include userinfo and other raw material.
			if strings.Contains(err.Error(), "secretpw") {
				t.Errorf("error leaks raw URL material: %v", err)
			}
		})
	}
}

func TestResolveTransportConfigDefaultDerivedHTTP(t *testing.T) {
	// No env at all: derived HTTP over the default unix socket.
	tc, err := resolveTransportConfig(testEnv(nil))
	if err != nil {
		t.Fatalf("default: %v", err)
	}
	if tc.grpc {
		t.Error("default must be HTTP")
	}
	if tc.http.url.String() != "http://executor/executor/execute" {
		t.Errorf("url = %q", tc.http.url.String())
	}
	if tc.http.unixPath != "/var/run/devbot/executor.sock" {
		t.Errorf("unixPath = %q", tc.http.unixPath)
	}

	// Legacy EXECUTOR_ADDR host:port derives internal plaintext HTTP.
	tc, err = resolveTransportConfig(testEnv(map[string]string{"EXECUTOR_ADDR": "devbot-proxy:9090"}))
	if err != nil {
		t.Fatalf("host:port: %v", err)
	}
	if tc.grpc || tc.http.url.String() != "http://devbot-proxy:9090/executor/execute" {
		t.Errorf("host:port derived url = %q grpc=%v", tc.http.url.String(), tc.grpc)
	}

	// dns:/// scheme derives safely.
	tc, err = resolveTransportConfig(testEnv(map[string]string{"EXECUTOR_ADDR": "dns:///devbot-proxy:9090"}))
	if err != nil {
		t.Fatalf("dns: %v", err)
	}
	if tc.http.url.String() != "http://devbot-proxy:9090/executor/execute" {
		t.Errorf("dns derived url = %q", tc.http.url.String())
	}
}

func TestResolveTransportConfigExplicitGRPCRollback(t *testing.T) {
	tc, err := resolveTransportConfig(testEnv(map[string]string{"EXECUTOR_TRANSPORT": "grpc"}))
	if err != nil {
		t.Fatalf("grpc rollback: %v", err)
	}
	if !tc.grpc {
		t.Error("EXECUTOR_TRANSPORT=grpc must select gRPC")
	}

	// Case-insensitive and trimmed.
	tc, err = resolveTransportConfig(testEnv(map[string]string{"EXECUTOR_TRANSPORT": " GRPC "}))
	if err != nil || !tc.grpc {
		t.Errorf("GRPC uppercase: %v grpc=%v", err, tc.grpc)
	}

	// Invalid selector is a config error.
	if _, err := resolveTransportConfig(testEnv(map[string]string{"EXECUTOR_TRANSPORT": "carrier-pigeon"})); err == nil {
		t.Error("invalid EXECUTOR_TRANSPORT accepted")
	}

	// grpc conflicts with explicit URL and credentials.
	for _, env := range []map[string]string{
		{"EXECUTOR_TRANSPORT": "grpc", "EXECUTOR_HTTP_URL": "https://executor.example.com/executor/execute"},
		{"EXECUTOR_TRANSPORT": "grpc", "EXECUTOR_TOKEN": "openshell:resolve:env:executor"},
		{"EXECUTOR_TRANSPORT": "grpc", "EXECUTOR_TOKEN_FILE": "/tmp/token"},
		{"EXECUTOR_TRANSPORT": "grpc", "EXECUTOR_CA_FILE": "/tmp/ca.pem"},
	} {
		if _, err := resolveTransportConfig(testEnv(env)); err == nil {
			t.Errorf("grpc conflict accepted: %v", env)
		}
	}
}

func TestResolveTransportConfigDeadVarsRejected(t *testing.T) {
	for _, env := range []map[string]string{
		{"EXECUTOR_TLS": "true"},
		{"EXECUTOR_SERVER_NAME": "executor.test"},
	} {
		if _, err := resolveTransportConfig(testEnv(env)); err == nil {
			t.Errorf("dead var accepted: %v", env)
		}
	}
}

func TestResolveTransportConfigAuthRejectedOnDerivedPlaintext(t *testing.T) {
	for _, env := range []map[string]string{
		{"EXECUTOR_TOKEN": "openshell:resolve:env:executor"},
		{"EXECUTOR_CA_FILE": "/tmp/ca.pem"},
	} {
		_, err := resolveTransportConfig(testEnv(env))
		if err == nil {
			t.Fatalf("credentials on derived plaintext accepted: %v", env)
		}
		if !strings.Contains(err.Error(), "https EXECUTOR_HTTP_URL") {
			t.Errorf("error for %v does not explain the requirement: %v", env, err)
		}
	}

	// With EXECUTOR_ADDR set (legacy deployments) the rejection is identical.
	_, err := resolveTransportConfig(testEnv(map[string]string{
		"EXECUTOR_ADDR":  "devbot-proxy:9090",
		"EXECUTOR_TOKEN": "openshell:resolve:env:executor",
	}))
	if err == nil {
		t.Fatal("credentials on derived host:port plaintext accepted")
	}
}

func TestResolveTransportTokenFileRejected(t *testing.T) {
	// EXECUTOR_TOKEN_FILE is always rejected — never read, never echoed.
	// A sentinel nonexistent path proves no read is attempted, and the
	// error is identical whether or not an explicit URL is configured.
	sentinel := filepath.Join(t.TempDir(), "nonexistent-sentinel-token")
	envs := []map[string]string{
		{"EXECUTOR_TOKEN_FILE": sentinel},
		{
			"EXECUTOR_HTTP_URL":   "https://executor.example.com/executor/execute",
			"EXECUTOR_TOKEN_FILE": sentinel,
		},
		{"EXECUTOR_TRANSPORT": "grpc", "EXECUTOR_TOKEN_FILE": sentinel},
	}
	var firstErr string
	for i, env := range envs {
		_, err := resolveTransportConfig(testEnv(env))
		if err == nil {
			t.Fatalf("case %d: EXECUTOR_TOKEN_FILE accepted", i)
		}
		if !strings.Contains(err.Error(), "EXECUTOR_TOKEN_FILE is not supported") {
			t.Errorf("case %d: error = %v", i, err)
		}
		if strings.Contains(err.Error(), sentinel) {
			t.Errorf("case %d: error echoes the path: %v", i, err)
		}
		if i == 0 {
			firstErr = err.Error()
		} else if err.Error() != firstErr {
			t.Errorf("case %d: error differs from the no-URL case (read attempted?): %v vs %v", i, err, firstErr)
		}
	}
}

func TestResolveTransportConfigTokenEnvPlaceholderOnly(t *testing.T) {
	base := map[string]string{
		"EXECUTOR_HTTP_URL": "https://executor.example.com/executor/execute",
	}
	valid := []string{
		"openshell:resolve:env:executor",
		"openshell:resolve:env:memory_token_1",
	}
	for _, tok := range valid {
		env := map[string]string{"EXECUTOR_TOKEN": tok}
		for k, v := range base {
			env[k] = v
		}
		tc, err := resolveTransportConfig(testEnv(env))
		if err != nil {
			t.Errorf("valid placeholder %q rejected: %v", tok, err)
			continue
		}
		if tc.http.staticToken != tok {
			t.Errorf("staticToken = %q", tc.http.staticToken)
		}
	}

	secret := "eyJhbGciOiJSUzI1NiJ9.raw.jwt-value"
	rawSecrets := []string{secret, secret + " with space"}
	malformedMarkers := []string{
		"openshell:resolve:env:",
		"openshell:resolve:env:has-dash",
		"openshell:resolve:env:has/slash",
		"openshell:resolve:env:has space",
		"xopenshell:resolve:env:executor",
		"openshell:resolve:env:executor\n",
		"bearer openshell:resolve:env:executor",
	}
	for _, tok := range append(rawSecrets, malformedMarkers...) {
		env := map[string]string{"EXECUTOR_TOKEN": tok}
		for k, v := range base {
			env[k] = v
		}
		_, err := resolveTransportConfig(testEnv(env))
		if err == nil {
			t.Errorf("invalid EXECUTOR_TOKEN %q accepted", tok)
			continue
		}
		if !strings.Contains(err.Error(), "nonsecret placeholder") {
			t.Errorf("error for %q does not explain placeholder requirement: %v", tok, err)
		}
	}
	// Real-credential attempts must never be echoed in the error.
	for _, tok := range rawSecrets {
		env := map[string]string{"EXECUTOR_TOKEN": tok}
		for k, v := range base {
			env[k] = v
		}
		_, err := resolveTransportConfig(testEnv(env))
		if err != nil && strings.Contains(err.Error(), tok) {
			t.Errorf("error leaks token value: %v", err)
		}
		if err != nil && strings.Contains(err.Error(), "eyJhbGciOiJSUzI1NiJ9") {
			t.Errorf("error leaks JWT material: %v", err)
		}
	}
}

func TestResolveTransportConfigExplicitURLValidation(t *testing.T) {
	// Invalid explicit URLs are config errors.
	for _, raw := range []string{
		"http://executor.example.com/executor/execute", // non-loopback http
		"https://executor.example.com/execute",         // wrong path
		"https://user:pass@executor.example.com/executor/execute",
		"https://executor.example.com/executor/execute?q=1",
		"https://executor.example.com/executor/execute#f",
		"ftp://executor.example.com/executor/execute",
	} {
		if _, err := resolveTransportConfig(testEnv(map[string]string{"EXECUTOR_HTTP_URL": raw})); err == nil {
			t.Errorf("explicit URL %q accepted", raw)
		}
	}

	// Credentials on an explicit loopback http endpoint are rejected.
	if _, err := resolveTransportConfig(testEnv(map[string]string{
		"EXECUTOR_HTTP_URL": "http://127.0.0.1:9090/executor/execute",
		"EXECUTOR_TOKEN":    "openshell:resolve:env:executor",
	})); err == nil {
		t.Error("credentials on plain http accepted")
	}

	// CA file is additive-only and must contain PEM.
	dir := t.TempDir()
	bad := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(bad, []byte("not a pem"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveTransportConfig(testEnv(map[string]string{
		"EXECUTOR_HTTP_URL": "https://executor.example.com/executor/execute",
		"EXECUTOR_CA_FILE":  bad,
	})); err == nil {
		t.Error("non-PEM CA file accepted")
	}
	if _, err := resolveTransportConfig(testEnv(map[string]string{
		"EXECUTOR_HTTP_URL": "https://executor.example.com/executor/execute",
		"EXECUTOR_CA_FILE":  filepath.Join(dir, "missing.pem"),
	})); err == nil {
		t.Error("missing CA file accepted")
	}
}

func TestIsLoopbackHost(t *testing.T) {
	valid := []string{"localhost", "127.0.0.1", "::1"}
	for _, h := range valid {
		if !isLoopbackHost(h) {
			t.Errorf("isLoopbackHost(%q) = false", h)
		}
	}
	invalid := []string{"executor.example.com", "10.0.0.1", "", "localhost.evil.com"}
	for _, h := range invalid {
		if isLoopbackHost(h) {
			t.Errorf("isLoopbackHost(%q) = true", h)
		}
	}
}

func TestRedactURL(t *testing.T) {
	u, err := url.Parse("https://user:secret@example.com/executor/execute")
	if err != nil {
		t.Fatal(err)
	}
	got := redactURL(u)
	if strings.Contains(got, "secret") || strings.Contains(got, "user:") {
		t.Errorf("redactURL leaked userinfo: %q", got)
	}
	if got != "https://example.com/executor/execute" {
		t.Errorf("redactURL = %q", got)
	}
	if redactURL(nil) != "" {
		t.Error("redactURL(nil) must be empty")
	}
}
