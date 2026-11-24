package main

// Authenticated HTTP transport for the executor thin client (REHOR-252:
// expose executor commands through the consolidated authenticated HTTP
// gateway).
//
// TRANSPORT SELECTION (default HTTP, no per-instance config needed):
//
//	Default (no EXECUTOR_HTTP_URL): HTTP/1.1 POST to /executor/execute on the
//	EXISTING EXECUTOR_ADDR listener — the updated proxy serves both legacy
//	gRPC (HTTP/2) and HTTP/1.1 on the same listener, same NetworkPolicy
//	boundary, no new service port.
//	  - "host:port" or "dns:///host:port"  -> http://host:port/executor/execute
//	  - "unix:///path" (and the unset default
//	    unix:///var/run/devbot/executor.sock) -> HTTP over the unix socket
//	    with the synthetic URL http://executor/executor/execute
//	The derived internal transport is plaintext and NEVER carries credentials:
//	setting EXECUTOR_TOKEN or EXECUTOR_CA_FILE without an explicit
//	EXECUTOR_HTTP_URL is a configuration error.
//
//	EXECUTOR_HTTP_URL: explicit endpoint for dispatched sandboxes, normally
//	https://<public-services-route>/executor/execute. Must be https (plain
//	http only on loopback for offline tests), path exactly /executor/execute,
//	no userinfo, query, or fragment. Deliberately overrides EXECUTOR_ADDR.
//	Credentials are used ONLY on this explicit endpoint:
//	  - EXECUTOR_TOKEN: sandbox placeholder, must match exactly
//	    openshell:resolve:env:<identifier> (ASCII letters, digits,
//	    underscore); any other value — including a real bearer or JWT — is
//	    rejected so a secret can never silently land in the environment.
//	    There is deliberately NO real-token mechanism: EXECUTOR_TOKEN_FILE is
//	    always a configuration error (only user-issued placeholders are
//	    supported).
//	  - EXECUTOR_CA_FILE: optional PEM bundle for offline/test trust, ADDITIVE
//	    to the system trust store (the public route certificate is normally
//	    public-CA signed).
//
//	EXECUTOR_TRANSPORT=grpc: explicit rollback to the legacy gRPC client.
//	There is NO automatic fallback from HTTP failure to gRPC: a command may
//	    have already executed, so a silent retry could double-execute. An
//	    outdated grpc-only proxy therefore fails loudly until the updated
//	    dual-protocol proxy is deployed (deploy server first).
//
//	EXECUTOR_TLS and EXECUTOR_SERVER_NAME (gRPC TLS experiment) are
//	unsupported: setting them is a configuration error.
//
// TLS always verifies with a minimum of TLS 1.2; there is no insecure-skip
// option. All redirects are disabled so the bearer token and request body
// can never be replayed to another target. The derived internal transport
// ignores ambient proxy variables (matching legacy gRPC WithNoProxy);
// explicit HTTPS endpoints honor HTTP(S)_PROXY/NO_PROXY so the sandbox
// supervisor policy proxy can mediate the placeholder header.
//
// Configuration errors never include token values.

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	pb "github.com/RedHatInsights/platform-frontend-ai-dev/proxy/executor/gen"
	"golang.org/x/net/http/httpproxy"
	"google.golang.org/protobuf/proto"
)

const (
	// httpEndpointPath is the only accepted gateway path.
	httpEndpointPath = "/executor/execute"
	// protobufContentType is the canonical binary codec the gateway and the
	// thin client speak. The server may also serve JSON for manual debugging,
	// but the client only ever sends and accepts binary protobuf.
	protobufContentType = "application/x-protobuf"
	// maxWireBytes matches the gRPC default max message size in both
	// directions, measured on the protobuf wire (no JSON base64/escaping
	// inflation), preserving the legacy 4 MiB envelope exactly.
	maxWireBytes = 4 << 20 // 4 MiB
	// unixSyntheticHost makes http://executor/executor/execute route through
	// the custom unix-socket DialContext.
	unixSyntheticHost = "executor"
)

// httpExecTimeout bounds one HTTP tool execution (context deadline).
var httpExecTimeout = 120 * time.Second

// placeholderTokenPattern is the exact nonsecret marker accepted in
// EXECUTOR_TOKEN. Anything else — notably a raw bearer or JWT — is rejected.
var placeholderTokenPattern = regexp.MustCompile(`^openshell:resolve:env:[A-Za-z0-9_]+$`)

