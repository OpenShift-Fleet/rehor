package executor

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// reqRecord captures what a test backend actually received.
type reqRecord struct {
	method  string
	path    string
	rawPath string
	query   string
	body    string
	header  http.Header
}

// recordingBackend is a stand-in loopback listener: it records every request
// and echoes the record back as JSON.
type recordingBackend struct {
	name string
	mu   sync.Mutex
	reqs []reqRecord
}

func (b *recordingBackend) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	rec := reqRecord{
		method:  r.Method,
		path:    r.URL.Path,
		rawPath: r.URL.RawPath,
		query:   r.URL.RawQuery,
		body:    string(body),
		header:  r.Header.Clone(),
	}
	b.mu.Lock()
	b.reqs = append(b.reqs, rec)
	b.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Backend-Name", b.name)
	json.NewEncoder(w).Encode(rec)
}

func (b *recordingBackend) last(t *testing.T) reqRecord {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.reqs) == 0 {
		t.Fatalf("backend %s: no request recorded", b.name)
	}
	return b.reqs[len(b.reqs)-1]
}

func (b *recordingBackend) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.reqs)
}

// gatewayBackends spins up one recording backend per gateway route target.
type gatewayBackends struct {
	models, jiraMCP, jiraREST *recordingBackend
	git, vertex, registry     *recordingBackend
	screenshots, glitchtip    *recordingBackend
	executor                  *recordingBackend
	servers                   []*httptest.Server
}

func newGatewayBackends(t *testing.T) *gatewayBackends {
	t.Helper()
	gb := &gatewayBackends{}
	for _, b := range []**recordingBackend{
		&gb.models, &gb.jiraMCP, &gb.jiraREST, &gb.git,
		&gb.vertex, &gb.registry, &gb.screenshots, &gb.glitchtip,
		&gb.executor,
	} {
		*b = &recordingBackend{}
		srv := httptest.NewServer(*b)
		t.Cleanup(srv.Close)
		gb.servers = append(gb.servers, srv)
	}
	gb.models.name = "models"
	gb.jiraMCP.name = "jira-mcp"
	gb.jiraREST.name = "jira-rest"
	gb.git.name = "git"
	gb.vertex.name = "vertex"
	gb.registry.name = "registry"
	gb.screenshots.name = "screenshots"
	gb.glitchtip.name = "glitchtip"
	gb.executor.name = "executor"
	return gb
}

func (gb *gatewayBackends) config() GatewayConfig {
	u := func(i int) string { return gb.servers[i].URL }
	return GatewayConfig{
		Models:      u(0),
		JiraMCP:     u(1),
		JiraREST:    u(2),
		Git:         u(3),
		Vertex:      u(4),
		Registry:    u(5),
		Screenshots: u(6),
		GlitchTip:   u(7),
		Executor:    u(8),
	}
}

func (gb *gatewayBackends) byName(name string) *recordingBackend {
	switch name {
	case "models":
		return gb.models
	case "jira-mcp":
		return gb.jiraMCP
	case "jira-rest":
		return gb.jiraREST
	case "git":
		return gb.git
	case "vertex":
		return gb.vertex
	case "registry":
		return gb.registry
	case "screenshots":
		return gb.screenshots
	case "glitchtip":
		return gb.glitchtip
	case "executor":
		return gb.executor
	}
	return nil
}

func newTestGateway(t *testing.T, cfg GatewayConfig) http.Handler {
	t.Helper()
	h, err := NewHTTPGateway(cfg)
	if err != nil {
		t.Fatalf("NewHTTPGateway: %v", err)
	}
	return h
}

