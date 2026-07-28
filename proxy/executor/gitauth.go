package executor

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"strings"
	"time"
)

type GitHost struct {
	Scheme   string
	Host     string
	AuthType string
	Token    func() string
	Username func() string
}

func defaultHostRegistry() map[string]*GitHost {
	return map[string]*GitHost{
		"github.com": {
			Scheme:   "https",
			Host:     "github.com",
			AuthType: "bearer",
			Token:    func() string { return os.Getenv("GH_TOKEN") },
			Username: nil,
		},
		"gitlab.cee.redhat.com": {
			Scheme:   "https",
			Host:     "gitlab.cee.redhat.com",
			AuthType: "basic",
			Token:    func() string { return os.Getenv("GITLAB_TOKEN") },
			Username: func() string { return os.Getenv("GL_USERNAME") },
		},
	}
}

func NewGitAuthProxy() http.Handler {
	return newGitAuthProxyWithRegistry(defaultHostRegistry())
}

type contextKey string

const (
	hostConfigKey contextKey = "hostConfig"
	pathRemainderKey contextKey = "pathRemainder"
	tokenKey contextKey = "token"
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

			if hostConfig.AuthType == "bearer" {
				r.Out.Header.Set("Authorization", "Bearer "+token)
			} else if hostConfig.AuthType == "basic" {
				if hostConfig.Username == nil {
					return
				}
				username := hostConfig.Username()
				basicAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+token))
				r.Out.Header.Set("Authorization", basicAuth)
			}
		},
		FlushInterval: -1,
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
			http.Error(w, "forbidden: path traversal detected", http.StatusForbidden)
			log.Printf("gitauth: method=%s path=%s status=%d dur=%s",
				r.Method, inPath, http.StatusForbidden,
				time.Since(start).Round(time.Millisecond))
			return
		}

		parts := strings.SplitN(strings.TrimPrefix(cleanPath, "/"), "/", 2)
		if len(parts) < 2 || parts[1] == "" {
			http.Error(w, "bad request: no host in path", http.StatusBadRequest)
			log.Printf("gitauth: method=%s path=%s status=%d dur=%s",
				r.Method, inPath, http.StatusBadRequest,
				time.Since(start).Round(time.Millisecond))
			return
		}

		host := parts[0]
		remainder := "/" + parts[1]

		hostConfig, ok := hostRegistry[host]
		if !ok {
			if !strings.Contains(host, ".") {
				http.Error(w, "bad request: no host in path", http.StatusBadRequest)
				log.Printf("gitauth: method=%s path=%s status=%d dur=%s",
					r.Method, inPath, http.StatusBadRequest,
					time.Since(start).Round(time.Millisecond))
				return
			}
			http.Error(w, "forbidden: unknown host", http.StatusForbidden)
			log.Printf("gitauth: method=%s host=%s path=%s status=%d dur=%s",
				r.Method, host, inPath, http.StatusForbidden,
				time.Since(start).Round(time.Millisecond))
			return
		}

		token := hostConfig.Token()
		if token == "" {
			http.Error(w, "service unavailable: missing token", http.StatusServiceUnavailable)
			log.Printf("gitauth: method=%s host=%s path=%s status=%d dur=%s",
				r.Method, host, inPath, http.StatusServiceUnavailable,
				time.Since(start).Round(time.Millisecond))
			return
		}

		ctx := context.WithValue(r.Context(), hostConfigKey, hostConfig)
		ctx = context.WithValue(ctx, pathRemainderKey, remainder)
		ctx = context.WithValue(ctx, tokenKey, token)
		r = r.WithContext(ctx)

		rec := &statusRecorder{ResponseWriter: w}
		proxy.ServeHTTP(rec, r)
		log.Printf("gitauth: method=%s host=%s path=%s status=%d dur=%s",
			r.Method, host, inPath, rec.status,
			time.Since(start).Round(time.Millisecond))
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
