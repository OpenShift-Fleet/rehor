package executor

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// newResponseTestGateway builds a gateway whose three pathname destinations
// all point at backendURL, for response-rewriting tests.
func newResponseTestGateway(t *testing.T, backendURL string) http.Handler {
	t.Helper()
	tokenDest := PathnameDestination{Upstream: backendURL, Token: "unit-secret-token"}
	return newTestGateway(t, GatewayConfig{
		JiraAPI:   PathnameDestination{Upstream: backendURL, Username: "bot@example.com", Token: "jira-secret-token"},
		GitHubAPI: tokenDest,
		GitLabAPI: tokenDest,
	})
}

// noRedirectClient returns a client that surfaces redirect responses instead
// of following them, so tests can inspect rewritten Location headers.
func noRedirectClient() *http.Client {
	return &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Timeout:       10 * time.Second,
	}
}

// TestUpstreamRewriteOriginMatching pins the same-origin rules for absolute
// and scheme-relative response URLs: the route's upstream scheme and
// host[:port] (with default-port normalization), never the userinfo, decide
// whether a URL names the same upstream.
func TestUpstreamRewriteOriginMatching(t *testing.T) {
	gh, err := url.Parse("https://api.github.com")
	if err != nil {
		t.Fatal(err)
	}
	gitlab, err := url.Parse("http://gitlab.corp.example:8080")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name    string
		rew     *upstreamRewrite
		raw     string
		want    bool
		wantErr bool // unparseable values fail closed
	}{
		{"github same origin", newUpstreamRewrite("/github", gh), "https://api.github.com/x", true, false},
		{"github default port normalized", newUpstreamRewrite("/github", gh), "https://api.github.com:443/x", true, false},
		{"github case insensitive host", newUpstreamRewrite("/github", gh), "https://API.GitHub.Com/x", true, false},
		{"github scheme mismatch", newUpstreamRewrite("/github", gh), "http://api.github.com/x", false, false},
		{"github port mismatch", newUpstreamRewrite("/github", gh), "https://api.github.com:8443/x", false, false},
		{"github foreign host", newUpstreamRewrite("/github", gh), "https://evil.example/x", false, false},
		{"github userinfo origin confusion", newUpstreamRewrite("/github", gh), "https://api.github.com@evil.example/x", false, false},
		{"github userinfo on upstream host", newUpstreamRewrite("/github", gh), "https://user@api.github.com/x", false, false},
		{"github scheme relative explicit port", newUpstreamRewrite("/github", gh), "//api.github.com:443/x", true, false},
		{"github scheme relative implicit https port", newUpstreamRewrite("/github", gh), "//api.github.com/x", true, false},
		{"github scheme relative foreign", newUpstreamRewrite("/github", gh), "//evil.example/x", false, false},
		{"gitlab explicit port matches", newUpstreamRewrite("/gitlab", gitlab), "http://gitlab.corp.example:8080/x", true, false},
		{"gitlab scheme relative explicit port", newUpstreamRewrite("/gitlab", gitlab), "//gitlab.corp.example:8080/x", true, false},
		{"gitlab missing port does not match nonstandard port", newUpstreamRewrite("/gitlab", gitlab), "//gitlab.corp.example/x", false, false},
		{"gitlab plain host without port", newUpstreamRewrite("/gitlab", gitlab), "http://gitlab.corp.example/x", false, false},
		{"unparseable fails closed", newUpstreamRewrite("/github", gh), "https://[::1", false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			u, err := url.Parse(tc.raw)
			if err != nil {
				if !tc.wantErr {
					t.Fatalf("unexpected parse error: %v", err)
				}
				return
			}
			if got := tc.rew.matches(u); got != tc.want {
				t.Fatalf("matches(%q) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}

// TestRewriteLocationValue pins the Location rewriting contract for the
// pathname destinations: same-upstream absolute and scheme-relative values
// become gateway-prefixed paths with the query and escaping preserved,
// relative-path values keep the existing prefix behavior (exactly one
// prefix), and everything else either passes through unchanged or fails
// closed as an unapproved origin.
func TestRewriteLocationValue(t *testing.T) {
	target, err := url.Parse("https://api.github.com")
	if err != nil {
		t.Fatal(err)
	}
	rw := newUpstreamRewrite("/github", target)
	cases := []struct {
		name    string
		loc     string
		want    string
		wantErr bool
	}{
		{"absolute same upstream with query", "https://api.github.com/repositories/42?page=2&per_page=100", "/github/repositories/42?page=2&per_page=100", false},
		{"absolute same upstream preserves escaping", "https://api.github.com/repos/o%2Fr/pulls?filter=a%2Bb", "/github/repos/o%2Fr/pulls?filter=a%2Bb", false},
		{"absolute same upstream with fragment", "https://api.github.com/x?a=1#frag", "/github/x?a=1#frag", false},
		{"absolute same upstream bare host", "https://api.github.com", "/github", false},
		{"scheme relative same upstream", "//api.github.com/repositories/42?page=2", "/github/repositories/42?page=2", false},
		{"relative path gets exactly one prefix", "/repos/o/r?page=2", "/github/repos/o/r?page=2", false},
		{"relative path without query", "/login.jsp", "/github/login.jsp", false},
		{"relative reference without slash untouched", "repos/o/r2", "repos/o/r2", false},
		{"query-only reference untouched", "?page=2", "?page=2", false},
		{"empty untouched", "", "", false},
		{"foreign absolute rejected", "https://evil.example/x", "", true},
		{"foreign scheme relative rejected", "//evil.example/x", "", true},
		{"userinfo rejected", "https://user@api.github.com/x", "", true},
		{"userinfo confusion rejected", "https://api.github.com@evil.example/x", "", true},
		{"foreign scheme rejected", "ftp://api.github.com/x", "", true},
		{"weird scheme-like relative rejected", "example.com:8080/x", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := rw.rewriteLocationValue(tc.loc)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("rewriteLocationValue(%q) = %q, want error", tc.loc, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("rewriteLocationValue(%q): %v", tc.loc, err)
			}
			if got != tc.want {
				t.Fatalf("rewriteLocationValue(%q) = %q, want %q", tc.loc, got, tc.want)
			}
		})
	}
}

// TestRewriteLinkHeader pins the Link pagination rewriting: every
// <uri-reference> element is rewritten with the same rules as Location,
// element parameters (including quoted strings containing commas) are
// preserved verbatim, and a foreign-origin element rejects the whole value.
func TestRewriteLinkHeader(t *testing.T) {
	target, err := url.Parse("https://api.github.com")
	if err != nil {
		t.Fatal(err)
	}
	rw := newUpstreamRewrite("/github", target)
	cases := []struct {
		name    string
		value   string
		want    string
		wantErr bool
	}{
		{
			"next prev last with quoted comma",
			`<https://api.github.com/repositories/42?page=2>; rel="next", <https://api.github.com/repositories/42?page=1>; rel="prev", <https://api.github.com/repositories/42?page=5>; rel="last"; title="Page 1, of 5"`,
			`</github/repositories/42?page=2>; rel="next", </github/repositories/42?page=1>; rel="prev", </github/repositories/42?page=5>; rel="last"; title="Page 1, of 5"`,
			false,
		},
		{
			"absolute same upstream element",
			`<https://api.github.com/repos/o%2Fr?filter=a%2Bb>; rel="next"`,
			`</github/repos/o%2Fr?filter=a%2Bb>; rel="next"`,
			false,
		},
		{
			"relative path element",
			` </repos/o/r?page=2>; rel="next"`,
			`</github/repos/o/r?page=2>; rel="next"`,
			false,
		},
		{
			"relative reference without slash element untouched",
			`<repos/o/r2>; rel="next"`,
			`<repos/o/r2>; rel="next"`,
			false,
		},
		{
			"multiple elements mixed forms",
			`<https://api.github.com/a?x=1>; rel="next", <b/c>; rel="related", <https://api.github.com/d>; rel="last"`,
			`</github/a?x=1>; rel="next", <b/c>; rel="related", </github/d>; rel="last"`,
			false,
		},
		{
			"element without uri untouched",
			`not a link element`,
			`not a link element`,
			false,
		},
		{
			"foreign absolute element rejected",
			`<https://api.github.com/x>; rel="next", <https://evil.example/y>; rel="last"`,
			"",
			true,
		},
		{
			"foreign scheme relative element rejected",
			`<//evil.example/x>; rel="next"`,
			"",
			true,
		},
		{
			"userinfo element rejected",
			`<https://user@api.github.com/x>; rel="next"`,
			"",
			true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := rw.rewriteLinkHeader(tc.value)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("rewriteLinkHeader(%q) = %q, want error", tc.value, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("rewriteLinkHeader(%q): %v", tc.value, err)
			}
			if got != tc.want {
				t.Fatalf("rewriteLinkHeader(%q) =\n %q\nwant\n %q", tc.value, got, tc.want)
			}
		})
	}
}

// TestUpstreamRewriteResponse pins the response-level application: multiple
// Location and Link header values are rewritten in place, and a foreign
// origin in any of them fails the whole response.
func TestUpstreamRewriteResponse(t *testing.T) {
	target, err := url.Parse("https://api.github.com")
	if err != nil {
		t.Fatal(err)
	}
	rw := newUpstreamRewrite("/github", target)

	resp := &http.Response{Header: http.Header{}}
	resp.Header.Add("Location", "https://api.github.com/a?x=1")
	resp.Header.Add("Location", "/b?y=2")
	resp.Header.Add("Link", `<https://api.github.com/c?x=3>; rel="next"`)
	resp.Header.Add("Link", `</d>; rel="prev"`)
	if err := rw.rewriteResponse(resp); err != nil {
		t.Fatalf("rewriteResponse: %v", err)
	}
	if got := resp.Header.Values("Location"); len(got) != 2 || got[0] != "/github/a?x=1" || got[1] != "/github/b?y=2" {
		t.Fatalf("Location values = %q, want rewritten pair", got)
	}
	if got := resp.Header.Values("Link"); len(got) != 2 || got[0] != `</github/c?x=3>; rel="next"` || got[1] != `</github/d>; rel="prev"` {
		t.Fatalf("Link values = %q, want rewritten pair", got)
	}

	bad := &http.Response{Header: http.Header{}}
	bad.Header.Add("Link", `<https://api.github.com/c>; rel="next"`)
	bad.Header.Add("Link", `<https://evil.example/x>; rel="last"`)
	if err := rw.rewriteResponse(bad); err == nil {
		t.Fatal("rewriteResponse must reject a foreign-origin Link element")
	}
}

// TestPathnameDestinationLinkPagination verifies end to end, against the
// real gateway, that same-upstream absolute Link pagination URLs come back
// as gateway-prefixed paths (rel next/prev/last, quoted parameters, byte
// preserved queries) so SDK clients keep paginating through the proxy
// instead of following the upstream origin directly.
func TestPathnameDestinationLinkPagination(t *testing.T) {
	var backend *httptest.Server
	backend = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Link", strings.Join([]string{
			`<` + backend.URL + `/repositories/42?page=2&per_page=100>; rel="next"`,
			`<` + backend.URL + `/repositories/42?page=1&per_page=100>; rel="prev"`,
			`<` + backend.URL + `/repositories/42?page=5&per_page=100>; rel="last"; title="Page 1, of 5"`,
		}, ", "))
		w.Header().Add("Link", `</api/v4/relative?page=9>; rel="first"`)
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	handler := newResponseTestGateway(t, backend.URL)
	gw := httptest.NewServer(handler)
	defer gw.Close()

	client := noRedirectClient()
	for _, tc := range []struct {
		name string
		path string
		pfx  string
	}{
		{"github", "/github/repositories/42?page=1&per_page=100", "/github"},
		{"gitlab", "/gitlab/api/v4/projects?page=1", "/gitlab"},
		{"jira", "/jira/api/2/search?startAt=0", "/jira"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := client.Get(gw.URL + tc.path)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200", resp.StatusCode)
			}
			wantMain := strings.Join([]string{
				`<` + tc.pfx + `/repositories/42?page=2&per_page=100>; rel="next"`,
				`<` + tc.pfx + `/repositories/42?page=1&per_page=100>; rel="prev"`,
				`<` + tc.pfx + `/repositories/42?page=5&per_page=100>; rel="last"; title="Page 1, of 5"`,
			}, ", ")
			links := resp.Header.Values("Link")
			if len(links) != 2 {
				t.Fatalf("Link header values = %d, want 2 (%q)", len(links), links)
			}
			if links[0] != wantMain {
				t.Fatalf("Link[0] =\n %q\nwant\n %q", links[0], wantMain)
			}
			wantFirst := `</` + strings.TrimPrefix(tc.pfx, "/") + `/api/v4/relative?page=9>; rel="first"`
			if links[1] != wantFirst {
				t.Fatalf("Link[1] = %q, want %q", links[1], wantFirst)
			}
		})
	}
}

