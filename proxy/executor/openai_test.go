package executor

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// newTestOpenAI wires the gateway to a local httptest upstream, bypassing the
// api.openai.com host check in NewOpenAIProxy (gitauth ctor pattern).
func newTestOpenAI(t *testing.T, upstream http.Handler, models []string) http.Handler {
	t.Helper()
	srv := httptest.NewServer(upstream)
	t.Cleanup(srv.Close)
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return newOpenAIProxy(openaiProxyConfig{
		APIKey:    "proxy-key-abc",
		Policy:    NewOpenAIPolicy(models),
		Upstream:  u,
		Transport: srv.Client().Transport,
	})
}

// unreachableUpstream fails the test if the gateway forwards a request it
// should have rejected locally.
func unreachableUpstream(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("upstream must not be called, got %s %s", r.Method, r.URL.Path)
	})
}

const chatBody = `{"model":"gpt-5.6-luna","messages":[{"role":"user","content":"hi"}]}`

func TestOpenAIHealthz(t *testing.T) {
	handler := newTestOpenAI(t, unreachableUpstream(t), []string{"gpt-5.6-luna"})

	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("/healthz status = %d, want 200", w.Code)
	}
}

func TestOpenAIBlockedModel(t *testing.T) {
	handler := newTestOpenAI(t, unreachableUpstream(t), []string{"gpt-5.6-luna"})

	body := `{"model":"not-allowed","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("blocked model status = %d, want 403", w.Code)
	}
	if !contains(w.Body.String(), "model not allowed") {
		t.Errorf("body = %q, want it to mention 'model not allowed'", w.Body.String())
	}
}

func TestOpenAIBadBody(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"invalid JSON", `{"model":`},
		{"missing model", `{"messages":[]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handler := newTestOpenAI(t, unreachableUpstream(t), []string{"gpt-5.6-luna"})

			req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(tc.body))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if w.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400", w.Code)
			}
		})
	}
}

func TestOpenAIRejectsUnknownRoutes(t *testing.T) {
	cases := []struct {
		method string
		path   string
	}{
		{"POST", "/v1/embeddings"},
		{"POST", "/v1/completions"},
		{"GET", "/v1/responses"},
		{"DELETE", "/v1/responses"},
		{"POST", "/v1/models"},
		{"GET", "/v1/chat/completions"},
		{"DELETE", "/v1/chat/completions"},
		{"GET", "/"},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			handler := newTestOpenAI(t, unreachableUpstream(t), []string{"gpt-5.6-luna"})

			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(chatBody))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if w.Code != http.StatusNotFound {
				t.Errorf("%s %s status = %d, want 404", tc.method, tc.path, w.Code)
			}
			if !contains(w.Body.String(), "path not allowed") {
				t.Errorf("body = %q, want it to mention 'path not allowed'", w.Body.String())
			}
		})
	}
}

func TestOpenAIAllowedModelForwarded(t *testing.T) {
	var gotPath, gotQuery, gotBody string
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusOK)
	})
	handler := newTestOpenAI(t, upstream, []string{"gpt-5.6-luna"})

	req := httptest.NewRequest("POST", "/v1/chat/completions?debug=1", strings.NewReader(chatBody))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	// No double /v1 — Vertex prepends one, OpenAI must not.
	if gotPath != "/v1/chat/completions" {
		t.Errorf("upstream path = %q, want /v1/chat/completions", gotPath)
	}
	if gotQuery != "debug=1" {
		t.Errorf("upstream query = %q, want debug=1", gotQuery)
	}
	// The handler reads the body to find the model; upstream must still get it.
	if gotBody != chatBody {
		t.Errorf("upstream body = %q, want %q", gotBody, chatBody)
	}
}

func TestOpenAIStolenAuthNotForwarded(t *testing.T) {
	var gotAuth, gotOrg, gotProject string
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotOrg = r.Header.Get("OpenAI-Organization")
		gotProject = r.Header.Get("OpenAI-Project")
		w.WriteHeader(http.StatusOK)
	})
	handler := newTestOpenAI(t, upstream, []string{"gpt-5.6-luna"})

	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(chatBody))
	req.Header.Set("Authorization", "Bearer steal-me")
	req.Header.Set("OpenAI-Organization", "org-attacker")
	req.Header.Set("OpenAI-Project", "proj-attacker")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if gotAuth != "Bearer proxy-key-abc" {
		t.Errorf("upstream Authorization = %q, want %q", gotAuth, "Bearer proxy-key-abc")
	}
	if gotOrg != "" {
		t.Errorf("upstream OpenAI-Organization = %q, want empty", gotOrg)
	}
	if gotProject != "" {
		t.Errorf("upstream OpenAI-Project = %q, want empty", gotProject)
	}
}

func TestOpenAIOrgAndProjectInjected(t *testing.T) {
	var gotOrg, gotProject string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotOrg = r.Header.Get("OpenAI-Organization")
		gotProject = r.Header.Get("OpenAI-Project")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	handler := newOpenAIProxy(openaiProxyConfig{
		APIKey:    "proxy-key-abc",
		Policy:    NewOpenAIPolicy([]string{"gpt-5.6-luna"}),
		Upstream:  u,
		Transport: srv.Client().Transport,
		Org:       "org-rehor",
		Project:   "proj-rehor",
	})

	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(chatBody))
	req.Header.Set("OpenAI-Organization", "org-attacker")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if gotOrg != "org-rehor" {
		t.Errorf("upstream OpenAI-Organization = %q, want org-rehor", gotOrg)
	}
	if gotProject != "proj-rehor" {
		t.Errorf("upstream OpenAI-Project = %q, want proj-rehor", gotProject)
	}
}

