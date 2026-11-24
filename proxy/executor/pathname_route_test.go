package executor

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// pathnameBackends holds recording backends for the two pre-existing fixed
// Jira routes (which must keep their traffic) and the three direct pathname
// destinations.
type pathnameBackends struct {
	jiraMCP, jiraREST *recordingBackend
	jira, github      *recordingBackend
	gitlab            *recordingBackend
}

// newPathnameGateway builds the coexistence configuration: the fixed
// /jira/mcp and /jira/rest routes keep their loopback backends and the
// /jira, /github, /gitlab destinations point at their own.
func newPathnameGateway(t *testing.T) (http.Handler, *pathnameBackends) {
	t.Helper()
	pb := &pathnameBackends{}
	newBackend := func(name string) (*recordingBackend, string) {
		b := &recordingBackend{name: name}
		srv := httptest.NewServer(b)
		t.Cleanup(srv.Close)
		return b, srv.URL
	}
	var jiraMCPURL, jiraRESTURL, jiraURL, githubURL, gitlabURL string
	pb.jiraMCP, jiraMCPURL = newBackend("jira-mcp")
	pb.jiraREST, jiraRESTURL = newBackend("jira-rest")
	pb.jira, jiraURL = newBackend("jira-api")
	pb.github, githubURL = newBackend("github-api")
	pb.gitlab, gitlabURL = newBackend("gitlab-api")

	cfg := GatewayConfig{
		JiraMCP:  jiraMCPURL,
		JiraREST: jiraRESTURL,
		JiraAPI: PathnameDestination{
			Upstream: jiraURL,
			Username: "bot@example.com",
			Token:    "jira-secret-token",
		},
		GitHubAPI: PathnameDestination{
			Upstream: githubURL,
			Token:    "gh-secret-token",
		},
		GitLabAPI: PathnameDestination{
			Upstream: gitlabURL,
			Token:    "gl-secret-token",
		},
	}
	return newTestGateway(t, cfg), pb
}

// TestPathnameDestinationRouting verifies the pathname destinations
// forward the prefix-stripped remainder to their upstreams and that the
// pre-existing /jira/mcp and /jira/rest fixed routes keep claiming their
// paths unchanged (coexistence: nothing existing is re-pointed).
func TestPathnameDestinationRouting(t *testing.T) {
	handler, pb := newPathnameGateway(t)
	gw := httptest.NewServer(handler)
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
		{"jira mcp exact keeps fixed route", "POST", "/jira/mcp", "{}", "jira-mcp", "/mcp", "", ""},
		{"jira rest keeps fixed route", "GET", "/jira/rest/api/2/myself?fields=summary", "", "jira-rest", "/rest/api/2/myself", "", "fields=summary"},
		{"jira direct path", "GET", "/jira/secure/useravatar", "", "jira-api", "/secure/useravatar", "", ""},
		{"jira rest-adjacent path is direct", "GET", "/jira/restx/extra", "", "jira-api", "/restx/extra", "", ""},
		{"jira mcp-adjacent path is direct", "GET", "/jira/mcpx/extra", "", "jira-api", "/mcpx/extra", "", ""},
		{"jira prefix trailing slash only", "GET", "/jira/", "", "jira-api", "/", "", ""},
		{"github repos with query", "GET", "/github/repos/o/r/pulls?state=open", "", "github-api", "/repos/o/r/pulls", "", "state=open"},
		{"github graphql post", "POST", "/github/graphql", `{"query":"{}"}`, "github-api", "/graphql", "", ""},
		{"gitlab projects", "GET", "/gitlab/api/v4/projects?membership=true", "", "gitlab-api", "/api/v4/projects", "", "membership=true"},
		{"gitlab post", "POST", "/gitlab/api/v4/projects/1/variables", `{"key":"k"}`, "gitlab-api", "/api/v4/projects/1/variables", "", ""},
		{"github encoded slash preserved", "GET", "/github/repos/o%2Fr/pulls", "", "github-api", "/repos/o/r/pulls", "/repos/o%2Fr/pulls", ""},
		{"gitlab encoded prefix falls back", "GET", "/git%6cab/api/v4/projects", "", "gitlab-api", "/api/v4/projects", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var backend *recordingBackend
			switch tc.wantBackend {
			case "jira-mcp":
				backend = pb.jiraMCP
			case "jira-rest":
				backend = pb.jiraREST
			case "jira-api":
				backend = pb.jira
			case "github-api":
				backend = pb.github
			case "gitlab-api":
				backend = pb.gitlab
			}
			before := backend.count()
			var body *strings.Reader
			if tc.body != "" {
				body = strings.NewReader(tc.body)
			} else {
				body = strings.NewReader("")
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
			if backend.count() != before+1 {
				t.Fatalf("backend %s did not record exactly one new request", tc.wantBackend)
			}
			rec := backend.last(t)
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
}

// TestPathnameDestinationRejects verifies the fail-closed boundaries:
// bare prefixes, the excluded /jira/mcp and /jira/rest subtrees, unknown
// destination prefixes, lookalikes, traversal, and CONNECT. No backend may
// see a request.
func TestPathnameDestinationRejects(t *testing.T) {
	handler, pb := newPathnameGateway(t)

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
		{"bare jira", "GET", "/jira", 404},
		{"bare github", "GET", "/github", 404},
		{"bare gitlab", "GET", "/gitlab", 404},
		{"mcp subpath still 404", "POST", "/jira/mcp/messages", 404},
		{"bare jira rest still 404", "GET", "/jira/rest", 404},
		{"unknown destination prefix", "GET", "/bitbucket/api/v4/projects", 404},
		{"github lookalike", "GET", "/githubx/repos", 404},
		{"jira lookalike", "GET", "/jirax/secure", 404},
		{"prefix is case sensitive", "GET", "/GitHub/repos", 404},
		{"dot segment traversal", "GET", "/github/../jira/secure/x", 403},
		{"connect rejected", "CONNECT", "http://example.com:443", 405},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := direct(tc.method, tc.target)
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d", rec.Code, tc.status)
			}
		})
	}

	for _, be := range []*recordingBackend{pb.jiraMCP, pb.jiraREST, pb.jira, pb.github, pb.gitlab} {
		if be.count() != 0 {
			t.Errorf("backend %s recorded a request; rejects must fail closed", be.name)
		}
	}
}