// errRedirectRefused marks a refused redirect (HTTP-level failure, exit 1,
// not a connect error).
var errRedirectRefused = errors.New("redirect refused")

// transportConfig selects the execution transport.
type transportConfig struct {
	grpc bool
	http *httpConfig
}

// httpConfig is the resolved HTTP transport configuration.
type httpConfig struct {
	url      *url.URL
	unixPath string
	// internal marks the derived plaintext transport from EXECUTOR_ADDR:
	// same listener and NetworkPolicy boundary as legacy gRPC, so ambient
	// proxy environment is deliberately ignored (like WithNoProxy).
	internal    bool
	client      *http.Client
	staticToken string
}

// resolveTransportConfig picks the transport: EXECUTOR_TRANSPORT=grpc rolls
// back to legacy gRPC; otherwise HTTP — derived from EXECUTOR_ADDR by
// default, or the explicit EXECUTOR_HTTP_URL endpoint.
func resolveTransportConfig(getenv func(string) string) (*transportConfig, error) {
	// Fail loudly on configuration that no longer has any effect.
	if v := getenv("EXECUTOR_TLS"); v != "" {
		return nil, errors.New("EXECUTOR_TLS is not supported; authenticated transport is EXECUTOR_HTTP_URL (HTTPS)")
	}
	if v := getenv("EXECUTOR_SERVER_NAME"); v != "" {
		return nil, errors.New("EXECUTOR_SERVER_NAME is not supported; authenticated transport is EXECUTOR_HTTP_URL (HTTPS)")
	}

	forceGRPC := false
	switch sel := strings.ToLower(strings.TrimSpace(getenv("EXECUTOR_TRANSPORT"))); sel {
	case "", "http":
	case "grpc":
		forceGRPC = true
	default:
		return nil, fmt.Errorf("EXECUTOR_TRANSPORT must be http or grpc")
	}

	// Real token files are not part of the thin client credential model:
	// only the user-issued nonsecret EXECUTOR_TOKEN placeholder exists.
	// The value is never echoed and the path is never read.
	if getenv("EXECUTOR_TOKEN_FILE") != "" {
		return nil, errors.New("EXECUTOR_TOKEN_FILE is not supported: the thin client only accepts the nonsecret EXECUTOR_TOKEN placeholder; real token files are not supported")
	}

	rawURL := getenv("EXECUTOR_HTTP_URL")
	tokenEnv := getenv("EXECUTOR_TOKEN")
	caFile := getenv("EXECUTOR_CA_FILE")

	if forceGRPC {
		if rawURL != "" {
			return nil, errors.New("EXECUTOR_TRANSPORT=grpc conflicts with EXECUTOR_HTTP_URL")
		}
		if tokenEnv != "" || caFile != "" {
			return nil, errors.New("EXECUTOR_TOKEN and EXECUTOR_CA_FILE are not supported with EXECUTOR_TRANSPORT=grpc; use EXECUTOR_HTTP_URL (HTTPS)")
		}
		return &transportConfig{grpc: true}, nil
	}

	if tokenEnv != "" && !placeholderTokenPattern.MatchString(tokenEnv) {
		// Never include the value: it may be an accidentally supplied
		// real credential.
		return nil, errors.New("EXECUTOR_TOKEN must be a nonsecret placeholder of the form openshell:resolve:env:<identifier>; real credentials are not supported")
	}

	cfg := &httpConfig{staticToken: tokenEnv}

	if rawURL != "" {
		endpoint, err := parseHTTPURL(rawURL)
		if err != nil {
			return nil, err
		}
		cfg.url = endpoint

		if endpoint.Scheme == "https" {
			tlsCfg := &tls.Config{
				MinVersion: tls.VersionTLS12,
				// InsecureSkipVerify is intentionally never set.
			}
			if caFile != "" {
				pool, err := loadAdditiveRoots(caFile)
				if err != nil {
					return nil, err
				}
				tlsCfg.RootCAs = pool
			}
			cfg.client = newHTTPClient(cfg, tlsCfg)
		} else {
			// Loopback plain http is allowed only for offline tests and
			// never carries credentials.
			if tokenEnv != "" || caFile != "" {
				return nil, errors.New("EXECUTOR_TOKEN and EXECUTOR_CA_FILE require an https EXECUTOR_HTTP_URL; plain http never carries credentials")
			}
			cfg.client = newHTTPClient(cfg, nil)
		}
	} else {
		// Derived internal plaintext transport from EXECUTOR_ADDR: same
		// listener and NetworkPolicy boundary as the legacy gRPC socket.
		// Credentials are rejected here, not silently ignored.
		if tokenEnv != "" || caFile != "" {
			return nil, errors.New("EXECUTOR_TOKEN and EXECUTOR_CA_FILE require an explicit https EXECUTOR_HTTP_URL; the derived internal transport is plaintext and never carries credentials")
		}
		addr := getenv("EXECUTOR_ADDR")
		if addr == "" {
			addr = "unix:///var/run/devbot/executor.sock"
		}
		endpoint, unixPath, err := deriveHTTPURL(addr)
		if err != nil {
			return nil, err
		}
		cfg.url = endpoint
		cfg.unixPath = unixPath
		cfg.internal = true
		cfg.client = newHTTPClient(cfg, nil)
	}

	return &transportConfig{http: cfg}, nil
}