func TestNewHTTPGatewayConfigValidation(t *testing.T) {
	if _, err := NewHTTPGateway(GatewayConfig{}); err == nil {
		t.Fatal("empty config: expected error")
	}
	bad := []struct {
		name       string
		cfg        GatewayConfig
		wantReason string
	}{
		{"no scheme", GatewayConfig{Models: "127.0.0.1:8450"}, "parseable"},
		{"bad scheme", GatewayConfig{Models: "ftp://127.0.0.1:8450"}, "http or https"},
		{"no host", GatewayConfig{Models: "http://"}, "no host"},
		{"credentials", GatewayConfig{Executor: "http://user:secretpw@127.0.0.1:9090"}, "credentials"},
		{"path", GatewayConfig{Models: "http://127.0.0.1:8450/MARKERPATH"}, "path"},
		{"query", GatewayConfig{Models: "http://127.0.0.1:8450?q=MARKERQ"}, "query or fragment"},
		{"fragment", GatewayConfig{Models: "http://127.0.0.1:8450#MARKERF"}, "query or fragment"},
		{"unparseable", GatewayConfig{Git: "http://[::1"}, "parseable"},
	}
	for _, tc := range bad {
		_, err := NewHTTPGateway(tc.cfg)
		if err == nil {
			t.Errorf("%s: expected error, got nil", tc.name)
			continue
		}
		if !strings.Contains(err.Error(), tc.wantReason) {
			t.Errorf("%s: error %q does not mention %q", tc.name, err, tc.wantReason)
		}
		// Rejection messages carry the config field and reason only; the raw
		// URL (which can contain credentials) must never be echoed.
		if strings.Contains(err.Error(), "secretpw") || strings.Contains(err.Error(), "MARKER") {
			t.Errorf("%s: error message echoes raw URL: %s", tc.name, err)
		}
	}
	if _, err := NewHTTPGateway(DefaultGatewayConfig()); err != nil {
		t.Errorf("DefaultGatewayConfig: unexpected error: %v", err)
	}
}

