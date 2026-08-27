package executor

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// Auth type constants
	AuthTypeBearer = "bearer"
	AuthTypeBasic  = "basic"

	// Error messages
	errPathTraversal = "forbidden: path traversal detected"
	errNoHost        = "bad request: no host in path"
	errUnknownHost   = "forbidden: unknown host"
	errMissingToken  = "service unavailable: missing token"

	// DisableFlush disables periodic flushing for streaming responses.
	// Used for proxying large git pack files without buffering.
	DisableFlush = -1
)

type GitHost struct {
	Scheme                string
	Host                  string
	AuthType              string
	Token                 func() string
	Username              func() string
	TLSInsecureSkipVerify bool
}

func defaultHostRegistry() map[string]*GitHost {
	return map[string]*GitHost{
		"github.com": {
			Scheme:   "https",
			Host:     "github.com",
			AuthType: AuthTypeBearer,
			Token:    func() string { return os.Getenv("GH_TOKEN") },
			Username: nil,
		},
		"gitlab.cee.redhat.com": {
			Scheme:                "https",
			Host:                  "gitlab.cee.redhat.com",
			AuthType:              AuthTypeBasic,
			Token:                 func() string { return os.Getenv("GITLAB_TOKEN") },
			Username:              func() string { return os.Getenv("GL_USERNAME") },
			TLSInsecureSkipVerify: getEnvAsBool("GITLAB_TLS_SKIP_VERIFY", false),
		},
	}
}

func NewGitAuthProxy() http.Handler {
	return newGitAuthProxyWithRegistry(defaultHostRegistry())
}

type contextKey string

const (
	hostConfigKey    contextKey = "hostConfig"
	pathRemainderKey contextKey = "pathRemainder"
	tokenKey         contextKey = "token"
)

func newGitAuthProxyWithRegistry(hostRegistry map[string]*GitHost) http.Handler {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			hostConfig, ok := r.In.Context().Value(hostConfigKey).(*GitHost)
			if !ok {
				return
			}

			remainder, ok := r.In.Context().Value(pathRemainderKey).(string)
			if !ok {
				return
			}

			token, ok := r.In.Context().Value(tokenKey).(string)
			if !ok {
				return
			}

			upstream := &url.URL{
				Scheme: hostConfig.Scheme,
				Host:   hostConfig.Host,
			}

			r.SetURL(upstream)
			r.Out.URL.Path = remainder
			r.Out.URL.RawQuery = r.In.URL.RawQuery
			r.Out.Host = hostConfig.Host

			if hostConfig.AuthType == AuthTypeBearer {
				r.Out.Header.Set("Authorization", "Bearer "+token)
			} else if hostConfig.AuthType == AuthTypeBasic {
				if hostConfig.Username == nil {
					return
				}
				username := hostConfig.Username()
				basicAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+token))
				r.Out.Header.Set("Authorization", basicAuth)
			}
		},
		FlushInterval:  DisableFlush,
		ModifyResponse: stripSensitiveResponseHeaders,
		Transport:     NewPerHostTransportManager(hostRegistry),
	}

	// Helper to log requests with consistent format
	logRequest := func(r *http.Request, status int, start time.Time, host string) {
		log.Printf("gitauth: method=%s host=%s path=%s status=%d dur=%s",
			r.Method, host, r.URL.Path, status,
			time.Since(start).Round(time.Millisecond))
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && r.URL.Path == "/healthz" {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("ok\n"))
			return
		}
		start := time.Now()
		inPath := r.URL.Path
		cleanPath := path.Clean(inPath)

		if cleanPath != inPath {
			status := http.StatusForbidden
			http.Error(w, errPathTraversal, status)
			logRequest(r, status, start, "")
			return
		}

		parts := strings.SplitN(strings.TrimPrefix(cleanPath, "/"), "/", 2)
		if len(parts) < 2 || parts[1] == "" {
			status := http.StatusBadRequest
			http.Error(w, errNoHost, status)
			logRequest(r, status, start, "")
			return
		}

		host := parts[0]
		remainder := "/" + parts[1]

		hostConfig, ok := hostRegistry[host]
		if !ok {
			if !strings.Contains(host, ".") {
				status := http.StatusBadRequest
				http.Error(w, errNoHost, status)
				logRequest(r, status, start, "")
				return
			}
			status := http.StatusForbidden
			http.Error(w, errUnknownHost, status)
			logRequest(r, status, start, host)
			return
		}

		token := hostConfig.Token()
		if token == "" {
			status := http.StatusServiceUnavailable
			http.Error(w, errMissingToken, status)
			logRequest(r, status, start, host)
			return
		}

		ctx := context.WithValue(r.Context(), hostConfigKey, hostConfig)
		ctx = context.WithValue(ctx, pathRemainderKey, remainder)
		ctx = context.WithValue(ctx, tokenKey, token)
		r = r.WithContext(ctx)

		rec := &statusRecorder{ResponseWriter: w}
		proxy.ServeHTTP(rec, r)
		logRequest(r, rec.status, start, host)
	})
}

