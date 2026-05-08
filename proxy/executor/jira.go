package executor

import (
	"encoding/base64"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"
)

func NewJiraProxy(jiraURL, username, token string) http.Handler {
	upstream, err := url.Parse(jiraURL)
	if err != nil {
		log.Fatalf("jira: invalid URL %q: %v", jiraURL, err)
	}

	basicAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+token))

	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(upstream)
			r.Out.URL.Path = r.In.URL.Path
			r.Out.URL.RawQuery = r.In.URL.RawQuery
			r.Out.Host = upstream.Host
			r.Out.Header.Set("Authorization", basicAuth)
		},
		FlushInterval: -1,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		proxy.ServeHTTP(rec, r)
		log.Printf("jira: method=%s path=%s status=%d dur=%s",
			r.Method, r.URL.Path, rec.status,
			time.Since(start).Round(time.Millisecond))
	})

	return mux
}

func ValidateJiraConfig(jiraURL, username, token string) error {
	if jiraURL == "" {
		return fmt.Errorf("JIRA_URL is required")
	}
	if username == "" {
		return fmt.Errorf("JIRA_USERNAME is required")
	}
	if token == "" {
		return fmt.Errorf("JIRA_API_TOKEN is required")
	}
	return nil
}
