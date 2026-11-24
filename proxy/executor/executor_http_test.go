package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	pb "github.com/RedHatInsights/platform-frontend-ai-dev/proxy/executor/gen"
	"google.golang.org/protobuf/proto"
)

// fakeExecutorBackend records requests and returns a scripted response.
type fakeExecutorBackend struct {
	mu      sync.Mutex
	calls   int
	lastReq *pb.ExecuteRequest
	lastCtx context.Context
	resp    *pb.ExecuteResponse
	err     error
	// blockUntilCanceled makes Execute wait for ctx cancellation.
	blockUntilCanceled bool
	// canceled is closed when Execute observes ctx cancellation.
	canceled chan struct{}
}

func (f *fakeExecutorBackend) Execute(ctx context.Context, req *pb.ExecuteRequest) (*pb.ExecuteResponse, error) {
	f.mu.Lock()
	f.calls++
	f.lastReq = req
	f.lastCtx = ctx
	resp, err, block, canceled := f.resp, f.err, f.blockUntilCanceled, f.canceled
	f.mu.Unlock()

	if block {
		<-ctx.Done()
		if canceled != nil {
			close(canceled)
		}
		return nil, ctx.Err()
	}
	return resp, err
}

func (f *fakeExecutorBackend) requestCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func doExecutorHTTP(t *testing.T, handler http.Handler, method, path, contentType string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "http://127.0.0.1:8455"+path, strings.NewReader(string(body)))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func executorHTTPErrorBody(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var parsed struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("error body is not JSON: %q", rec.Body.String())
	}
	return parsed.Error
}

func TestExecutorHTTPHandler_ValidRequestResponse(t *testing.T) {
	backend := &fakeExecutorBackend{
		resp: &pb.ExecuteResponse{Stdout: "out", Stderr: "err", ExitCode: 3},
	}
	handler := NewExecutorHTTPHandler(backend)

	body := []byte(`{"tool":"gh","args":["issue","list"],"stdin":"aGVsbG8="}`)
	rec := doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", "application/json", body)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("response content-type = %q", got)
	}

	// The backend received the decoded request.
	if backend.requestCount() != 1 {
		t.Fatalf("backend calls = %d, want 1", backend.requestCount())
	}
	if backend.lastReq.Tool != "gh" || len(backend.lastReq.Args) != 2 || backend.lastReq.Args[0] != "issue" {
		t.Errorf("request = %+v", backend.lastReq)
	}
	if string(backend.lastReq.Stdin) != "hello" {
		t.Errorf("stdin = %q, want base64-decoded %q", backend.lastReq.Stdin, "hello")
	}

	// Response uses the exact generated json tags.
	var raw map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("response not JSON: %q", rec.Body.String())
	}
	for _, key := range []string{"stdout", "stderr", "exit_code"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("response missing key %q: %v", key, raw)
		}
	}
	if raw["stdout"] != "out" || raw["stderr"] != "err" || raw["exit_code"] != float64(3) {
		t.Errorf("response = %v", raw)
	}
}

func TestExecutorHTTPHandler_ExactJSONShape(t *testing.T) {
	backend := &fakeExecutorBackend{resp: &pb.ExecuteResponse{Stdout: "s", Stderr: "e", ExitCode: 0}}
	handler := NewExecutorHTTPHandler(backend)

	rec := doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", "application/json",
		[]byte(`{}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	// Empty fields are omitted (omitempty on generated tags); a minimal
	// in-band denial {"stderr":"...","exit_code":1} round-trips unchanged.
	backend.resp = &pb.ExecuteResponse{Stderr: "policy denied\n", ExitCode: 1}
	rec = doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", "application/json",
		[]byte(`{"tool":"gh"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != `{"stderr":"policy denied\n","exit_code":1}` {
		t.Errorf("body = %q", rec.Body.String())
	}
}

func TestExecutorHTTPHandler_RoutingAndMethod(t *testing.T) {
	backend := &fakeExecutorBackend{resp: &pb.ExecuteResponse{}}
	handler := NewExecutorHTTPHandler(backend)

	cases := []struct {
		name       string
		method     string
		path       string
		wantStatus int
	}{
		{"wrong path", http.MethodPost, "/executor", http.StatusNotFound},
		{"trailing slash", http.MethodPost, "/executor/execute/", http.StatusNotFound},
		{"other path", http.MethodPost, "/healthz", http.StatusNotFound},
		{"get", http.MethodGet, "/executor/execute", http.StatusMethodNotAllowed},
		{"put", http.MethodPut, "/executor/execute", http.StatusMethodNotAllowed},
		{"delete", http.MethodDelete, "/executor/execute", http.StatusMethodNotAllowed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := doExecutorHTTP(t, handler, tc.method, tc.path, "application/json", []byte(`{}`))
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", tc.wantStatus, rec.Code)
			}
			if backend.requestCount() != 0 {
				t.Errorf("backend called for rejected request")
			}
			if tc.wantStatus == http.StatusMethodNotAllowed && rec.Header().Get("Allow") != http.MethodPost {
				t.Errorf("Allow header = %q", rec.Header().Get("Allow"))
			}
		})
	}
}

