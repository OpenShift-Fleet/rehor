package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"

	pb "github.com/RedHatInsights/platform-frontend-ai-dev/proxy/executor/gen"
	"google.golang.org/protobuf/proto"
)

// HTTP transport for the executor, served on the shared internal listener
// (same 9090/unix listener as the gRPC service, behind the same legacy
// Service and NetworkPolicy). No new public listener is introduced; external
// caller authentication is owned by the OAuth gateway in front of the shared
// Route. This handler performs no authentication of its own.
//
// Two encodings share one endpoint, POST /executor/execute:
//
//   - application/x-protobuf (canonical): raw protobuf wire format with the
//     same 4 MiB receive cap as the gRPC default, so existing ~4 MiB payload
//     envelopes survive unchanged (JSON base64/escaping inflation would
//     otherwise shrink them).
//   - application/json (debug): encoding/json over the generated protobuf
//     structs, field names from their json tags:
//     {"tool":"gh","args":["..."],"stdin":"<base64>"} ->
//     {"stdout":"...","stderr":"...","exit_code":0}. Base64 and JSON
//     escaping make this mode stricter than the wire cap.
//
// The response Content-Type always matches the request's encoding. Errors
// are always safe static JSON, independent of the request encoding. Policy
// and execution are entirely delegated to the provided Execute
// implementation — this transport adds no command policy of its own.

const (
	executorHTTPPath = "/executor/execute"

	contentTypeJSON     = "application/json"
	contentTypeProtobuf = "application/x-protobuf"

	// maxExecutorHTTPRequestBytes bounds the raw request body (wire bytes
	// for protobuf, encoded bytes for JSON) — the same 4 MiB default as
	// the gRPC server's receive limit.
	maxExecutorHTTPRequestBytes = 4 << 20 // 4 MiB
	// maxExecutorHTTPResponseBytes bounds the encoded response body.
	// Larger command output fails with a safe error instead of being
	// truncated.
	maxExecutorHTTPResponseBytes = 4 << 20 // 4 MiB
)

// Static response texts: never include request bodies, command output, or
// underlying executor errors (which could carry vendor/CLI credential
// material from the proxy's environment).
const (
	executorHTTPMsgNotFound         = "not found"
	executorHTTPMsgMethodNotAllowed = "method not allowed"
	executorHTTPMsgBadContentType   = "content-type must be application/x-protobuf or application/json"
	executorHTTPMsgBodyTooLarge     = "request body too large"
	executorHTTPMsgMalformed        = "malformed request body"
	executorHTTPMsgExecutorError    = "executor error"
	executorHTTPMsgResponseTooLarge = "executor response too large"
)

// NewExecutorHTTPHandler returns an http.Handler exposing the provided
// Execute implementation over the HTTP transport described above. The
// handler interface matches pb.ExecutorServer's Execute method, so the
// existing gRPC service implementation (and its policy) can be reused
// unchanged.
func NewExecutorHTTPHandler(handler interface {
	Execute(context.Context, *pb.ExecuteRequest) (*pb.ExecuteResponse, error)
}) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveExecutorHTTP(w, r, handler)
	})
}

func serveExecutorHTTP(w http.ResponseWriter, r *http.Request, handler interface {
	Execute(context.Context, *pb.ExecuteRequest) (*pb.ExecuteResponse, error)
}) {
	if r.URL.Path != executorHTTPPath {
		writeExecutorHTTPError(w, http.StatusNotFound, executorHTTPMsgNotFound)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeExecutorHTTPError(w, http.StatusMethodNotAllowed, executorHTTPMsgMethodNotAllowed)
		return
	}

	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || (mediaType != contentTypeProtobuf && mediaType != contentTypeJSON) {
		writeExecutorHTTPError(w, http.StatusUnsupportedMediaType, executorHTTPMsgBadContentType)
		return
	}

	// Bound the raw request body before parsing (wire bytes for protobuf,
	// encoded bytes for JSON — same 4 MiB as the gRPC receive default).
	body, err := io.ReadAll(io.LimitReader(r.Body, maxExecutorHTTPRequestBytes+1))
	r.Body.Close()
	if err != nil {
		writeExecutorHTTPError(w, http.StatusBadRequest, executorHTTPMsgMalformed)
		return
	}
	if int64(len(body)) > maxExecutorHTTPRequestBytes {
		writeExecutorHTTPError(w, http.StatusRequestEntityTooLarge, executorHTTPMsgBodyTooLarge)
		return
	}

	var req pb.ExecuteRequest
	switch mediaType {
	case contentTypeProtobuf:
		if err := proto.Unmarshal(body, &req); err != nil {
			writeExecutorHTTPError(w, http.StatusBadRequest, executorHTTPMsgMalformed)
			return
		}
	default: // contentTypeJSON
		// Strict decode: unknown fields and trailing data are rejected.
		// The generated structs carry the exact json tags (tool, args, stdin).
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			writeExecutorHTTPError(w, http.StatusBadRequest, executorHTTPMsgMalformed)
			return
		}
		if err := dec.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
			writeExecutorHTTPError(w, http.StatusBadRequest, executorHTTPMsgMalformed)
			return
		}
	}

	// Delegate policy and execution to the provided implementation. The
	// request context propagates client cancellation.
	resp, err := handler.Execute(r.Context(), &req)
	if err != nil {
		// The client is gone on cancellation; nothing useful to write.
		if errors.Is(err, context.Canceled) || errors.Is(r.Context().Err(), context.Canceled) {
			return
		}
		// Static message only: the underlying error may quote CLI output,
		// paths, or credentials held by the proxy.
		writeExecutorHTTPError(w, http.StatusInternalServerError, executorHTTPMsgExecutorError)
		return
	}

	// Encode in the request's encoding; the response Content-Type matches.
	var encoded []byte
	switch mediaType {
	case contentTypeProtobuf:
		encoded, err = proto.Marshal(resp)
	default: // contentTypeJSON
		encoded, err = json.Marshal(resp)
	}
	if err != nil {
		writeExecutorHTTPError(w, http.StatusInternalServerError, executorHTTPMsgExecutorError)
		return
	}
	if int64(len(encoded)) > maxExecutorHTTPResponseBytes {
		// Fail with a safe error rather than truncating command output.
		writeExecutorHTTPError(w, http.StatusInternalServerError, executorHTTPMsgResponseTooLarge)
		return
	}

	w.Header().Set("Content-Type", mediaType)
	w.WriteHeader(http.StatusOK)
	w.Write(encoded) //nolint:errcheck // best-effort response body
}

// writeExecutorHTTPError emits a static JSON error object regardless of the
// request encoding. Message text is always one of the constants above;
// nothing request-derived is included.
func writeExecutorHTTPError(w http.ResponseWriter, code int, msg string) {
	body, err := json.Marshal(struct {
		Error string `json:"error"`
	}{Error: msg})
	if err != nil {
		// Static messages always marshal; fall back to a fixed body anyway.
		body = []byte(`{"error":"executor error"}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	w.Write(body) //nolint:errcheck // best-effort error body
}