func TestHTTPGatewayRouting(t *testing.T) {
	gb := newGatewayBackends(t)
	gw := httptest.NewServer(newTestGateway(t, gb.config()))
	defer gw.Close()

	client := &http.Client{Timeout: 10 * time.Second}
	cases := []struct {
		name        string
		method      string
		path        string
		body        string
		wantBackend string
		wantPath    string
		wantRawPath string
		wantQuery   string
	}{
		{"canonical v1 models", "GET", "/v1/models", "", "models", "/v1/models", "", ""},
		{"canonical v1 chat", "POST", "/v1/chat/completions", `{"model":"m"}`, "models", "/v1/chat/completions", "", ""},
		{"models alias strips prefix", "GET", "/models/v1/models", "", "models", "/v1/models", "", ""},
		{"models alias other path", "GET", "/models/v1/responses", "", "models", "/v1/responses", "", ""},
		{"jira mcp root", "POST", "/jira/mcp", "{}", "jira-mcp", "/mcp", "", ""},
		{"jira mcp trailing slash", "GET", "/jira/mcp/", "", "jira-mcp", "/mcp", "", ""},
		{"jira rest keeps rest prefix", "GET", "/jira/rest/api/2/myself?fields=summary", "", "jira-rest", "/rest/api/2/myself", "", "fields=summary"},
		{"git smart http info refs", "GET", "/git/github.com/o/r.git/info/refs?service=git-upload-pack", "", "git", "/github.com/o/r.git/info/refs", "", "service=git-upload-pack"},
		{"git receive pack", "POST", "/git/github.com/o/r.git/git-receive-pack", "PACK", "git", "/github.com/o/r.git/git-receive-pack", "", ""},
		{"vertex strips prefix", "POST", "/vertex/v1/projects/p/locations/us-central1/endpoints/e:streamRawPredict", "{}", "vertex", "/v1/projects/p/locations/us-central1/endpoints/e:streamRawPredict", "", ""},
		{"registry alias", "GET", "/registry/v2/rhel9/manifests/latest", "", "registry", "/v2/rhel9/manifests/latest", "", ""},
		{"registry canonical v2 head", "HEAD", "/v2/rhel9/manifests/latest", "", "registry", "/v2/rhel9/manifests/latest", "", ""},
		{"registry canonical v2 root", "GET", "/v2/", "", "registry", "/v2/", "", ""},
		{"screenshots upload", "POST", "/screenshots/upload", "PNGDATA", "screenshots", "/upload", "", ""},
		{"glitchtip events", "POST", "/glitchtip/api/0/events/", "{}", "glitchtip", "/api/0/events/", "", ""},
		{"executor execute", "POST", "/executor/execute", `{"tool":"gh"}`, "executor", "/executor/execute", "", ""},
		{"executor execute with query", "POST", "/executor/execute?wait=true", `{"tool":"gh"}`, "executor", "/executor/execute", "", "wait=true"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := gb.byName(tc.wantBackend).count()
			var body io.Reader
			if tc.body != "" {
				body = strings.NewReader(tc.body)
			}
			req, err := http.NewRequest(tc.method, gw.URL+tc.path, body)
			if err != nil {
				t.Fatal(err)
			}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200", resp.StatusCode)
			}
			if got := resp.Header.Get("X-Backend-Name"); got != tc.wantBackend {
				t.Errorf("response served by %q, want %q", got, tc.wantBackend)
			}
			if gb.byName(tc.wantBackend).count() != before+1 {
				t.Fatalf("backend %s did not record exactly one new request", tc.wantBackend)
			}
			rec := gb.byName(tc.wantBackend).last(t)
			if rec.method != tc.method {
				t.Errorf("method = %q, want %q", rec.method, tc.method)
			}
			if rec.path != tc.wantPath {
				t.Errorf("path = %q, want %q", rec.path, tc.wantPath)
			}
			if rec.rawPath != tc.wantRawPath {
				t.Errorf("raw path = %q, want %q", rec.rawPath, tc.wantRawPath)
			}
			if rec.query != tc.wantQuery {
				t.Errorf("query = %q, want %q", rec.query, tc.wantQuery)
			}
			if rec.body != tc.body {
				t.Errorf("body = %q, want %q", rec.body, tc.body)
			}
		})
	}

	t.Run("gateway healthz is local", func(t *testing.T) {
		resp, err := client.Get(gw.URL + "/healthz")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK || string(b) != "ok\n" {
			t.Fatalf("healthz = %d %q, want 200 ok", resp.StatusCode, b)
		}
		expected := map[string]int{
			"models": 4, "jira-mcp": 2, "jira-rest": 1, "git": 2,
			"vertex": 1, "registry": 3, "screenshots": 1, "glitchtip": 1,
			"executor": 2,
		}
		for _, be := range []*recordingBackend{gb.models, gb.jiraMCP, gb.jiraREST, gb.git, gb.vertex, gb.registry, gb.screenshots, gb.glitchtip, gb.executor} {
			if be.count() != expected[be.name] {
				t.Errorf("backend %s recorded %d requests, want %d", be.name, be.count(), expected[be.name])
			}
		}
	})
}