func ValidateGitAuthConfig() error {
	ghToken := os.Getenv("GH_TOKEN")
	glToken := os.Getenv("GITLAB_TOKEN")
	glUsername := os.Getenv("GL_USERNAME")

	if glToken != "" && glUsername == "" {
		return fmt.Errorf("GL_USERNAME is required when GITLAB_TOKEN is set")
	}

	if glUsername != "" && glToken == "" {
		return fmt.Errorf("GITLAB_TOKEN is required when GL_USERNAME is set")
	}

	hasGitHub := ghToken != ""
	hasGitLab := glToken != "" && glUsername != ""

	if !hasGitHub && !hasGitLab {
		return fmt.Errorf("at least one git host must be configured: set GH_TOKEN or (GITLAB_TOKEN and GL_USERNAME)")
	}

	return nil
}

// PerHostTransportManager caches and manages http.Transport instances per backend host.
type PerHostTransportManager struct {
	mu           sync.Mutex
	transports   map[string]*http.Transport
	hostRegistry map[string]*GitHost
}

func NewPerHostTransportManager(hosts map[string]*GitHost) *PerHostTransportManager {
	return &PerHostTransportManager{
		transports:   make(map[string]*http.Transport),
		hostRegistry: hosts,
	}
}

// RoundTrip intercepts the request, determines the target host, and routes it
// through a Transport configured specifically for that host.
func (m *PerHostTransportManager) RoundTrip(req *http.Request) (*http.Response, error) {
	host := req.URL.Host

	m.mu.Lock()
	tr, exists := m.transports[host]
	if !exists {
		// Build a custom TLS config dynamically based on the target host
		tlsConfig := m.getTLSConfigForHost(host)

		tr = &http.Transport{
			TLSClientConfig:     tlsConfig,
			MaxIdleConns:        100,
			MaxIdleConnsPerHost: 10,
		}
		m.transports[host] = tr
	}
	m.mu.Unlock()

	return tr.RoundTrip(req)
}

// getTLSConfigForHost defines your custom rules per backend host
func (m *PerHostTransportManager) getTLSConfigForHost(host string) *tls.Config {

	tlsConfig := tls.Config{
		MinVersion: tls.VersionTLS12,
	}

	matchedHost, exists := m.hostRegistry[host]
	if !exists {
		return &tlsConfig
	}

	tlsConfig.InsecureSkipVerify = matchedHost.TLSInsecureSkipVerify

	return &tlsConfig
}

func getEnvAsBool(envVar string, defaultValue bool) bool {
	valStr := os.Getenv(envVar)
	if valStr == "" {
		return defaultValue
	}

	val, err := strconv.ParseBool(valStr)
	if err != nil {
		return defaultValue
	}

	return val
}
