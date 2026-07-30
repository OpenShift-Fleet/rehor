package executor

import (
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"
)

func NewGlitchTipProxy(glitchtipURL, token string) http.Handler {
	upstream, err := url.Parse(glitchtipURL)
	if err != nil {
		log.Fatalf("glitchtip: invalid URL %q: %v", glitchtipURL, err)
	}

	bearerAuth := "Bearer " + token

	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(upstream)
			r.Out.URL.Path = r.In.URL.Path
			r.Out.URL.RawQuery = r.In.URL.RawQuery
			r.Out.Host = upstream.Host
			r.Out.Header.Set("Authorization", bearerAuth)
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
		log.Printf("glitchtip: method=%s path=%s status=%d dur=%s",
			r.Method, r.URL.Path, rec.status,
			time.Since(start).Round(time.Millisecond))
	})

	return mux
}

func ValidateGlitchTipConfig(glitchtipURL, token string) error {
	if glitchtipURL == "" {
		return fmt.Errorf("GLITCHTIP_URL is required")
	}
	if token == "" {
		return fmt.Errorf("GLITCHTIP_TOKEN is required")
	}
	return nil
}
