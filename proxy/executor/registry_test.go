package executor

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type registryRoundTripFunc func(*http.Request) (*http.Response, error)

func (f registryRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func registryResponse(r *http.Request, status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}
}

func testRegistryTransport(f registryRoundTripFunc) *registryTransport {
	return &registryTransport{base: f, username: "123|service", token: "vault-secret", tokens: make(map[string]registryToken)}
}

func TestRegistryOptionalCredentials(t *testing.T) {
	for _, tc := range []struct {
		user, token   string
		enabled, fail bool
	}{
		{"", "", false, false},
		{"123|service", "vault-secret", true, false},
		{"123|service", "", false, true},
		{"", "vault-secret", false, true},
		{" ", "vault-secret", false, true},
		{"user:password", "vault-secret", false, true},
		{"user", "bad\ntoken", false, true},
	} {
		h, err := NewRegistryProxy(tc.user, tc.token)
		if (err != nil) != tc.fail || (h != nil) != tc.enabled {
			t.Fatalf("enabled=%v error=%v; want enabled=%v error=%v", h != nil, err != nil, tc.enabled, tc.fail)
		}
	}
}

func TestRegistryPullAuthenticationAndStreaming(t *testing.T) {
	var authCalls, pulls int
	transport := testRegistryTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/auth/realms/rhcc/protocol/redhat-docker-v2/auth" {
			authCalls++
			user, password, ok := r.BasicAuth()
			if !ok || user != "123|service" || password != "vault-secret" || r.URL.Host != "registry.redhat.io" || r.URL.Scheme != "https" {
				t.Fatal("credentials must go only to the fixed HTTPS token endpoint")
			}
			if q := r.URL.Query(); q.Get("service") != "docker-registry" || q.Get("scope") != "repository:rhel9/nested/image:pull" || q.Get("client_id") != "rehor" {
				t.Fatalf("wrong token query: %v", q)
			}
			return registryResponse(r, 200, `{"token":"short-lived","expires_in":300}`), nil
		}
		pulls++
		if r.Host != "registry.redhat.io" || r.Header.Get("Authorization") != "Bearer short-lived" || r.Header.Get("Cookie") != "" || r.Header.Get("Proxy-Authorization") != "" {
			t.Fatal("incorrect registry authentication or leaked client credentials")
		}
		if r.Header.Get("Range") != "bytes=0-3" || r.Header.Get("Accept") != "application/vnd.oci.image.manifest.v1+json" {
			t.Fatal("pull headers were lost")
		}
		resp := registryResponse(r, 206, "blob")
		resp.Header.Set("Docker-Content-Digest", "sha256:abc")
		resp.Header.Set("Content-Range", "bytes 0-3/9")
		resp.Header.Set("Authorization", "secret")
		resp.Header.Set("WWW-Authenticate", "secret")
		resp.Header.Set("Set-Cookie", "secret")
		return resp, nil
	})
	h := newRegistryHandler(transport)
	for _, method := range []string{"GET", "HEAD"} {
		r := httptest.NewRequest(method, "/v2/rhel9/nested/image/manifests/latest", nil)
		r.Header.Set("Authorization", "Bearer client-controlled")
		r.Header.Set("Cookie", "client-cookie")
		r.Header.Set("Proxy-Authorization", "client-secret")
		r.Header.Set("Range", "bytes=0-3")
		r.Header.Set("Accept", "application/vnd.oci.image.manifest.v1+json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 206 || w.Header().Get("Docker-Content-Digest") != "sha256:abc" || w.Header().Get("Content-Range") != "bytes 0-3/9" {
			t.Fatalf("pull response changed: %d %v", w.Code, w.Header())
		}
		for _, key := range []string{"Authorization", "WWW-Authenticate", "Set-Cookie"} {
			if w.Header().Get(key) != "" {
				t.Fatalf("leaked %s", key)
			}
		}
	}
	if authCalls != 1 || pulls != 2 {
		t.Fatalf("token calls=%d pulls=%d", authCalls, pulls)
	}
}

func TestRegistryRejectsNonPullRequests(t *testing.T) {
	h := newRegistryHandler(testRegistryTransport(func(r *http.Request) (*http.Response, error) {
		t.Fatal("rejected request reached upstream")
		return nil, nil
	}))
	for _, tc := range []struct {
		method, path string
		status       int
	}{
		{"GET", "/healthz", 200},
		{"POST", "/v2/rhel9/image/blobs/uploads/", 405},
		{"PUT", "/v2/rhel9/image/manifests/latest", 405},
		{"DELETE", "/v2/rhel9/image/manifests/sha256:abc", 405},
		{"GET", "/auth/realms/rhcc/protocol/redhat-docker-v2/auth", 404},
		{"GET", "/v2/_catalog", 404},
		{"GET", "/v2/rhel9/../image/manifests/latest", 404},
		{"GET", "/v2/rhel9%2fimage/manifests/latest", 404},
		{"GET", "/v2/rhel9/image/manifests/..", 404},
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Code != tc.status {
			t.Errorf("%s %s: %d, want %d", tc.method, tc.path, w.Code, tc.status)
		}
	}
}

