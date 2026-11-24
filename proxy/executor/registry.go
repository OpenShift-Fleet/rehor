package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

const redHatRegistry = "https://registry.redhat.io"
const redHatRegistryAuth = redHatRegistry + "/auth/realms/rhcc/protocol/redhat-docker-v2/auth"

// Only the Registry V2 operations needed to pull images are exposed. In
// particular, clients cannot reach the token endpoint or request push scopes.
var registryPullPath = regexp.MustCompile(`^/v2/([a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*)/(?:manifests/[A-Za-z0-9_][A-Za-z0-9_.:-]*|blobs/[A-Za-z0-9_][A-Za-z0-9_.:-]*|tags/list)$`)

type registryToken struct {
	value   string
	expires time.Time
}

type registryTransport struct {
	base            http.RoundTripper
	username, token string
	mu              sync.Mutex
	tokens          map[string]registryToken
}

// NewRegistryProxy returns nil when neither credential is supplied. A partial
// configuration is an error, rather than silently enabling anonymous access.
func NewRegistryProxy(username, token string) (http.Handler, error) {
	if username == "" && token == "" {
		return nil, nil
	}
	if strings.TrimSpace(username) == "" || strings.TrimSpace(token) == "" ||
		strings.ContainsAny(username, ":\r\n") || strings.ContainsAny(token, "\r\n") {
		return nil, fmt.Errorf("REGISTRY_REDHAT_USERNAME and REGISTRY_REDHAT_TOKEN must both contain valid credentials")
	}
	base := http.DefaultTransport.(*http.Transport).Clone()
	base.ResponseHeaderTimeout = 30 * time.Second
	transport := &registryTransport{base: base, username: username, token: token, tokens: make(map[string]registryToken)}
	return newRegistryHandler(transport), nil
}

func newRegistryHandler(transport *registryTransport) http.Handler {
	upstream, _ := url.Parse(redHatRegistry)
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(upstream)
			r.Out.Host = upstream.Host
			r.Out.Header.Del("Authorization")
			r.Out.Header.Del("Proxy-Authorization")
			r.Out.Header.Del("Cookie")
			r.Out.Body = nil
			r.Out.ContentLength = 0
		},
		Transport:      transport,
		ModifyResponse: stripSensitiveResponseHeaders,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			// Transport errors can contain signed CDN URLs. Never log or return them.
			http.Error(w, "registry upstream request failed", http.StatusBadGateway)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "registry proxy is pull-only", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path == "/healthz" {
			w.Write([]byte("ok\n"))
			return
		}
		if r.URL.RawPath != "" || (r.URL.Path != "/v2/" && !registryPullPath.MatchString(r.URL.Path)) {
			http.NotFound(w, r)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

func (t *registryTransport) bearerToken(ctx context.Context, scope, rejected string) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if cached := t.tokens[scope]; cached.value != "" && cached.value != rejected && time.Now().Before(cached.expires) {
		return cached.value, nil
	}
	u, _ := url.Parse(redHatRegistryAuth)
	q := url.Values{"service": {"docker-registry"}, "client_id": {"rehor"}}
	if scope != "" {
		q.Set("scope", scope)
	}
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(t.username, t.token)
	client := &http.Client{
		Transport:     t.base,
		Timeout:       30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	started := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("registry token request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("registry token request rejected")
	}
	var result struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result); err != nil {
		return "", fmt.Errorf("invalid registry token response")
	}
	if result.Token == "" {
		result.Token = result.AccessToken
	}
	if result.Token == "" || strings.ContainsAny(result.Token, "\r\n") {
		return "", fmt.Errorf("empty or invalid registry bearer token")
	}
	// The specification defaults an omitted expiry to 60 seconds. Cap the
	// cache lifetime and size; cache only tokens, never manifests or blobs.
	if result.ExpiresIn <= 0 {
		result.ExpiresIn = 60
	}
	if result.ExpiresIn > 300 {
		result.ExpiresIn = 300
	}
	if len(t.tokens) >= 128 {
		clear(t.tokens)
	}
	t.tokens[scope] = registryToken{result.Token, started.Add(time.Duration(result.ExpiresIn)*time.Second - 10*time.Second)}
	return result.Token, nil
}

func registryRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 5 || req.URL.Scheme != "https" || req.URL.User != nil ||
		(req.URL.Port() != "" && req.URL.Port() != "443") {
		return fmt.Errorf("registry redirect denied")
	}
	switch req.URL.Hostname() {
	case "registry.redhat.io":
		if req.URL.Path != "/v2/" && !registryPullPath.MatchString(req.URL.Path) {
			return fmt.Errorf("registry redirect path denied")
		}
	case "cdn.quay.io", "cdn01.quay.io", "cdn02.quay.io", "cdn03.quay.io":
		// A signed blob URL is sufficient; the registry token must stay local.
	default:
		return fmt.Errorf("registry redirect host denied")
	}
	req.Header.Del("Authorization")
	req.Header.Del("Proxy-Authorization")
	req.Header.Del("Cookie")
	req.Header.Del("Referer")
	return nil
}

func (t *registryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	scope := ""
	if match := registryPullPath.FindStringSubmatch(req.URL.Path); match != nil {
		scope = "repository:" + match[1] + ":pull"
	}
	bearer, err := t.bearerToken(req.Context(), scope, "")
	if err != nil {
		return nil, err
	}
	client := &http.Client{Transport: t.base, CheckRedirect: registryRedirect}
	for attempt := 0; attempt < 2; attempt++ {
		out := req.Clone(req.Context())
		// ReverseProxy calls a RoundTripper directly; http.Client requires the
		// server-side RequestURI to be cleared before following redirects.
		out.RequestURI = ""
		out.Header.Set("Authorization", "Bearer "+bearer)
		resp, err := client.Do(out)
		if err != nil {
			return nil, fmt.Errorf("registry download failed")
		}
		if resp.StatusCode != http.StatusUnauthorized || attempt == 1 {
			return resp, nil
		}
		resp.Body.Close()
		bearer, err = t.bearerToken(req.Context(), scope, bearer)
		if err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("registry authentication failed")
}
