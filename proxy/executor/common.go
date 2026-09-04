package executor

import (
	"net/http"
	"strings"
)

// statusRecorder wraps http.ResponseWriter to capture the status code.
// Used by proxy handlers for logging the HTTP status code after ServeHTTP completes.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

func stripSensitiveResponseHeaders(resp *http.Response) error {
	resp.Header.Del("Authorization")
	resp.Header.Del("Set-Cookie")
	resp.Header.Del("WWW-Authenticate")
	for k := range resp.Header {
		ck := http.CanonicalHeaderKey(k)
		if strings.HasPrefix(ck, "X-") && strings.Contains(ck, "Token") {
			resp.Header.Del(k)
		}
	}
	return nil
}
