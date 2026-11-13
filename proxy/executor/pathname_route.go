package executor

// Pathname-routed authenticated destinations on the HTTP gateway
// (REHOR-263).
//
// The destinations below form the single pathname-routed route family for
// preflight and other gateway clients: one authenticated surface (the
// existing HTTP gateway behind the oauth-services Route, which owns all
// identity checks) where the destination system is selected by the first
// path segment:
//
//	/jira/<rest>    -> Jira REST upstream  <rest>  (Basic auth from the
//	                                                   same JIRA_* credential
//	                                                   as the :8445 listener)
//	/github/<rest>  -> GitHub API upstream <rest>  (Authorization: Bearer)
//	/gitlab/<rest>  -> GitLab API upstream <rest>  (PRIVATE-TOKEN)
//
// The destination prefix is stripped and the remainder is forwarded
// unchanged to the configured upstream — the same alias semantics the
// gateway already uses for /models and /registry. Clients compose
// <gateway base URL>/<destination>/<upstream API path> and never see a
// credential: the proxy is the only credential source on the upstream leg.
// Every client-supplied credential header is dropped before injection —
// the shared gateway strip removes Authorization, Proxy-Authorization,
// Cookie, and the oauth-proxy identity header families, and the
// destination injectors drop any client PRIVATE-TOKEN.
//
// The /jira destination never shadows the pre-existing fixed routes: the
// /jira/mcp and /jira/rest subtrees keep claiming their paths (and their
// 404s) exactly as before, both by route-table order and by the explicit
// exclusion in jiraPathnameMatch. The port-per-service listeners are
// equally untouched and stay active; this family only ADDS routes (their
// removal is REHOR-232, after fleet migration completes).
//
// Response URL rewriting (REHOR-652 review fix): same-upstream absolute
// Link pagination URLs and Location redirects — the forms SDK clients
// follow verbatim, which would otherwise bypass the proxy and drop the
// injected credential — are rewritten into the destination's gateway
// prefix, and any URL on a foreign origin fails the response closed with a
// clear 502. See pathname_response.go. The gitlab destination additionally
// rejects destination authentication parameters in the query string and
// supported form/JSON bodies, because GitLab reads those before headers
// (pathname_guard.go); the proxy is the sole credential source on every
// upstream leg.
//
// Fail-closed rules — there is no silent fallback anywhere:
//
//   - an unconfigured upstream URL fails closed with 503 "upstream not
//     configured", exactly like a disabled loopback backend;
//   - a missing destination credential fails closed with 503 and a fixed
//     error naming the destination and the missing environment variable —
//     the destination is never silently disabled, and no ReverseProxy is
//     even constructed for it, so it cannot forward unauthenticated;
//   - an unknown path prefix matches no route and gets the gateway's 404.