// TestJiraPathnameMatch pins the exact exclusion boundary of the /jira
// destination: everything under /jira/ except the /jira/mcp and /jira/rest
// subtrees.
func TestJiraPathnameMatch(t *testing.T) {
	cases := []struct {
		path    string
		wantOk  bool
		wantRet string
	}{
		{"/jira/secure/x", true, "/secure/x"},
		{"/jira/", true, "/"},
		{"/jira", false, ""},
		{"/jira/mcp", false, ""},
		{"/jira/mcp/", false, ""},
		{"/jira/mcp/messages", false, ""},
		{"/jira/rest", false, ""},
		{"/jira/rest/api/2/x", false, ""},
		{"/jira/restx", true, "/restx"},
		{"/jira/mcpx", true, "/mcpx"},
		{"/jirax/y", false, ""},
		{"/github/x", false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			u := &url.URL{Path: tc.path}
			rest, _, ok := jiraPathnameMatch(u)
			if ok != tc.wantOk {
				t.Fatalf("jiraPathnameMatch(%q) ok = %v, want %v", tc.path, ok, tc.wantOk)
			}
			if ok && rest != tc.wantRet {
				t.Fatalf("jiraPathnameMatch(%q) rest = %q, want %q", tc.path, rest, tc.wantRet)
			}
		})
	}
}