func TestExecutorHTTPHandler_ContentType(t *testing.T) {
	backend := &fakeExecutorBackend{resp: &pb.ExecuteResponse{}}
	handler := NewExecutorHTTPHandler(backend)

	reqBody := []byte(`{}`)
	protoBody, err := proto.Marshal(&pb.ExecuteRequest{})
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name        string
		contentType string
		body        []byte
		wantStatus  int
	}{
		{"missing", "", reqBody, http.StatusUnsupportedMediaType},
		{"text", "text/plain", reqBody, http.StatusUnsupportedMediaType},
		{"form", "application/x-www-form-urlencoded", reqBody, http.StatusUnsupportedMediaType},
		{"octet stream", "application/octet-stream", protoBody, http.StatusUnsupportedMediaType},
		{"json with charset", "application/json; charset=utf-8", reqBody, http.StatusOK},
		{"protobuf", contentTypeProtobuf, protoBody, http.StatusOK},
		{"protobuf with charset", "application/x-protobuf; charset=utf-8", protoBody, http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", tc.contentType, tc.body)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %q)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantStatus != http.StatusOK && backend.requestCount() != 0 {
				t.Errorf("backend called for rejected content type")
			}
		})
	}
}

func TestExecutorHTTPHandler_ProtobufRoundTrip(t *testing.T) {
	backend := &fakeExecutorBackend{
		resp: &pb.ExecuteResponse{Stdout: "out", Stderr: "err", ExitCode: 3},
	}
	handler := NewExecutorHTTPHandler(backend)

	reqBytes, err := proto.Marshal(&pb.ExecuteRequest{
		Tool:  "gh",
		Args:  []string{"issue", "list"},
		Stdin: []byte("hello"),
	})
	if err != nil {
		t.Fatal(err)
	}
	rec := doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", contentTypeProtobuf, reqBytes)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != contentTypeProtobuf {
		t.Errorf("response content-type = %q, want %q (must match request)", got, contentTypeProtobuf)
	}

	// Backend received the wire-decoded request.
	if backend.requestCount() != 1 {
		t.Fatalf("backend calls = %d, want 1", backend.requestCount())
	}
	if backend.lastReq.Tool != "gh" || len(backend.lastReq.Args) != 2 || string(backend.lastReq.Stdin) != "hello" {
		t.Errorf("request = %+v", backend.lastReq)
	}

	// Response is a protobuf ExecuteResponse.
	var resp pb.ExecuteResponse
	if err := proto.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response not protobuf: %v", err)
	}
	if resp.Stdout != "out" || resp.Stderr != "err" || resp.ExitCode != 3 {
		t.Errorf("response = %+v", resp.String())
	}
}

func TestExecutorHTTPHandler_ProtobufMalformed(t *testing.T) {
	backend := &fakeExecutorBackend{resp: &pb.ExecuteResponse{}}
	handler := NewExecutorHTTPHandler(backend)

	// Invalid wire bytes.
	for _, body := range [][]byte{
		{0xff, 0xff, 0xff},
		[]byte("not-protobuf"),
		{0x0a}, // truncated field header
	} {
		rec := doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", contentTypeProtobuf, body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d for body %v, want 400", rec.Code, body)
		}
		if executorHTTPErrorBody(t, rec) != executorHTTPMsgMalformed {
			t.Errorf("error = %q", executorHTTPErrorBody(t, rec))
		}
	}
	if backend.requestCount() != 0 {
		t.Errorf("backend called for malformed protobuf")
	}
}