func TestHTTPGatewayRejects(t *testing.T) {
	gb := newGatewayBackends(t)
	handler := newTestGateway(t, gb.config())

	direct := func(method, target string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, target, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	for _, tc := range []struct {
		name   string
		method string
		target string
		status int
	}{
		{"unknown path", "GET", "/nope", 404},
		{"unknown top-level", "GET", "/ftp/pub/x", 404},
		{"bare models prefix", "GET", "/models", 404},
		{"v1 lookalike", "GET", "/v1x", 404},
		{"v2 lookalike", "GET", "/v2x", 404},
		{"mcp subpath not exposed", "POST", "/jira/mcp/messages", 404},
		{"bare jira", "GET", "/jira", 404},
		{"executor non-post", "GET", "/executor/execute", 405},
		{"executor non-post put", "PUT", "/executor/execute", 405},
		{"executor non-post delete", "DELETE", "/executor/execute", 405},
		{"bare executor", "GET", "/executor", 404},
		{"executor subpath", "POST", "/executor/execute/extra", 404},
		{"executor other subpath", "POST", "/executor/status", 404},
		{"executor trailing slash", "POST", "/executor/execute/", 404},
		{"dot segment traversal", "GET", "/models/../jira/rest/api/2/myself", 403},
		{"encoded dot traversal", "GET", "/git/github.com/%2e%2e/%2e%2e/v1/models", 403},
		{"double slash collapse", "GET", "/git//github.com/o/r.git/info/refs", 403},
		{"connect rejected", "CONNECT", "http://example.com:443", 405},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := direct(tc.method, tc.target)
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d", rec.Code, tc.status)
			}
		})
	}

	for _, be := range []*recordingBackend{gb.models, gb.jiraMCP, gb.jiraREST, gb.git, gb.vertex, gb.registry, gb.screenshots, gb.glitchtip, gb.executor} {
		if be.count() != 0 {
			t.Errorf("backend %s recorded a request; rejects must fail closed", be.name)
		}
	}
}

