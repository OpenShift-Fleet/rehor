package executor

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"strings"
	"time"
)

// GatewayConfig holds the fixed loopback backend URLs for the consolidated
// HTTP path gateway (REHOR-251). Each field enables one set of fixed gateway
// path prefixes routed to the corresponding internal listener:
//
//	/v1/...         -> Models      /v1/...    (canonical model gateway base;
//	                                             coordinator/dispatcher require
//	                                             a model base URL of exactly /v1)
//	/models/...     -> Models      /v1/...    (optional alias for /v1)
//	/jira/mcp       -> JiraMCP     /mcp       (mcp-atlassian streamable HTTP:
//	                                             POST/GET/DELETE on one endpoint)
//	/jira/rest/...  -> JiraREST    /rest/...
//	/git/...        -> Git         /...
//	/vertex/...     -> Vertex      /...
//	/v2/...         -> Registry    /v2/...    (canonical Docker Registry API
//	                                             root; docker cannot use a
//	                                             path-prefixed base URL)
//	/registry/...   -> Registry    /...
//	/screenshots/.. -> Screenshots /...
//	/glitchtip/...  -> GlitchTip   /...
//	/executor/execute -> Executor  /executor/execute (POST only; executor
//	                                             HTTP API, same existing
//	                                             policy/execution path)
//
// An empty field disables that route: requests to its prefixes fail closed
// with 503 rather than being routed anywhere else. Unknown paths are
// rejected with 404; there is no catch-all.
//
// Backends are chosen only at construction time from this fixed set. No
// request path, header, query, or body can select or modify an upstream.
//
// The returned handler is NOT an authentication boundary. It is meant to sit
// behind the OpenShift oauth-proxy Route, which owns all identity checks.
// The gateway consumes (strips) the ingress Authorization bearer and the
// oauth-proxy session cookie so neither reaches an internal backend, and it
// does not trust client-supplied identity headers (it strips them rather
// than honoring them). It adds no authentication of its own.
//
// Backend responses with a same-origin absolute-path Location header are
// rewritten back into the route's gateway prefix, so a backend redirect
// stays on the route that produced it and never becomes an external or
// cross-route redirect. Absolute redirect URLs (the Git smart HTTP case)
// pass through untouched. Location values without a leading slash need no
// rewrite: clients resolve them against the gateway request path, which
// already carries the prefix.
type GatewayConfig struct {
	Models      string // OpenAI-compatible gateway listener, e.g. http://127.0.0.1:8450
	JiraMCP     string // mcp-atlassian streamable HTTP listener, e.g. http://127.0.0.1:8444
	JiraREST    string // Jira REST auth proxy listener, e.g. http://127.0.0.1:8445
	Git         string // git auth proxy listener, e.g. http://127.0.0.1:8447
	Vertex      string // Vertex auth proxy listener, e.g. http://127.0.0.1:8443
	Registry    string // Red Hat registry pull proxy listener, e.g. http://127.0.0.1:8451
	Screenshots string // screenshot upload listener, e.g. http://127.0.0.1:8446
	GlitchTip   string // GlitchTip auth proxy listener, e.g. http://127.0.0.1:8448
	// Executor is the existing executor listener (h2c: legacy gRPC and the
	// HTTP/1.1 /executor/execute wrapper share the port), e.g.
	// http://127.0.0.1:9090. No extra loopback listener is needed.
	Executor string
}

// DefaultGatewayConfig returns the loopback URLs for the default listener
// ports of the proxy services (see cmd/server/main.go flags and
// proxy/start.sh).
func DefaultGatewayConfig() GatewayConfig {
	return GatewayConfig{
		Models:      "http://127.0.0.1:8450",
		JiraMCP:     "http://127.0.0.1:8444",
		JiraREST:    "http://127.0.0.1:8445",
		Git:         "http://127.0.0.1:8447",
		Vertex:      "http://127.0.0.1:8443",
		Registry:    "http://127.0.0.1:8451",
		Screenshots: "http://127.0.0.1:8446",
		GlitchTip:   "http://127.0.0.1:8448",
		Executor:    "http://127.0.0.1:9090",
	}
}

// gatewayRoute is one fixed prefix mapping. target == nil means the prefix
// is known but its backend is disabled; such requests fail closed with 503.
// reverse rewrites same-route relative Location values back into gateway
// space; nil means response Locations need no rewriting. postOnly restricts
// the route to POST (405 otherwise).
type gatewayRoute struct {
	name     string
	target   *url.URL
	proxy    *httputil.ReverseProxy
	match    func(u *url.URL) (path, rawPath string, ok bool)
	reverse  func(location string) string
	postOnly bool
}