// TestPathnameDestinationRedirectRewrite verifies end to end that redirect
// Location headers on the pathname destinations come back as
// gateway-prefixed paths for every form clients must follow through the
// proxy: absolute same-upstream URLs (301/302/307), scheme-relative
// same-upstream references, and the pre-existing relative-path behavior.
func TestPathnameDestinationRedirectRewrite(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		code := http.StatusFound
		switch r.URL.Query().Get("code") {
		case "301":
			code = http.StatusMovedPermanently
		case "307":
			code = http.StatusTemporaryRedirect
		}
		w.Header().Set("Location", r.URL.Query().Get("loc"))
		w.WriteHeader(code)
	}))
	defer backend.Close()

	handler := newResponseTestGateway(t, backend.URL)
	gw := httptest.NewServer(handler)
	defer gw.Close()

	host := strings.TrimPrefix(backend.URL, "http://")
	client := noRedirectClient()
	cases := []struct {
		name       string
		requestDir string
		code       string
		loc        string
		wantStatus int
		want       string
	}{
		{"github 301 absolute same upstream", "/github", "301", backend.URL + "/repositories/43?page=2", http.StatusMovedPermanently, "/github/repositories/43?page=2"},
		{"github 307 absolute same upstream", "/github", "307", backend.URL + "/repositories/43?page=2", http.StatusTemporaryRedirect, "/github/repositories/43?page=2"},
		{"github 302 absolute preserves escaping", "/github", "302", backend.URL + "/repos/o%2Fr/pulls?filter=a%2Bb", http.StatusFound, "/github/repos/o%2Fr/pulls?filter=a%2Bb"},
		{"gitlab scheme relative same upstream", "/gitlab", "302", "//" + host + "/api/v4/projects?page=2", http.StatusFound, "/gitlab/api/v4/projects?page=2"},
		{"jira absolute same upstream", "/jira", "302", backend.URL + "/browse/PROJ-1", http.StatusFound, "/jira/browse/PROJ-1"},
		{"github relative keeps prefix", "/github", "302", "/repos/o/r2", http.StatusFound, "/github/repos/o/r2"},
		{"gitlab relative without slash untouched", "/gitlab", "302", "projects/9", http.StatusFound, "projects/9"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := client.Get(gw.URL + tc.requestDir + "/x?code=" + tc.code + "&loc=" + url.QueryEscape(tc.loc))
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.wantStatus)
			}
			if got := resp.Header.Get("Location"); got != tc.want {
				t.Fatalf("Location = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestPathnameDestinationRejectsForeignOrigins verifies that a Location or
// Link URL on an origin other than the route's upstream never reaches the
// client as a proxy-authenticated target: the response fails closed with a
// clear fixed 502 and neither the offending URL nor any injected credential
// appears in the response. The upstream request itself still happened (the
// rejection is response-side), so each case also proves the first hop ran.
func TestPathnameDestinationRejectsForeignOrigins(t *testing.T) {
	hits := 0
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if strings.HasSuffix(r.URL.Path, "/link") {
			w.Header().Set("Link", `<https://api.example.invalid/x>; rel="next"`)
			w.WriteHeader(http.StatusOK)
			return
		}
		w.Header().Set("Location", r.URL.Query().Get("loc"))
		w.WriteHeader(http.StatusFound)
	}))
	defer backend.Close()

	handler := newResponseTestGateway(t, backend.URL)
	gw := httptest.NewServer(handler)
	defer gw.Close()

	host := strings.TrimPrefix(backend.URL, "http://")
	client := noRedirectClient()
	cases := []struct {
		name string
		path string
		loc  string
	}{
		{"github foreign absolute location", "/github/x?loc=" + url.QueryEscape("https://evil.example/x"), ""},
		{"gitlab foreign scheme relative location", "/gitlab/x?loc=" + url.QueryEscape("//evil.example/x"), ""},
		{"jira foreign absolute location", "/jira/x?loc=" + url.QueryEscape("https://objects.example.com/x"), ""},
		{"github userinfo location", "/github/x?loc=" + url.QueryEscape("https://user@"+host+"/x"), ""},
		{"github userinfo confusion location", "/github/x?loc=" + url.QueryEscape("https://"+host+"@evil.example/x"), ""},
		{"gitlab foreign link element", "/gitlab/link", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := hits
			resp, err := client.Get(gw.URL + tc.path)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			if resp.StatusCode != http.StatusBadGateway {
				t.Fatalf("status = %d, want 502", resp.StatusCode)
			}
			if !strings.Contains(string(body), "unapproved origin") {
				t.Fatalf("body %q must explain the unapproved-origin rejection", string(body))
			}
			if strings.Contains(string(body), "evil.example") || strings.Contains(string(body), "example.com") {
				t.Fatalf("body %q echoes the rejected URL", string(body))
			}
			if strings.Contains(string(body), "secret-token") {
				t.Fatalf("body %q leaks a credential", string(body))
			}
			if hits != before+1 {
				t.Fatalf("backend hits = %d, want %d (first hop must have run)", hits, before+1)
			}
		})
	}
}