func TestHTTPGatewayDisabledTarget(t *testing.T) {
	git := &recordingBackend{name: "git"}
	gitSrv := httptest.NewServer(git)
	defer gitSrv.Close()

	handler := newTestGateway(t, GatewayConfig{Git: gitSrv.URL})
	do := func(method, target string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, target, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	if rec := do("GET", "/git/github.com/o/r.git/info/refs"); rec.Code != 200 {
		t.Errorf("enabled git route status = %d, want 200", rec.Code)
	}
	for _, tc := range []struct {
		name   string
		method string
		target string
		status int
	}{
		{"disabled models canonical", "GET", "/v1/models", 503},
		{"disabled models alias", "GET", "/models/v1/models", 503},
		{"disabled registry v2", "GET", "/v2/", 503},
		{"disabled jira mcp", "POST", "/jira/mcp", 503},
		{"disabled executor", "POST", "/executor/execute", 503},
		{"unknown still 404", "GET", "/unknown", 404},
	} {
		if rec := do(tc.method, tc.target); rec.Code != tc.status {
			t.Errorf("%s: status = %d, want %d", tc.name, rec.Code, tc.status)
		}
	}
	if git.count() != 1 {
		t.Errorf("git backend recorded %d requests, want 1", git.count())
	}
}

func TestHTTPGatewayHeaderIsolation(t *testing.T) {
	gb := newGatewayBackends(t)
	gw := httptest.NewServer(newTestGateway(t, gb.config()))
	defer gw.Close()

	request := func(path string, header func(http.Header)) (http.Header, *http.Response) {
		t.Helper()
		req, err := http.NewRequest("GET", gw.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		header(req.Header)
		resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return req.Header, resp
	}

	t.Run("git route", func(t *testing.T) {
		request("/git/github.com/o/r.git/info/refs?service=git-upload-pack", func(h http.Header) {
			// Route credentials and spoofable identity headers must be consumed.
			h.Set("Authorization", "Bearer ingress-oauth-token")
			h.Set("Cookie", "_oauth2_proxy=session-secret")
			h.Set("Proxy-Authorization", "Basic dXNlcjpwYXNz")
			h.Set("X-Forwarded-Access-Token", "Bearer ingress-oauth-token")
			h.Set("X-Forwarded-User", "spoofed")
			h.Set("X-Forwarded-Groups", "spoofed")
			h.Set("X-Forwarded-Email", "spoof@example.com")
			h.Set("X-Forwarded-Preferred-Username", "spoofed")
			h.Set("X-Forwarded-For", "1.2.3.4")
			h.Set("Forwarded", "for=1.2.3.4")
			h.Set("X-Auth-Request-Access-Token", "Bearer ingress-oauth-token")
			h.Set("X-Auth-Request-User", "spoofed")
			// Application headers must survive.
			h.Set("Git-Protocol", "version=2")
			h.Set("Accept", "*/*")
		})
		h := gb.git.last(t).header
		for _, name := range []string{
			"Authorization", "Cookie", "Proxy-Authorization",
			"X-Forwarded-Access-Token", "X-Forwarded-User", "X-Forwarded-Groups",
			"X-Forwarded-Email", "X-Forwarded-Preferred-Username",
			"X-Forwarded-For", "Forwarded",
			"X-Auth-Request-Access-Token", "X-Auth-Request-User",
		} {
			if got := h.Get(name); got != "" {
				t.Errorf("%s leaked to backend: %q", name, got)
			}
		}
		if got := h.Get("Git-Protocol"); got != "version=2" {
			t.Errorf("Git-Protocol = %q, want version=2", got)
		}
		if got := h.Get("Accept"); got != "*/*" {
			t.Errorf("Accept = %q, want */*", got)
		}
	})

	// The executor route's env-credential Authorization placeholder is
	// resolved upstream (OpenShell -> oauth-auth) and must be consumed by
	// the gateway before the internal executor wrapper.
	t.Run("executor route", func(t *testing.T) {
		req, err := http.NewRequest("POST", gw.URL+"/executor/execute",
			strings.NewReader(`{"tool":"gh","args":["--version"]}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer openshell-placeholder-token")
		req.Header.Set("Content-Type", "application/json")
		resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		rec := gb.executor.last(t)
		if rec.method != "POST" || rec.path != "/executor/execute" {
			t.Errorf("executor saw %s %q, want POST /executor/execute", rec.method, rec.path)
		}
		if rec.body != `{"tool":"gh","args":["--version"]}` {
			t.Errorf("executor body = %q", rec.body)
		}
		if got := rec.header.Get("Authorization"); got != "" {
			t.Errorf("Authorization placeholder leaked to executor backend: %q", got)
		}
		if got := rec.header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", got)
		}
	})
}

func TestHTTPGatewayEncodedPathFidelity(t *testing.T) {
	gb := newGatewayBackends(t)
	gw := httptest.NewServer(newTestGateway(t, gb.config()))
	defer gw.Close()

	client := &http.Client{Timeout: 10 * time.Second}
	cases := []struct {
		name        string
		path        string
		wantBackend string
		wantPath    string
		wantRawPath string
	}{
		{"encoded slash preserved", "/models/v1/embeddings%2Fx", "models", "/v1/embeddings/x", "/v1/embeddings%2Fx"},
		{"encoded prefix falls back", "/mod%65ls/v1/models", "models", "/v1/models", ""},
		{"git encoded slash", "/git/github.com/o%2Fr.git/info/refs", "git", "/github.com/o/r.git/info/refs", "/github.com/o%2Fr.git/info/refs"},
		{"registry canonical encoded slash", "/v2/red%2Fhat/manifests/latest", "registry", "/v2/red/hat/manifests/latest", "/v2/red%2Fhat/manifests/latest"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := client.Get(gw.URL + tc.path)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != 200 {
				t.Fatalf("status = %d", resp.StatusCode)
			}
			if got := resp.Header.Get("X-Backend-Name"); got != tc.wantBackend {
				t.Fatalf("served by %q, want %q", got, tc.wantBackend)
			}
			rec := gb.byName(tc.wantBackend).last(t)
			if rec.path != tc.wantPath {
				t.Errorf("path = %q, want %q", rec.path, tc.wantPath)
			}
			if rec.rawPath != tc.wantRawPath {
				t.Errorf("raw path = %q, want %q", rec.rawPath, tc.wantRawPath)
			}
		})
	}
}

func TestHTTPGatewayStreaming(t *testing.T) {
	writes := make(chan string, 8)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/cancel" {
			<-r.Context().Done()
			writes <- "canceled"
			return
		}
		flusher := w.(http.Flusher)
		for i := 1; i <= 3; i++ {
			fmt.Fprintf(w, "data: chunk-%d\n\n", i)
			flusher.Flush()
			writes <- fmt.Sprintf("wrote-%d", i)
			time.Sleep(120 * time.Millisecond)
		}
	}))
	defer backend.Close()

	gw := httptest.NewServer(newTestGateway(t, GatewayConfig{Vertex: backend.URL}))
	defer gw.Close()

	// Chunks must reach the client as they are flushed, not after the
	// response completes.
	t.Run("chunks flushed incrementally", func(t *testing.T) {
		resp, err := (&http.Client{Timeout: 10 * time.Second}).Get(gw.URL + "/vertex/stream")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		reader := bufio.NewReader(resp.Body)
		for i := 1; i <= 3; i++ {
			line, err := reader.ReadString('\n')
			if err != nil {
				t.Fatalf("read chunk %d: %v", i, err)
			}
			if want := fmt.Sprintf("data: chunk-%d", i); strings.TrimSpace(line) != want {
				t.Fatalf("chunk %d = %q, want %q", i, line, want)
			}
			wrote := <-writes
			if i < 3 && wrote != fmt.Sprintf("wrote-%d", i) {
				t.Fatalf("client got chunk %d only after backend event %q", i, wrote)
			}
			_, _ = reader.ReadString('\n') // trailing blank SSE line
		}
	})

	// Client disconnects must propagate to the backend.
	t.Run("cancellation propagates", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, "GET", gw.URL+"/vertex/cancel", nil)
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			resp, err := (&http.Client{}).Do(req)
			if err == nil {
				resp.Body.Close()
			}
		}()
		// Give the request time to reach the backend, then drop the client.
		time.Sleep(150 * time.Millisecond)
		cancel()
		select {
		case got := <-writes:
			if got != "canceled" {
				t.Fatalf("unexpected backend event %q", got)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("backend did not observe cancellation")
		}
	})
}

func TestHTTPGatewayLocationRewrite(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", r.URL.Query().Get("loc"))
		w.WriteHeader(http.StatusFound)
	}))
	defer backend.Close()

	gw := httptest.NewServer(newTestGateway(t, GatewayConfig{
		JiraMCP:  backend.URL,
		JiraREST: backend.URL,
		Git:      backend.URL,
		Registry: backend.URL,
	}))
	defer gw.Close()

	// Same-origin relative Locations are pulled back into the route prefix;
	// absolute and protocol-relative values pass through untouched.
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	cases := []struct {
		name        string
		requestPath string
		loc         string
		want        string
	}{
		{"jira rest relative keeps route prefix", "/jira/rest/api/2/redirect", "/rest/api/2/issue?token=x", "/jira/rest/api/2/issue?token=x"},
		{"git relative keeps route prefix", "/git/github.com/o/r.git/info/refs", "/github.com/o/new.git/info/refs", "/git/github.com/o/new.git/info/refs"},
		{"mcp exact maps back", "/jira/mcp", "/mcp", "/jira/mcp"},
		{"registry canonical identity", "/v2/rhel9/blobs/sha256:abc", "/v2/rhel9/blobs/sha256:def", "/v2/rhel9/blobs/sha256:def"},
		{"absolute untouched", "/v2/rhel9/blobs/sha256:abc", "https://cdn.example.com/blob/x", "https://cdn.example.com/blob/x"},
		{"protocol relative untouched", "/git/github.com/o/r.git/info/refs", "//evil.example/x", "//evil.example/x"},
		{"bare relative untouched", "/jira/rest/api/2/redirect", "next", "next"},
		{"other backend path stays inside route", "/jira/rest/api/2/redirect", "/login.jsp", "/jira/login.jsp"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := client.Get(gw.URL + tc.requestPath + "?loc=" + url.QueryEscape(tc.loc))
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusFound {
				t.Fatalf("status = %d, want 302", resp.StatusCode)
			}
			if got := resp.Header.Get("Location"); got != tc.want {
				t.Fatalf("Location = %q, want %q", got, tc.want)
			}
		})
	}
}