// TestPathnameDestinationCredentials verifies each destination injects its
// own credential on the upstream leg and that every client-supplied
// credential or identity header is stripped first.
func TestPathnameDestinationCredentials(t *testing.T) {
	handler, pb := newPathnameGateway(t)
	gw := httptest.NewServer(handler)
	defer gw.Close()

	wantBasic := "Basic " + base64.StdEncoding.EncodeToString([]byte("bot@example.com:jira-secret-token"))

	send := func(path string) {
		t.Helper()
		req, err := http.NewRequest("GET", gw.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		// Everything a client must never be able to smuggle upstream.
		req.Header.Set("Authorization", "Bearer client-oauth-token")
		req.Header.Set("Private-Token", "client-gitlab-token")
		req.Header.Set("Cookie", "_oauth2_proxy=session-secret")
		req.Header.Set("Proxy-Authorization", "Basic dXNlcjpwYXNz")
		req.Header.Set("X-Forwarded-User", "spoofed")
		req.Header.Set("X-Forwarded-Access-Token", "Bearer client-oauth-token")
		req.Header.Set("X-Auth-Request-User", "spoofed")
		// Application headers must survive.
		req.Header.Set("Accept", "application/json")
		resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200", path, resp.StatusCode)
		}
	}

	t.Run("jira injects basic auth", func(t *testing.T) {
		send("/jira/secure/useravatar")
		h := pb.jira.last(t).header
		if got := h.Get("Authorization"); got != wantBasic {
			t.Errorf("Authorization = %q, want injected %q", got, wantBasic)
		}
	})
	t.Run("github injects bearer", func(t *testing.T) {
		send("/github/repos/o/r")
		h := pb.github.last(t).header
		if got := h.Get("Authorization"); got != "Bearer gh-secret-token" {
			t.Errorf("Authorization = %q, want injected bearer", got)
		}
	})
	t.Run("gitlab injects private token", func(t *testing.T) {
		send("/gitlab/api/v4/projects")
		h := pb.gitlab.last(t).header
		if got := h.Get("Private-Token"); got != "gl-secret-token" {
			t.Errorf("Private-Token = %q, want injected token", got)
		}
		if got := h.Get("Authorization"); got != "" {
			t.Errorf("Authorization leaked to gitlab upstream: %q", got)
		}
	})

	// The same hostile header set on every destination: nothing but the
	// injected credential and the application headers may arrive.
	injected := map[string]map[string]string{
		"jira":   {"Authorization": wantBasic},
		"github": {"Authorization": "Bearer gh-secret-token"},
		"gitlab": {"Private-Token": "gl-secret-token"},
	}
	for _, tc := range []struct {
		name string
		path string
		be   *recordingBackend
	}{
		{"jira", "/jira/secure/x", pb.jira},
		{"github", "/github/repos/o/r", pb.github},
		{"gitlab", "/gitlab/api/v4/projects", pb.gitlab},
	} {
		t.Run(tc.name+" strips client credentials", func(t *testing.T) {
			send(tc.path)
			h := tc.be.last(t).header
			for _, name := range []string{
				"Authorization", "Private-Token", "Cookie",
				"Proxy-Authorization", "X-Forwarded-User",
				"X-Forwarded-Access-Token", "X-Auth-Request-User",
			} {
				got := h.Get(name)
				if want, ok := injected[tc.name][name]; ok {
					if got != want {
						t.Errorf("%s = %q, want injected credential", name, got)
					}
					continue
				}
				if got != "" {
					t.Errorf("%s leaked to %s upstream: %q", name, tc.name, got)
				}
			}
			if got := h.Get("Accept"); got != "application/json" {
				t.Errorf("Accept = %q, want application/json", got)
			}
		})
	}
}

// TestPathnameDestinationFailClosed verifies that an absent credential or
// upstream fails closed with a clear, fixed error (naming the environment
// variable) and that no request ever reaches the upstream. The error must
// never echo configuration values.
func TestPathnameDestinationFailClosed(t *testing.T) {
	newBackend := func(name string) (*recordingBackend, string) {
		b := &recordingBackend{name: name}
		srv := httptest.NewServer(b)
		t.Cleanup(srv.Close)
		return b, srv.URL
	}
	_, jiraURL := newBackend("jira-api")
	_, githubURL := newBackend("github-api")
	_, gitlabURL := newBackend("gitlab-api")

	full := func() GatewayConfig {
		return GatewayConfig{
			JiraAPI:   PathnameDestination{Upstream: jiraURL, Username: "bot@example.com", Token: "jira-secret-token"},
			GitHubAPI: PathnameDestination{Upstream: githubURL, Token: "gh-secret-token"},
			GitLabAPI: PathnameDestination{Upstream: gitlabURL, Token: "gl-secret-token"},
		}
	}

	cases := []struct {
		name       string
		mutate     func(*GatewayConfig)
		target     string
		wantStatus int
		wantBody   string
	}{
		{
			"github token missing",
			func(c *GatewayConfig) { c.GitHubAPI.Token = "" },
			"/github/repos/o/r", http.StatusServiceUnavailable, "GH_TOKEN",
		},
		{
			"jira username missing",
			func(c *GatewayConfig) { c.JiraAPI.Username = "" },
			"/jira/secure/x", http.StatusServiceUnavailable, "JIRA_USERNAME",
		},
		{
			"jira token missing",
			func(c *GatewayConfig) { c.JiraAPI.Token = "" },
			"/jira/secure/x", http.StatusServiceUnavailable, "JIRA_API_TOKEN",
		},
		{
			"gitlab token missing",
			func(c *GatewayConfig) { c.GitLabAPI.Token = "" },
			"/gitlab/api/v4/projects", http.StatusServiceUnavailable, "GITLAB_TOKEN",
		},
		{
			"github upstream unconfigured",
			func(c *GatewayConfig) { c.GitHubAPI.Upstream = "" },
			"/github/repos/o/r", http.StatusServiceUnavailable, "upstream not configured",
		},
		{
			"unknown prefix is 404 not fallback",
			func(c *GatewayConfig) {},
			"/bitbucket/api/v4/projects", http.StatusNotFound, "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := full()
			tc.mutate(&cfg)
			handler := newTestGateway(t, cfg)
			req := httptest.NewRequest("GET", tc.target, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %q)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantBody != "" && !strings.Contains(rec.Body.String(), tc.wantBody) {
				t.Fatalf("body %q must mention %q", rec.Body.String(), tc.wantBody)
			}
			if strings.Contains(rec.Body.String(), "secret-token") {
				t.Fatalf("error body echoes configuration values: %q", rec.Body.String())
			}
		})
	}
}