// NewHTTPGateway builds the fixed-path multiplexer. It returns an error for
// invalid backend URLs (bad scheme, missing host, embedded credentials,
// paths, query, or fragment) and when no backend is configured at all.
// Error messages name the offending config field and reason only; they never
// echo the raw URL, which could contain credentials.
func NewHTTPGateway(cfg GatewayConfig) (http.Handler, error) {
	targets := map[string]*url.URL{}
	for _, f := range []struct{ name, raw string }{
		{"models", cfg.Models},
		{"jira-mcp", cfg.JiraMCP},
		{"jira-rest", cfg.JiraREST},
		{"git", cfg.Git},
		{"vertex", cfg.Vertex},
		{"registry", cfg.Registry},
		{"screenshots", cfg.Screenshots},
		{"glitchtip", cfg.GlitchTip},
		{"executor", cfg.Executor},
	} {
		if f.raw == "" {
			continue
		}
		u, err := parseGatewayTarget(f.name, f.raw)
		if err != nil {
			return nil, err
		}
		targets[f.name] = u
	}
	if len(targets) == 0 {
		return nil, fmt.Errorf("http gateway requires at least one backend URL")
	}

	newRoute := func(name string, target *url.URL,
		match func(*url.URL) (string, string, bool),
		reverse func(string) string, postOnly bool) gatewayRoute {
		return gatewayRoute{name: name, target: target, match: match, reverse: reverse, postOnly: postOnly}
	}

	// Fixed routing table. Exact matches come first; every route below has a
	// disjoint prefix, so order only matters for readability. The two
	// canonical pass-through routes (/v1, /v2) keep the backend path grammar
	// (and thus the legacy listener behavior) unchanged; the /models and
	// /registry entries are aliases that strip their prefix.
	routes := []gatewayRoute{
		newRoute("jira-mcp", targets["jira-mcp"], exactPaths(map[string]string{
			"/jira/mcp":  "/mcp",
			"/jira/mcp/": "/mcp", // Starlette would redirect this to /mcp; serve it directly.
		}), rewriteLocationExact(map[string]string{
			"/mcp":  "/jira/mcp",
			"/mcp/": "/jira/mcp/",
		}), false),
		newRoute("jira-rest", targets["jira-rest"],
			stripRoutePrefix("/jira/rest", "/jira"), rewriteLocationPrefix("/jira"), false),
		newRoute("openai", targets["models"], passRoutePrefix("/v1"), nil, false),
		newRoute("openai-alias", targets["models"],
			stripRoutePrefix("/models", "/models"), rewriteLocationPrefix("/models"), false),
		newRoute("git", targets["git"],
			stripRoutePrefix("/git", "/git"), rewriteLocationPrefix("/git"), false),
		newRoute("vertex", targets["vertex"],
			stripRoutePrefix("/vertex", "/vertex"), rewriteLocationPrefix("/vertex"), false),
		newRoute("registry-v2", targets["registry"], passRoutePrefix("/v2"), nil, false),
		newRoute("registry-alias", targets["registry"],
			stripRoutePrefix("/registry", "/registry"), rewriteLocationPrefix("/registry"), false),
		newRoute("screenshots", targets["screenshots"],
			stripRoutePrefix("/screenshots", "/screenshots"), rewriteLocationPrefix("/screenshots"), false),
		newRoute("glitchtip", targets["glitchtip"],
			stripRoutePrefix("/glitchtip", "/glitchtip"), rewriteLocationPrefix("/glitchtip"), false),
		// The executor API is exposed as exactly one POST endpoint. No other
		// /executor/ subpath routes anywhere — there is no catch-all onto an
		// RPC service prefix, and non-POST methods are rejected by the
		// gateway wrapper before the backend sees them.
		newRoute("executor", targets["executor"], exactPaths(map[string]string{
			"/executor/execute": "/executor/execute",
		}), nil, true),
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	// The upstreams are fixed loopback listeners chosen at construction
	// time; ambient proxy configuration (HTTP_PROXY, HTTPS_PROXY, NO_PROXY)
	// must never divert gateway traffic anywhere else.
	transport.Proxy = nil

	for i := range routes {
		rt := routes[i]
		if rt.target == nil {
			continue
		}
		target := rt.target
		modifyResponse := func(*http.Response) error { return nil }
		if rt.reverse != nil {
			reverse := rt.reverse
			modifyResponse = func(resp *http.Response) error {
				locs := resp.Header.Values("Location")
				if len(locs) == 0 {
					return nil
				}
				resp.Header.Del("Location")
				for _, loc := range locs {
					resp.Header.Add("Location", reverse(loc))
				}
				return nil
			}
		}
		routes[i].proxy = &httputil.ReverseProxy{
			Rewrite: func(r *httputil.ProxyRequest) {
				outPath, outRawPath, ok := rt.match(r.In.URL)
				if !ok {
					// ServeHTTP only dispatches matched requests.
					return
				}
				r.SetURL(target)
				r.Out.URL.Path = outPath
				r.Out.URL.RawPath = outRawPath
				r.Out.URL.RawQuery = r.In.URL.RawQuery
				r.Out.Host = target.Host
				// The ingress bearer belongs to the oauth-proxy Route and
				// the session cookie to oauth-proxy itself; internal backends
				// inject their own vendor credentials. Drop every header that
				// could smuggle route credentials or spoofed identity
				// downstream — both the X-Forwarded-* and X-Auth-Request-*
				// oauth-proxy families, by explicit deletion and by prefix so
				// no variant depends on sidecar defaults. Backends must not
				// trust these headers either.
				h := r.Out.Header
				h.Del("Authorization")
				h.Del("Proxy-Authorization")
				h.Del("Cookie")
				h.Del("X-Forwarded-Access-Token")
				h.Del("X-Forwarded-User")
				h.Del("X-Forwarded-Groups")
				h.Del("X-Forwarded-Email")
				h.Del("X-Forwarded-Preferred-Username")
				for k := range h {
					if strings.HasPrefix(k, "X-Auth-Request-") {
						h.Del(k)
					}
				}
			},
			// Flush immediately: MCP SSE streams, model completions, and git
			// pack negotiation must not be buffered.
			FlushInterval:  -1,
			Transport:      transport,
			ModifyResponse: modifyResponse,
			ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
				// Never log or return the raw error: transport errors can
				// carry upstream URLs, header contents, or injected request
				// data. Log a fixed route ID and a coarse error class only.
				log.Printf("http-gateway: route=%s upstream_error class=%s",
					rt.name, gatewayErrorClass(err))
				http.Error(w, "gateway upstream request failed", http.StatusBadGateway)
			},
		}
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		if r.Method == http.MethodConnect {
			http.Error(w, "CONNECT is not supported by the http gateway", http.StatusMethodNotAllowed)
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == "/healthz" {
			w.Write([]byte("ok\n"))
			return
		}
		// Route on the decoded path, but reject anything that is not already
		// clean: dot segments and double slashes (however encoded) must never
		// rebase a remainder onto another route or backend. A single trailing
		// slash is the only tolerated difference (Docker probes /v2/ and
		// /jira/mcp/ is accepted alongside /jira/mcp).
		if r.URL.Path == "*" {
			http.NotFound(w, r)
			return
		}
		if strings.Contains(r.URL.Path, "\x00") {
			http.Error(w, "forbidden: path traversal detected", http.StatusForbidden)
			return
		}
		if c := path.Clean(r.URL.Path); c != r.URL.Path && r.URL.Path != c+"/" {
			http.Error(w, "forbidden: path traversal detected", http.StatusForbidden)
			return
		}
		for i := range routes {
			rt := &routes[i]
			if _, _, ok := rt.match(r.URL); !ok {
				continue
			}
			if rt.postOnly && r.Method != http.MethodPost {
				w.Header().Set("Allow", http.MethodPost)
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			if rt.proxy == nil {
				log.Printf("http-gateway: route=%s method=%s disabled", rt.name, r.Method)
				http.Error(w, "upstream not configured", http.StatusServiceUnavailable)
				return
			}
			rec := &statusRecorder{ResponseWriter: w}
			rt.proxy.ServeHTTP(rec, r)
			// Log only fixed identifiers and counters. The raw path is
			// attacker-controlled and can carry sensitive data or control
			// characters; it must never reach the logs.
			log.Printf("http-gateway: route=%s method=%s status=%d dur=%s",
				rt.name, r.Method, rec.status,
				time.Since(start).Round(time.Millisecond))
			return
		}
		http.NotFound(w, r)
	}), nil
}

// gatewayErrorClass reduces a transport error to a fixed label. The
// underlying message can name upstream URLs, carry header contents, or
// reflect injected request data, so it is never logged or returned.
func gatewayErrorClass(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "client_canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded"
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "timeout"
	}
	return "upstream_unavailable"
}