func TestExecutorHTTPHandler_ProtobufBackendErrorSafeJSON(t *testing.T) {
	backend := &fakeExecutorBackend{
		err: errors.New("gh failed: GITLAB_TOKEN=super-secret-value"),
	}
	handler := NewExecutorHTTPHandler(backend)

	reqBytes, _ := proto.Marshal(&pb.ExecuteRequest{Tool: "gh"})
	rec := doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", contentTypeProtobuf, reqBytes)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	// Errors are safe static JSON even for protobuf requests.
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("error content-type = %q, want application/json", got)
	}
	if executorHTTPErrorBody(t, rec) != executorHTTPMsgExecutorError {
		t.Errorf("error = %q", executorHTTPErrorBody(t, rec))
	}
	if strings.Contains(rec.Body.String(), "super-secret-value") {
		t.Errorf("response leaks credential: %q", rec.Body.String())
	}
}

// TestExecutorHTTPHandler_WireCapBoundary verifies the compatibility
// requirement: a ~3.9 MiB stdin payload whose protobuf wire form fits the
// 4 MiB cap must survive over x-protobuf, while the same logical request in
// JSON mode exceeds the cap because base64 inflates the body by ~4/3.
func TestExecutorHTTPHandler_WireCapBoundaryStdin(t *testing.T) {
	stdin := bytes.Repeat([]byte{0x41}, int(maxExecutorHTTPRequestBytes*19/20)) // ~3.9 MiB
	reqBytes, err := proto.Marshal(&pb.ExecuteRequest{Tool: "gh", Stdin: stdin})
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(reqBytes)) > maxExecutorHTTPRequestBytes {
		t.Fatalf("test setup: protobuf request %d bytes exceeds cap", len(reqBytes))
	}

	backend := &fakeExecutorBackend{resp: &pb.ExecuteResponse{ExitCode: 0}}
	handler := NewExecutorHTTPHandler(backend)

	// Canonical protobuf: fits the wire cap.
	rec := doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", contentTypeProtobuf, reqBytes)
	if rec.Code != http.StatusOK {
		t.Fatalf("protobuf status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	if !bytes.Equal(backend.lastReq.Stdin, stdin) {
		t.Errorf("backend stdin mismatch: got %d bytes, want %d", len(backend.lastReq.Stdin), len(stdin))
	}

	// JSON debug mode: base64 inflation pushes the same payload over the cap.
	jsonBody, err := json.Marshal(&pb.ExecuteRequest{Tool: "gh", Stdin: stdin})
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(jsonBody)) <= maxExecutorHTTPRequestBytes {
		t.Fatalf("test setup: JSON body %d bytes unexpectedly fits cap", len(jsonBody))
	}
	rec = doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", "application/json", jsonBody)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("json status = %d, want 413", rec.Code)
	}
}

// TestExecutorHTTPHandler_WireCapBoundaryEscapedStdout verifies that stdout
// near the 4 MiB cap survives over x-protobuf while JSON escaping (each
// backslash doubles) pushes the encoded response over the cap in JSON mode.
func TestExecutorHTTPHandler_WireCapBoundaryEscapedStdout(t *testing.T) {
	stdout := strings.Repeat("\\", int(maxExecutorHTTPResponseBytes*19/20)) // ~3.9 MiB of backslashes
	backend := &fakeExecutorBackend{resp: &pb.ExecuteResponse{Stdout: stdout, ExitCode: 0}}
	handler := NewExecutorHTTPHandler(backend)

	// Canonical protobuf: wire response fits the cap.
	rec := doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", contentTypeProtobuf,
		mustProtoMarshal(t, &pb.ExecuteRequest{Tool: "gh"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("protobuf status = %d, want 200", rec.Code)
	}
	var resp pb.ExecuteResponse
	if err := proto.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response not protobuf: %v", err)
	}
	if resp.Stdout != stdout {
		t.Errorf("stdout mismatch: got %d chars, want %d", len(resp.Stdout), len(stdout))
	}

	// JSON debug mode: escaping doubles the encoded size past the cap; the
	// safe response-too-large error replaces the output (never truncated).
	jsonEncoded, err := json.Marshal(backend.resp)
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(jsonEncoded)) <= maxExecutorHTTPResponseBytes {
		t.Fatalf("test setup: JSON response %d bytes unexpectedly fits cap", len(jsonEncoded))
	}
	rec = doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", "application/json",
		[]byte(`{"tool":"gh"}`))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("json status = %d, want 500", rec.Code)
	}
	if executorHTTPErrorBody(t, rec) != executorHTTPMsgResponseTooLarge {
		t.Errorf("error = %q", executorHTTPErrorBody(t, rec))
	}
	if strings.Contains(rec.Body.String(), "\\\\") {
		t.Errorf("response contains truncated output")
	}
}