// TestPathnameDestinationConfigValidation verifies destination upstream
// URLs are validated exactly like loopback backends: bad values fail the
// build naming the field and reason, and never echo the raw URL.
func TestPathnameDestinationConfigValidation(t *testing.T) {
	bad := []struct {
		name       string
		dest       PathnameDestination
		wantReason string
	}{
		{"missing scheme", PathnameDestination{Upstream: "api.github.com", Token: "t"}, "http or https"},
		{"bad scheme", PathnameDestination{Upstream: "ftp://api.github.com", Token: "t"}, "http or https"},
		{"unparseable", PathnameDestination{Upstream: "https://[::1", Token: "t"}, "parseable"},
		{"no host", PathnameDestination{Upstream: "https://", Token: "t"}, "no host"},
		{"credentials in url", PathnameDestination{Upstream: "https://user:secretpw@jira.example.com", Token: "t"}, "credentials"},
		{"path in url", PathnameDestination{Upstream: "https://gitlab.example.com/subpath", Token: "t"}, "path"},
		{"query in url", PathnameDestination{Upstream: "https://api.github.com?q=MARKERQ", Token: "t"}, "query or fragment"},
	}
	for _, tc := range bad {
		for _, field := range []struct {
			name string
			set  func(c *GatewayConfig, d PathnameDestination)
		}{
			{"jira-api", func(c *GatewayConfig, d PathnameDestination) { c.JiraAPI = d }},
			{"github-api", func(c *GatewayConfig, d PathnameDestination) { c.GitHubAPI = d }},
			{"gitlab-api", func(c *GatewayConfig, d PathnameDestination) { c.GitLabAPI = d }},
		} {
			t.Run(tc.name+"/"+field.name, func(t *testing.T) {
				cfg := GatewayConfig{}
				field.set(&cfg, tc.dest)
				_, err := NewHTTPGateway(cfg)
				if err == nil {
					t.Fatalf("%s: expected error, got nil", tc.name)
				}
				if !strings.Contains(err.Error(), field.name) {
					t.Errorf("error %q does not name the destination %q", err, field.name)
				}
				if !strings.Contains(err.Error(), tc.wantReason) {
					t.Errorf("error %q does not mention %q", err, tc.wantReason)
				}
				if strings.Contains(err.Error(), "secretpw") || strings.Contains(err.Error(), "MARKER") {
					t.Errorf("error message echoes raw URL: %s", err)
				}
			})
		}
	}

	// A configuration with only direct destinations is a valid gateway.
	if _, err := NewHTTPGateway(GatewayConfig{
		GitHubAPI: PathnameDestination{Upstream: "http://127.0.0.1:8450", Token: "t"},
	}); err != nil {
		t.Errorf("destinations-only config must build: %v", err)
	}

	// An invalid GitLab CA bundle must not break the route: the transport
	// falls back to the system pool and requests still flow.
	t.Setenv("GITLAB_CA_CERT_PEM", "not a pem certificate")
	backend := httptest.NewServer(&recordingBackend{name: "gitlab-api"})
	defer backend.Close()
	handler := newTestGateway(t, GatewayConfig{
		GitLabAPI: PathnameDestination{Upstream: backend.URL, Token: "gl-secret-token"},
	})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest("GET", "/gitlab/api/v4/projects", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d with invalid CA config, want 200", rec.Code)
	}
}