func TestRegistryRefreshAndScopeIsolation(t *testing.T) {
	var authCalls int
	transport := testRegistryTransport(func(r *http.Request) (*http.Response, error) {
		authCalls++
		return registryResponse(r, 200, fmt.Sprintf(`{"access_token":"token-%d","expires_in":300}`, authCalls)), nil
	})
	ctx := context.Background()
	a, _ := transport.bearerToken(ctx, "repository:a:pull", "")
	b, _ := transport.bearerToken(ctx, "repository:b:pull", "")
	if a == b {
		t.Fatal("reused token across repositories")
	}
	refreshed, _ := transport.bearerToken(ctx, "repository:a:pull", a)
	if refreshed == a {
		t.Fatal("rejected token was reused")
	}
	transport.tokens["repository:a:pull"] = registryToken{refreshed, time.Now().Add(-time.Second)}
	expired, _ := transport.bearerToken(ctx, "repository:a:pull", "")
	if expired == refreshed {
		t.Fatal("expired token was reused")
	}
}

func TestRegistryConcurrentTokenReuse(t *testing.T) {
	var calls atomic.Int32
	transport := testRegistryTransport(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		return registryResponse(r, 200, `{"token":"cached","expires_in":300}`), nil
	})
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := transport.bearerToken(context.Background(), "repository:image:pull", ""); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("token endpoint called %d times", calls.Load())
	}
}

func TestRegistryRetriesUnauthorizedOnce(t *testing.T) {
	for _, alwaysUnauthorized := range []bool{false, true} {
		var authCalls, pulls int
		h := newRegistryHandler(testRegistryTransport(func(r *http.Request) (*http.Response, error) {
			if strings.HasPrefix(r.URL.Path, "/auth/") {
				authCalls++
				return registryResponse(r, 200, fmt.Sprintf(`{"token":"token-%d"}`, authCalls)), nil
			}
			pulls++
			if pulls == 1 || alwaysUnauthorized {
				return registryResponse(r, 401, "denied"), nil
			}
			return registryResponse(r, 200, "manifest"), nil
		}))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "/v2/image/manifests/latest", nil))
		want := 200
		if alwaysUnauthorized {
			want = 401
		}
		if w.Code != want || authCalls != 2 || pulls != 2 {
			t.Fatalf("status=%d auth=%d pulls=%d", w.Code, authCalls, pulls)
		}
	}
}

func TestRegistryFollowsCDNWithoutCredentials(t *testing.T) {
	var cdnCalls int
	h := newRegistryHandler(testRegistryTransport(func(r *http.Request) (*http.Response, error) {
		if strings.HasPrefix(r.URL.Path, "/auth/") {
			return registryResponse(r, 200, `{"token":"bearer"}`), nil
		}
		if r.URL.Host == "registry.redhat.io" {
			resp := registryResponse(r, 307, "")
			resp.Header.Set("Location", "https://cdn01.quay.io/blob?signature=signed-value")
			return resp, nil
		}
		cdnCalls++
		if r.URL.Host != "cdn01.quay.io" || r.URL.RawQuery != "signature=signed-value" || r.Header.Get("Authorization") != "" || r.Header.Get("Referer") != "" {
			t.Fatal("invalid CDN redirect or leaked credential")
		}
		return registryResponse(r, 200, "layer data"), nil
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/v2/image/blobs/sha256:abc", nil))
	if w.Code != 200 || w.Body.String() != "layer data" || w.Header().Get("Location") != "" || cdnCalls != 1 {
		t.Fatalf("blob redirect not handled: %d %q", w.Code, w.Body.String())
	}
}

func TestRegistryRejectsUnsafeRedirects(t *testing.T) {
	for _, target := range []string{
		"http://cdn.quay.io/blob", "https://cdn.quay.io:444/blob", "https://user@cdn.quay.io/blob",
		"https://cdn.quay.io.evil.example/blob", "https://127.0.0.1/blob", "https://quay.io/blob",
		redHatRegistryAuth,
	} {
		u, _ := url.Parse(target)
		if err := registryRedirect(&http.Request{URL: u, Header: make(http.Header)}, nil); err == nil {
			t.Errorf("allowed %s", target)
		}
	}
}

func TestRegistryTokenFailuresAreRedacted(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
	}{
		{401, "vault-secret"}, {200, "vault-secret"}, {200, `{}`}, {200, `{"token":"bad\ntoken"}`},
		{302, "vault-secret"},
	} {
		calls := 0
		h := newRegistryHandler(testRegistryTransport(func(r *http.Request) (*http.Response, error) {
			calls++
			resp := registryResponse(r, tc.status, tc.body)
			resp.Header.Set("Location", "https://evil.example/steal")
			return resp, nil
		}))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "/v2/", nil))
		if w.Code != 502 || strings.Contains(w.Body.String(), "vault-secret") || calls != 1 {
			t.Fatalf("unsafe token failure: %d %q calls=%d", w.Code, w.Body.String(), calls)
		}
	}
}