func TestExecutorHTTPHandler_ProtobufOverCapRejected(t *testing.T) {
	backend := &fakeExecutorBackend{resp: &pb.ExecuteResponse{}}
	handler := NewExecutorHTTPHandler(backend)

	// Request wire bytes just over the cap.
	stdin := bytes.Repeat([]byte{0x41}, int(maxExecutorHTTPRequestBytes))
	reqBytes, err := proto.Marshal(&pb.ExecuteRequest{Tool: "gh", Stdin: stdin})
	if err != nil {
		t.Fatal(err)
	}
	rec := doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", contentTypeProtobuf, reqBytes)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	if backend.requestCount() != 0 {
		t.Errorf("backend called for oversized body")
	}

	// Response wire bytes just over the cap.
	backend.resp = &pb.ExecuteResponse{Stdout: strings.Repeat("x", int(maxExecutorHTTPResponseBytes))}
	rec = doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", contentTypeProtobuf,
		mustProtoMarshal(t, &pb.ExecuteRequest{Tool: "gh"}))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if executorHTTPErrorBody(t, rec) != executorHTTPMsgResponseTooLarge {
		t.Errorf("error = %q", executorHTTPErrorBody(t, rec))
	}
}

func mustProtoMarshal(t *testing.T, m proto.Message) []byte {
	t.Helper()
	b, err := proto.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestExecutorHTTPHandler_MalformedBodies(t *testing.T) {
	backend := &fakeExecutorBackend{resp: &pb.ExecuteResponse{}}
	handler := NewExecutorHTTPHandler(backend)

	cases := map[string]string{
		"invalid json":     `{not json`,
		"unknown field":    `{"tool":"gh","extra":"x"}`,
		"trailing data":    `{"tool":"gh"} {"tool":"gh"}`,
		"trailing garbage": `{"tool":"gh"} trailing`,
		"wrong type args":  `{"tool":"gh","args":"not-an-array"}`,
		"wrong type stdin": `{"tool":"gh","stdin":123}`,
		"json array":       `[]`,
		"json string":      `"str"`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			rec := doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", "application/json", []byte(body))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
			}
			if executorHTTPErrorBody(t, rec) != executorHTTPMsgMalformed {
				t.Errorf("error = %q, want static malformed message", executorHTTPErrorBody(t, rec))
			}
			if backend.requestCount() != 0 {
				t.Errorf("backend called for malformed body")
			}
		})
	}
}

func TestExecutorHTTPHandler_RequestTooLarge(t *testing.T) {
	backend := &fakeExecutorBackend{resp: &pb.ExecuteResponse{}}
	handler := NewExecutorHTTPHandler(backend)

	// Valid JSON padded past the 4 MiB request bound.
	big := append([]byte(`{"tool":"gh","args":["`), make([]byte, maxExecutorHTTPRequestBytes)...)
	big = append(big, []byte(`"]}`)...)
	rec := doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", "application/json", big)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	if executorHTTPErrorBody(t, rec) != executorHTTPMsgBodyTooLarge {
		t.Errorf("error = %q", executorHTTPErrorBody(t, rec))
	}
	if backend.requestCount() != 0 {
		t.Errorf("backend called for oversized body")
	}
	// The bound is inclusive: a body of exactly the limit is parsed.
	pad := strings.Repeat("a", maxExecutorHTTPRequestBytes-len(`{"tool":"gh","args":["`)-len(`"]}`))
	exact := []byte(`{"tool":"gh","args":["` + pad + `"]}`)
	if int64(len(exact)) != maxExecutorHTTPRequestBytes {
		t.Fatalf("test body construction: got %d bytes, want %d", len(exact), maxExecutorHTTPRequestBytes)
	}
	rec = doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", "application/json", exact)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d for max-size body, want 200", rec.Code)
	}
}