// deriveHTTPURL maps a legacy EXECUTOR_ADDR onto the derived internal HTTP
// endpoint served alongside gRPC on the same listener.
func deriveHTTPURL(addr string) (*url.URL, string, error) {
	if strings.HasPrefix(addr, "unix://") {
		path := strings.TrimPrefix(addr, "unix://")
		if path == "" {
			return nil, "", errors.New("EXECUTOR_ADDR unix socket path is empty")
		}
		u, err := url.Parse("http://" + unixSyntheticHost + httpEndpointPath)
		if err != nil {
			return nil, "", err
		}
		return u, path, nil
	}

	hostport := addr
	if strings.HasPrefix(addr, "dns:///") {
		hostport = strings.TrimPrefix(addr, "dns:///")
	} else if strings.Contains(addr, "://") {
		return nil, "", fmt.Errorf("EXECUTOR_ADDR scheme is not supported for the derived HTTP transport; use EXECUTOR_TRANSPORT=grpc for legacy addresses or EXECUTOR_HTTP_URL for an explicit endpoint")
	}

	if _, _, err := net.SplitHostPort(hostport); err != nil {
		return nil, "", fmt.Errorf("EXECUTOR_ADDR must be host:port for the derived HTTP transport: %w", err)
	}
	u, err := url.Parse("http://" + hostport + httpEndpointPath)
	if err != nil {
		return nil, "", err
	}
	return u, "", nil
}

// parseHTTPURL validates an explicit EXECUTOR_HTTP_URL: https (or loopback
// http for offline tests), exact path, no userinfo, query, or fragment.
// Errors never echo the raw URL: url.Parse failures can include userinfo.
func parseHTTPURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errors.New("EXECUTOR_HTTP_URL is not a valid URL")
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !isLoopbackHost(u.Hostname()) {
			return nil, errors.New("EXECUTOR_HTTP_URL must use https outside loopback (plain http is only allowed for offline loopback tests)")
		}
	default:
		return nil, errors.New("EXECUTOR_HTTP_URL must use scheme https")
	}
	if u.Host == "" {
		return nil, errors.New("EXECUTOR_HTTP_URL must include a host")
	}
	if u.User != nil {
		return nil, errors.New("EXECUTOR_HTTP_URL must not contain userinfo")
	}
	if u.RawQuery != "" || u.ForceQuery {
		return nil, errors.New("EXECUTOR_HTTP_URL must not contain a query string")
	}
	if u.Fragment != "" || u.RawFragment != "" || strings.HasSuffix(raw, "#") {
		return nil, errors.New("EXECUTOR_HTTP_URL must not contain a fragment")
	}
	if u.Path != httpEndpointPath {
		return nil, fmt.Errorf("EXECUTOR_HTTP_URL path must be exactly %s", httpEndpointPath)
	}
	return u, nil
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// newHTTPClient builds the gateway client: bounded dial, given TLS config
// (nil = plaintext), and every redirect disabled so the bearer token and
// request body can never be replayed to another target.
//
// Proxying: the derived internal transport (same listener and NetworkPolicy
// boundary as legacy gRPC WithNoProxy) ignores ambient proxy variables.
// Explicit HTTPS endpoints honor the trusted HTTP(S)_PROXY/NO_PROXY
// environment so the sandbox supervisor policy proxy can intercept and
// mediate the placeholder Authorization header. No proxy credentials are
// invented. TLS verification is always normal; the system root pool
// (honoring SSL_CERT_FILE where the platform does) trusts the OpenShell CA.
func newHTTPClient(cfg *httpConfig, tlsCfg *tls.Config) *http.Client {
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			var d net.Dialer
			if cfg.unixPath != "" {
				return d.DialContext(ctx, "unix", cfg.unixPath)
			}
			d.Timeout = dialTimeout
			return d.DialContext(ctx, network, addr)
		},
		TLSClientConfig:     tlsCfg,
		MaxIdleConns:        1,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: dialTimeout,
	}
	if !cfg.internal && cfg.url.Scheme == "https" {
		// Per-client env snapshot: net/http's ProxyFromEnvironment caches
		// the proxy config process-wide on first use, which would ignore
		// later environment changes; httpproxy.FromEnvironment reads the
		// trusted HTTP(S)_PROXY/NO_PROXY variables per client.
		proxyFunc := httpproxy.FromEnvironment().ProxyFunc()
		transport.Proxy = func(req *http.Request) (*url.URL, error) {
			return proxyFunc(req.URL)
		}
	}
	return &http.Client{
		Transport: transport,
		// Static sentinel only: never echo the redirect target, whose URL
		// could carry secrets in a query string.
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return errRedirectRefused
		},
		Timeout: httpExecTimeout,
	}
}