func TestOpenAISpoofedHostIgnored(t *testing.T) {
	var gotHost string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	handler := newOpenAIProxy(openaiProxyConfig{
		APIKey:    "proxy-key-abc",
		Policy:    NewOpenAIPolicy([]string{"gpt-5.6-luna"}),
		Upstream:  u,
		Transport: srv.Client().Transport,
	})

	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(chatBody))
	req.Host = "evil.com"
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if gotHost != u.Host {
		t.Errorf("upstream Host = %q, want %q", gotHost, u.Host)
	}
}

func TestOpenAIStripsSensitiveResponseHeaders(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Authorization", "Bearer leaked-token")
		w.Header().Set("Set-Cookie", "session=secret")
		w.Header().Set("WWW-Authenticate", `Bearer realm="openai"`)
		w.Header().Set("X-Access-Token", "abc")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", "req-123")
		w.WriteHeader(http.StatusOK)
	})
	handler := newTestOpenAI(t, upstream, []string{"gpt-5.6-luna"})

	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(chatBody))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	for _, h := range []string{"Authorization", "Set-Cookie", "WWW-Authenticate", "X-Access-Token"} {
		if got := w.Header().Get(h); got != "" {
			t.Errorf("client got %s = %q, want empty", h, got)
		}
	}
	if got := w.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	// x-request-id is the debugging handle for OpenAI support; keep it.
	if got := w.Header().Get("X-Request-Id"); got != "req-123" {
		t.Errorf("X-Request-Id = %q, want req-123", got)
	}
}

const sseFixture = `data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_time","arguments":"{}"}}]}}]}

data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}

data: [DONE]

`

func TestOpenAIStreamingToolCallsPassthrough(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		for _, chunk := range strings.SplitAfter(sseFixture, "\n\n") {
			if chunk == "" {
				continue
			}
			io.WriteString(w, chunk)
			w.(http.Flusher).Flush()
		}
	})
	handler := newTestOpenAI(t, upstream, []string{"gpt-5.6-luna"})

	body := `{"model":"gpt-5.6-luna","stream":true,"stream_options":{"include_usage":true},` +
		`"tools":[{"type":"function","function":{"name":"get_time"}}],` +
		`"messages":[{"role":"user","content":"call get_time"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	if got := w.Header().Get("Content-Type"); got != "text/event-stream" {
		t.Errorf("Content-Type = %q, want text/event-stream", got)
	}
	if w.Body.String() != sseFixture {
		t.Errorf("client body =\n%q\nwant\n%q", w.Body.String(), sseFixture)
	}
	if !w.Flushed {
		t.Error("response was not flushed; SSE would be buffered until the stream ends")
	}
	if !contains(w.Body.String(), "tool_calls") {
		t.Error("tool_calls delta missing from client body")
	}
	if !contains(w.Body.String(), `"usage"`) {
		t.Error("usage chunk missing from client body")
	}
	if !contains(w.Body.String(), "[DONE]") {
		t.Error("[DONE] sentinel missing from client body")
	}
}

// TestOpenAIStreamingFlushesThroughMetricsWrapper guards the responseWriter
// Unwrap added in metrics.go: without it the SSE stream stalls in production,
// where the handler is always wrapped by InstrumentHTTPHandler.
func TestOpenAIStreamingFlushesThroughMetricsWrapper(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "data: {\"choices\":[]}\n\n")
		w.(http.Flusher).Flush()
	})
	handler := InstrumentHTTPHandler("openai", newTestOpenAI(t, upstream, []string{"gpt-5.6-luna"}))

	req := httptest.NewRequest("POST", "/v1/chat/completions",
		strings.NewReader(`{"model":"gpt-5.6-luna","stream":true}`))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if !w.Flushed {
		t.Error("stream not flushed through InstrumentHTTPHandler; responseWriter.Unwrap missing?")
	}
}

func TestOpenAIModelsListedLocally(t *testing.T) {
	handler := newTestOpenAI(t, unreachableUpstream(t), []string{"gpt-5.6-luna", "gpt-5.6-terra"})

	req := httptest.NewRequest("GET", "/v1/models", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	if got := w.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	body := w.Body.String()
	for _, want := range []string{`"object":"list"`, `"gpt-5.6-luna"`, `"gpt-5.6-terra"`} {
		if !contains(body, want) {
			t.Errorf("body = %q, want it to contain %s", body, want)
		}
	}
	// Must be the allowlist, not OpenAI's catalog.
	if contains(body, "gpt-3.5-turbo") {
		t.Errorf("body = %q, want allowlisted models only", body)
	}
}

func TestOpenAIUpstreamErrorIsGeneric(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	srv.Close() // nothing is listening now, so the proxy dial fails

	handler := newOpenAIProxy(openaiProxyConfig{
		APIKey:   "proxy-key-abc",
		Policy:   NewOpenAIPolicy([]string{"gpt-5.6-luna"}),
		Upstream: u,
	})

	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(chatBody))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", w.Code)
	}
	body := w.Body.String()
	if !contains(body, "upstream unavailable") {
		t.Errorf("body = %q, want 'upstream unavailable'", body)
	}
	// The generic error must not leak the key or the upstream address.
	if contains(body, "proxy-key-abc") || contains(body, u.Host) {
		t.Errorf("body = %q, must not leak the API key or upstream host", body)
	}
}