func TestExecutorHTTPHandler_BackendErrorSafe(t *testing.T) {
	// The underlying error quotes material that must never reach clients.
	backend := &fakeExecutorBackend{
		err: errors.New("gh failed: GITLAB_TOKEN=super-secret-value at /run/secrets"),
	}
	handler := NewExecutorHTTPHandler(backend)

	rec := doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", "application/json",
		[]byte(`{"tool":"gh","args":["secret-arg"]}`))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	msg := executorHTTPErrorBody(t, rec)
	if msg != executorHTTPMsgExecutorError {
		t.Errorf("error = %q, want static executor error", msg)
	}
	for _, leak := range []string{"super-secret-value", "GITLAB_TOKEN", "secret-arg", "gh failed"} {
		if strings.Contains(rec.Body.String(), leak) {
			t.Errorf("response leaks %q: %q", leak, rec.Body.String())
		}
	}
}

func TestExecutorHTTPHandler_ResponseTooLarge(t *testing.T) {
	backend := &fakeExecutorBackend{
		resp: &pb.ExecuteResponse{Stdout: strings.Repeat("x", maxExecutorHTTPResponseBytes)},
	}
	handler := NewExecutorHTTPHandler(backend)

	rec := doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", "application/json",
		[]byte(`{"tool":"gh"}`))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	msg := executorHTTPErrorBody(t, rec)
	if msg != executorHTTPMsgResponseTooLarge {
		t.Errorf("error = %q, want static response-too-large message", msg)
	}
	// Not truncated: the failure body is the safe error, never partial output.
	if strings.Contains(rec.Body.String(), "xxxx") {
		t.Errorf("response contains truncated command output")
	}
}

func TestExecutorHTTPHandler_ContextCancellationPropagated(t *testing.T) {
	canceled := make(chan struct{})
	backend := &fakeExecutorBackend{blockUntilCanceled: true, canceled: canceled}
	handler := NewExecutorHTTPHandler(backend)

	srv := httptest.NewServer(handler)
	defer srv.Close()

	reqCtx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, srv.URL+"/executor/execute",
		strings.NewReader(`{"tool":"gh"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")

	errCh := make(chan error, 1)
	go func() {
		resp, err := srv.Client().Do(req)
		if err == nil {
			resp.Body.Close()
		}
		errCh <- err
	}()

	// Cancel mid-request; the backend must observe cancellation.
	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case <-canceled:
	case <-time.After(5 * time.Second):
		t.Fatal("backend did not observe context cancellation")
	}
	if err := <-errCh; err == nil {
		t.Fatal("expected client-side error after cancellation")
	}
	if backend.requestCount() != 1 {
		t.Errorf("backend calls = %d, want 1", backend.requestCount())
	}
}

func TestExecutorHTTPHandler_RequestBodyNotEchoed(t *testing.T) {
	// Even for malformed requests, nothing from the body appears in errors.
	backend := &fakeExecutorBackend{resp: &pb.ExecuteResponse{}}
	handler := NewExecutorHTTPHandler(backend)

	secret := "bearer-token-should-not-appear"
	rec := doExecutorHTTP(t, handler, http.MethodPost, "/executor/execute", "application/json",
		[]byte(`{"tool":"`+secret+`","unknown":"`+secret+`"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if strings.Contains(rec.Body.String(), secret) {
		t.Errorf("error body echoes request content: %q", rec.Body.String())
	}
}

// Compile-time checks: the anonymous handler type matches the generated
// ExecutorServer method set, so the existing gRPC service implementation can
// be passed straight to NewExecutorHTTPHandler.
var _ interface {
	Execute(context.Context, *pb.ExecuteRequest) (*pb.ExecuteResponse, error)
} = (pb.ExecutorServer)(nil)