// loadAdditiveRoots returns the system trust store plus the given PEM bundle.
func loadAdditiveRoots(caFile string) (*x509.CertPool, error) {
	pem, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read EXECUTOR_CA_FILE: %w", err)
	}
	pool, err := x509.SystemCertPool()
	if err != nil {
		return nil, fmt.Errorf("load system roots: %w", err)
	}
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("EXECUTOR_CA_FILE %s contains no PEM certificates", caFile)
	}
	return pool, nil
}

// bearerToken returns the nonsecret EXECUTOR_TOKEN placeholder verbatim.
// There is deliberately no real-token mechanism: no file is ever read.
func (c *httpConfig) bearerToken() (string, error) {
	return c.staticToken, nil
}

// isConnectError reports whether err is a connection establishment failure
// (dial, DNS, or TLS handshake — exit 127), as opposed to a request or
// protocol failure (exit 1). Refused redirects are HTTP-level failures.
func isConnectError(err error) bool {
	if errors.Is(err, errRedirectRefused) {
		return false
	}
	var ue *url.Error
	if !errors.As(err, &ue) {
		return false
	}
	var opErr *net.OpError
	if errors.As(ue.Err, &opErr) && strings.HasPrefix(opErr.Op, "dial") {
		return true
	}
	var x509Err x509.UnknownAuthorityError
	if errors.As(ue.Err, &x509Err) {
		return true
	}
	var hostErr x509.HostnameError
	if errors.As(ue.Err, &hostErr) {
		return true
	}
	var verifyErr *tls.CertificateVerificationError
	if errors.As(ue.Err, &verifyErr) {
		return true
	}
	return false
}

// redactURL renders a URL without any userinfo, for error messages.
func redactURL(u *url.URL) string {
	if u == nil {
		return ""
	}
	c := *u
	c.User = nil
	return c.String()
}

// httpExecute performs one tool execution over the HTTP gateway using the
// canonical binary protobuf codec: proto.Marshal of the generated
// ExecuteRequest, Content-Type application/x-protobuf, proto.Unmarshal of the
// ExecuteResponse with the content type validated. Wire size is capped at
// 4 MiB in both directions, matching the legacy gRPC envelope without JSON
// base64/escaping inflation.
func httpExecute(ctx context.Context, cfg *httpConfig, req *pb.ExecuteRequest) (*pb.ExecuteResponse, error) {
	body, err := proto.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("encode request: %w", err)
	}
	if len(body) > maxWireBytes {
		return nil, fmt.Errorf("request exceeds %d bytes", maxWireBytes)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.url.String(), bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", protobufContentType)

	token, err := cfg.bearerToken()
	if err != nil {
		return nil, err
	}
	if token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := cfg.client.Do(httpReq)
	if err != nil {
		if errors.Is(err, errRedirectRefused) {
			// net/http wraps refused redirects in a *url.Error carrying the
			// redirect target (query may hold secrets); return only the
			// static sentinel.
			return nil, errRedirectRefused
		}
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("gateway returned HTTP %d", resp.StatusCode)
	}

	mediaType, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil || mediaType != protobufContentType {
		return nil, fmt.Errorf("gateway returned Content-Type %q, want %s", resp.Header.Get("Content-Type"), protobufContentType)
	}

	// Cap the response at the gRPC default max message size (wire bytes).
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxWireBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if len(data) > maxWireBytes {
		return nil, fmt.Errorf("response exceeds %d bytes", maxWireBytes)
	}

	var out pb.ExecuteResponse
	if err := proto.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return &out, nil
}
