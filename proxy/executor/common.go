package executor

import "net/http"

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