import (
	"crypto/tls"
	"encoding/base64"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// PathnameDestination configures one direct external upstream selected by
// a gateway path prefix. Upstream is the external base URL; it is
// validated with the same rules as every gateway backend (http or https,
// host present, and no path, query, fragment, or embedded credentials).
// Username and Token are the upstream credential; the bearer and
// private-token destinations use only Token.
type PathnameDestination struct {
	Upstream string
	Username string
	Token    string
}

// Fixed, credential-free fail-closed messages for missing destination
// credentials. They name the destination and the environment variable to
// set and never echo configuration values.
const (
	errJiraCredentialMissing   = "jira destination credential not configured (set JIRA_USERNAME and JIRA_API_TOKEN)"
	errGitHubCredentialMissing = "github destination credential not configured (set GH_TOKEN)"
	errGitLabCredentialMissing = "gitlab destination credential not configured (set GITLAB_TOKEN)"
)

// pathnameDestinationRoutes builds the three fixed direct-destination
// routes from the gateway configuration. Invalid upstream URLs fail with
// the same validation errors as loopback backends; error messages never
// echo the raw URL.
func pathnameDestinationRoutes(cfg GatewayConfig) ([]gatewayRoute, error) {
	parse := func(name, raw string) (*url.URL, error) {
		if raw == "" {
			return nil, nil
		}
		return parseGatewayTarget(name, raw)
	}

	jira, err := parse("jira-api", cfg.JiraAPI.Upstream)
	if err != nil {
		return nil, err
	}
	github, err := parse("github-api", cfg.GitHubAPI.Upstream)
	if err != nil {
		return nil, err
	}
	gitlab, err := parse("gitlab-api", cfg.GitLabAPI.Upstream)
	if err != nil {
		return nil, err
	}

	return []gatewayRoute{
		newJiraPathnameRoute(cfg.JiraAPI, jira),
		newGitHubPathnameRoute(cfg.GitHubAPI, github),
		newGitLabPathnameRoute(cfg.GitLabAPI, gitlab),
	}, nil
}

// newJiraPathnameRoute routes /jira/<rest> (minus the /jira/mcp and
// /jira/rest subtrees) directly to the Jira REST upstream, authorizing the
// upstream leg with the same Basic credential the :8445 Jira listener
// uses. Response URLs are rewritten per pathname_response.go.
func newJiraPathnameRoute(dest PathnameDestination, target *url.URL) gatewayRoute {
	rt := gatewayRoute{
		name:                     "jira-api",
		target:                   target,
		match:                    jiraPathnameMatch,
		stripResponseSensitivity: true,
	}
	if target != nil {
		rt.responseRewrite = newUpstreamRewrite("/jira", target)
	}
	if dest.Username == "" || dest.Token == "" {
		rt.credMissing = errJiraCredentialMissing
		return rt
	}
	// Computed once, exactly like the Jira listener's proxy.
	basic := "Basic " + base64.StdEncoding.EncodeToString([]byte(dest.Username+":"+dest.Token))
	rt.inject = func(h http.Header) {
		stripPathnameAuthHeaders(h)
		h.Set("Authorization", basic)
	}
	return rt
}

// newGitHubPathnameRoute routes /github/<rest> directly to the GitHub API
// upstream, authorizing the upstream leg with a PAT-style bearer token.
// Response URLs are rewritten per pathname_response.go.
func newGitHubPathnameRoute(dest PathnameDestination, target *url.URL) gatewayRoute {
	rt := gatewayRoute{
		name:                     "github-api",
		target:                   target,
		match:                    stripRoutePrefix("/github", "/github"),
		stripResponseSensitivity: true,
	}
	if target != nil {
		rt.responseRewrite = newUpstreamRewrite("/github", target)
	}
	if dest.Token == "" {
		rt.credMissing = errGitHubCredentialMissing
		return rt
	}
	token := dest.Token
	rt.inject = func(h http.Header) {
		stripPathnameAuthHeaders(h)
		h.Set("Authorization", "Bearer "+token)
	}
	return rt
}

// newGitLabPathnameRoute routes /gitlab/<rest> directly to the GitLab API
// upstream, authorizing the upstream leg with a PAT-style PRIVATE-TOKEN
// header. The GitLab upstream is the same host the git auth proxy serves,
// so the route uses a transport with the same TLS environment knobs.
// Requests carrying destination authentication parameters (query string or
// supported bodies) are rejected before the upstream hop per
// pathname_guard.go — GitLab reads those before headers, so the proxy
// stays the sole credential source.
func newGitLabPathnameRoute(dest PathnameDestination, target *url.URL) gatewayRoute {
	rt := gatewayRoute{
		name:                     "gitlab-api",
		target:                   target,
		match:                    stripRoutePrefix("/gitlab", "/gitlab"),
		guard:                    gitlabAuthRequestGuard,
		transport:                gitLabPathnameTransport(),
		stripResponseSensitivity: true,
	}
	if target != nil {
		rt.responseRewrite = newUpstreamRewrite("/gitlab", target)
	}
	if dest.Token == "" {
		rt.credMissing = errGitLabCredentialMissing
		return rt
	}
	token := dest.Token
	rt.inject = func(h http.Header) {
		stripPathnameAuthHeaders(h)
		h.Set("Private-Token", token)
	}
	return rt
}

// jiraPathnameMatch selects /jira/<rest> for the direct Jira REST
// destination while preserving the pre-existing fixed routes: the /jira/mcp
// subtree (the exact route plus its rejected subpaths) and the /jira/rest
// subtree (bare and below, which the :8445-backed route claims with a
// slash) are excluded, so they keep their exact current behavior — routed
// by the fixed routes, or 404 — and nothing existing is re-pointed. The raw
// encoding of the remainder is preserved exactly like the other
// prefix-stripping routes.
func jiraPathnameMatch(u *url.URL) (string, string, bool) {
	if !strings.HasPrefix(u.Path, "/jira/") {
		return "", "", false
	}
	rest := u.Path[len("/jira"):]
	rawRest := ""
	if u.RawPath != "" && strings.HasPrefix(u.RawPath, "/jira") {
		if cand := u.RawPath[len("/jira"):]; validRawPath(cand, rest) {
			rawRest = cand
		}
	}
	if rest == "/mcp" || rest == "/mcp/" || strings.HasPrefix(rest, "/mcp/") ||
		rest == "/rest" || strings.HasPrefix(rest, "/rest/") {
		return "", "", false
	}
	return rest, rawRest, true
}

// stripPathnameAuthHeaders drops client-supplied credential headers that
// the shared gateway strip does not cover (Authorization,
// Proxy-Authorization, and Cookie are already gone). These are the
// remaining headers GitLab's auth finders read (auth_finders.rb
// HEADER_TOKEN_KEYS): PRIVATE-TOKEN, JOB-TOKEN, and DEPLOY-TOKEN. Stripping
// them applies to every destination — they are GitLab-specific, so dropping
// them from the github and jira legs is harmless — and means a client can
// never authenticate to an upstream with its own header credential.
func stripPathnameAuthHeaders(h http.Header) {
	h.Del("Private-Token")
	h.Del("Job-Token")
	h.Del("Deploy-Token")
}

// gitLabPathnameTransport builds the GitLab destination transport. The
// GitLab API upstream is the same host the git auth proxy serves
// (gitlab.cee.redhat.com), so the same TLS environment knobs apply:
// GITLAB_TLS_SKIP_VERIFY, GITLAB_CA_CERT_FILE, and GITLAB_CA_CERT_PEM.
// Ambient proxy configuration is ignored, like every gateway transport.
func gitLabPathnameTransport() http.RoundTripper {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if getEnvAsBool("GITLAB_TLS_SKIP_VERIFY", false) {
		tlsCfg.InsecureSkipVerify = true
	}
	caFile := strings.TrimSpace(os.Getenv("GITLAB_CA_CERT_FILE"))
	caPEM := strings.TrimSpace(os.Getenv("GITLAB_CA_CERT_PEM"))
	if caFile != "" || caPEM != "" {
		pool, err := loadSystemCertPoolWithCustomCA(caFile, caPEM)
		if err != nil {
			log.Printf("pathname gitlab: warning: failed to load custom GitLab CA bundle: %v", err)
		} else {
			tlsCfg.RootCAs = pool
		}
	}
	tr.TLSClientConfig = tlsCfg
	return tr
}