// parseGatewayTarget validates a fixed backend base URL. Loopback listeners
// have no path, query, fragment, or credentials; anything else is a
// configuration error rather than something to silently interpret. Error
// messages contain the config field name and the reason only — never the
// raw URL, which could contain credentials.
func parseGatewayTarget(name, raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("http gateway %s: backend URL is not parseable", name)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("http gateway %s: backend URL must use http or https", name)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("http gateway %s: backend URL has no host", name)
	}
	if u.User != nil {
		return nil, fmt.Errorf("http gateway %s: backend URL must not contain credentials", name)
	}
	if u.Path != "" && u.Path != "/" {
		return nil, fmt.Errorf("http gateway %s: backend URL must not contain a path", name)
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("http gateway %s: backend URL must not contain a query or fragment", name)
	}
	return u, nil
}

// exactPaths matches whole paths only and maps them to fixed backend paths.
func exactPaths(mapping map[string]string) func(*url.URL) (string, string, bool) {
	return func(u *url.URL) (string, string, bool) {
		if to, ok := mapping[u.Path]; ok {
			return to, "", true
		}
		return "", "", false
	}
}

// passRoutePrefix forwards the path unchanged (canonical /v1 and /v2 roots).
func passRoutePrefix(prefix string) func(*url.URL) (string, string, bool) {
	return func(u *url.URL) (string, string, bool) {
		if u.Path != prefix && !strings.HasPrefix(u.Path, prefix+"/") {
			return "", "", false
		}
		return u.Path, u.RawPath, true
	}
}