// TestPathnameDestinationResponseHygiene verifies relative Location headers
// keep their prefix behavior, same-upstream absolute and scheme-relative
// Locations come back as gateway paths, foreign-origin Locations fail
// closed with a clear error, and credential-bearing response headers (the
// upstream's service-session cookies and auth challenges) never reach the
// client.
func TestPathnameDestinationResponseHygiene(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", r.URL.Query().Get("loc"))
		w.Header().Set("Set-Cookie", "JSESSIONID=service-session; Path=/")
		w.Header().Set("Set-Cookie2", "SESSION2=service-session; Path=/")
		w.Header().Set("WWW-Authenticate", `Basic realm="upstream"`)
		w.Header().Set("Proxy-Authenticate", `Basic realm="upstream-proxy"`)
		w.WriteHeader(http.StatusFound)
	}))
	defer backend.Close()

	jiraDest := PathnameDestination{Upstream: backend.URL, Username: "bot@example.com", Token: "secret-token"}
	tokenDest := PathnameDestination{Upstream: backend.URL, Token: "secret-token"}
	handler := newTestGateway(t, GatewayConfig{
		JiraAPI:   jiraDest,
		GitHubAPI: tokenDest,
		GitLabAPI: tokenDest,
	})
	gw := httptest.NewServer(handler)
	defer gw.Close()

	host := strings.TrimPrefix(backend.URL, "http://")
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	cases := []struct {
		name        string
		requestPath string
		loc         string
		wantStatus  int
		want        string
	}{
		{"jira relative keeps prefix", "/jira/secure/redirect", "/login.jsp", http.StatusFound, "/jira/login.jsp"},
		{"github relative keeps prefix", "/github/repos/o/r", "/repos/o/r2", http.StatusFound, "/github/repos/o/r2"},
		{"gitlab relative keeps prefix", "/gitlab/api/v4/x", "/api/v4/y", http.StatusFound, "/gitlab/api/v4/y"},
		{"github absolute same upstream", "/github/repos/o/r", backend.URL + "/repos/o/r3?ref=x", http.StatusFound, "/github/repos/o/r3?ref=x"},
		{"gitlab scheme relative same upstream", "/gitlab/api/v4/x", "//" + host + "/api/v4/z?paged=1", http.StatusFound, "/gitlab/api/v4/z?paged=1"},
		{"jira absolute same upstream", "/jira/secure/redirect", backend.URL + "/browse/X-1", http.StatusFound, "/jira/browse/X-1"},
		{"foreign absolute rejected", "/github/repos/o/r", "https://objects.githubusercontent.com/x", http.StatusBadGateway, ""},
		{"foreign scheme relative rejected", "/gitlab/api/v4/x", "//evil.example/x", http.StatusBadGateway, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := client.Get(gw.URL + tc.requestPath + "?loc=" + url.QueryEscape(tc.loc))
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.wantStatus)
			}
			if tc.want != "" {
				if got := resp.Header.Get("Location"); got != tc.want {
					t.Fatalf("Location = %q, want %q", got, tc.want)
				}
			} else {
				body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
				if !strings.Contains(string(body), "unapproved origin") {
					t.Fatalf("body %q must explain the unapproved-origin rejection", string(body))
				}
				if strings.Contains(string(body), "evil.example") || strings.Contains(string(body), "githubusercontent") {
					t.Fatalf("body %q echoes the rejected URL", string(body))
				}
			}
			if got := resp.Header.Get("Set-Cookie"); got != "" {
				t.Errorf("upstream session cookie reached the client: %q", got)
			}
			if got := resp.Header.Get("Set-Cookie2"); got != "" {
				t.Errorf("upstream Set-Cookie2 reached the client: %q", got)
			}
			if got := resp.Header.Get("WWW-Authenticate"); got != "" {
				t.Errorf("upstream auth challenge reached the client: %q", got)
			}
			if got := resp.Header.Get("Proxy-Authenticate"); got != "" {
				t.Errorf("upstream proxy auth challenge reached the client: %q", got)
			}
		})
	}
}
