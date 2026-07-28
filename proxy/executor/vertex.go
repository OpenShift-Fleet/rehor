package executor

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

func NewTokenSource(ctx context.Context) (oauth2.TokenSource, error) {
	creds, err := google.FindDefaultCredentials(ctx,
		"https://www.googleapis.com/auth/cloud-platform")
	if err != nil {
		return nil, fmt.Errorf("GCP credentials: %w", err)
	}
	return creds.TokenSource, nil
}

func NewVertexProxy(projectID, region string, ts oauth2.TokenSource, policy *VertexPolicy) http.Handler {
	var upstreamURL string
	if region == "global" {
		upstreamURL = "https://aiplatform.googleapis.com"
	} else {
		upstreamURL = fmt.Sprintf("https://%s-aiplatform.googleapis.com", region)
	}
	upstream, _ := url.Parse(upstreamURL)

	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(upstream)
			path := r.In.URL.Path
			if !strings.HasPrefix(path, "/v1/") {
				path = "/v1" + path
			}
			r.Out.URL.Path = rewritePath(path, projectID, region)
			r.Out.URL.RawQuery = r.In.URL.RawQuery
			r.Out.Host = upstream.Host

			tok, err := ts.Token()
			if err != nil {
				log.Printf("vertex: token error: %v", err)
				return
			}
			r.Out.Header.Set("Authorization", "Bearer "+tok.AccessToken)
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
		model, method, err := ExtractModel(r.URL.Path)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusBadRequest)
			log.Printf("vertex: bad-request path=%s err=%s", r.URL.Path, err)
			return
		}
		if err := policy.Check(model); err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusForbidden)
			log.Printf("vertex: policy-deny model=%s", model)
			return
		}

		rec := &statusRecorder{ResponseWriter: w}
		proxy.ServeHTTP(rec, r)

		log.Printf("vertex: model=%s method=%s status=%d size=%d dur=%s",
			model, method, rec.status, r.ContentLength,
			time.Since(start).Round(time.Millisecond))
	})

	return mux
}

func rewritePath(path, projectID, region string) string {
	parts := strings.Split(path, "/")
	for i, p := range parts {
		if p == "projects" && i+1 < len(parts) {
			parts[i+1] = projectID
		}
		if p == "locations" && i+1 < len(parts) {
			parts[i+1] = region
		}
	}
	return strings.Join(parts, "/")
}