// stripRoutePrefix matches match+"/rest" and yields the remainder after
// removing strip, which must be a leading substring of match (e.g. match
// "/jira/rest", strip "/jira" keeps the /rest prefix on the backend). The
// raw encoding of the remainder is preserved when it is consistent (e.g.
// %2F stays %2F instead of being re-escaped to a real slash).
func stripRoutePrefix(match, strip string) func(*url.URL) (string, string, bool) {
	return func(u *url.URL) (string, string, bool) {
		if !strings.HasPrefix(u.Path, match+"/") {
			return "", "", false
		}
		rest := u.Path[len(strip):]
		rawRest := ""
		if u.RawPath != "" && strings.HasPrefix(u.RawPath, strip) {
			if cand := u.RawPath[len(strip):]; validRawPath(cand, rest) {
				rawRest = cand
			}
		}
		// When the raw path encodes the prefix itself differently (e.g.
		// /mod%65ls/...), fall back to the default escaping of the decoded
		// remainder; the decoded prefix still had to match, so this grants
		// no access to any other route.
		return rest, rawRest, true
	}
}

// validRawPath reports whether raw unescapes to exactly want.
func validRawPath(raw, want string) bool {
	dec, err := url.PathUnescape(raw)
	return err == nil && dec == want
}

// rewriteLocationPrefix returns a Location rewriter for prefix-stripping
// routes: a same-origin absolute-path Location gets the route prefix
// prepended, so backend redirects stay inside the route that produced them.
func rewriteLocationPrefix(prefix string) func(string) string {
	return func(location string) string {
		return rewriteRelativeLocation(location, func(p string) string { return prefix + p })
	}
}

// rewriteLocationExact returns a Location rewriter for exact-match routes,
// mapping known backend paths back to their gateway paths and leaving
// everything else untouched.
func rewriteLocationExact(mapping map[string]string) func(string) string {
	return func(location string) string {
		return rewriteRelativeLocation(location, func(p string) string {
			if to, ok := mapping[p]; ok {
				return to
			}
			return p
		})
	}
}

// rewriteRelativeLocation rewrites same-origin absolute-path Location values
// (leading "/", not "//") using toGateway. Absolute URLs and
// protocol-relative references pass through unchanged — the backends are
// fixed internal listeners and may legitimately redirect to external
// origins (git host redirects), but the rewrite never introduces one.
// Values without a leading slash also pass through: clients resolve them
// against the gateway request path, which already carries the prefix.
func rewriteRelativeLocation(location string, toGateway func(string) string) string {
	if !strings.HasPrefix(location, "/") || strings.HasPrefix(location, "//") {
		return location
	}
	path, suffix := location, ""
	if i := strings.IndexByte(location, '?'); i >= 0 {
		path, suffix = location[:i], location[i:]
	}
	return toGateway(path) + suffix
}
