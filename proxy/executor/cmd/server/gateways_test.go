package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	executor "github.com/RedHatInsights/platform-frontend-ai-dev/proxy/executor"
	pb "github.com/RedHatInsights/platform-frontend-ai-dev/proxy/executor/gen"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/proto"
)

// --- enable flag parsing ---

func TestHTTPGatewayEnabledFlag(t *testing.T) {
	cases := []struct {
		value string
		want  bool
		ok    bool
	}{
		{"", false, true},
		{"true", true, true},
		{"TRUE", true, true},
		{" True ", true, true},
		{"1", true, true},
		{"yes", true, true},
		{"on", true, true},
		{"false", false, true},
		{"0", false, true},
		{"no", false, true},
		{"off", false, true},
		{"garbage", false, false},
		{"enabled", false, false},
	}
	for _, tc := range cases {
		t.Run(fmt.Sprintf("value=%q", tc.value), func(t *testing.T) {
			t.Setenv(httpEnableEnv, tc.value)
			got, err := httpGatewayEnabled()
			if tc.ok && err != nil {
				t.Fatalf("httpGatewayEnabled(%q): unexpected error: %v", tc.value, err)
			}
			if !tc.ok {
				if err == nil {
					t.Fatalf("httpGatewayEnabled(%q): expected malformed-value error, got %v", tc.value, got)
				}
				if !strings.Contains(err.Error(), httpEnableEnv) || !strings.Contains(err.Error(), "malformed") {
					t.Fatalf("httpGatewayEnabled(%q): error should name the variable and the problem, got: %v", tc.value, err)
				}
				return
			}
			if got != tc.want {
				t.Fatalf("httpGatewayEnabled(%q) = %v, want %v", tc.value, got, tc.want)
			}
		})
	}
}

// --- executor upstream derivation ---

func TestExecutorHTTPUpstream(t *testing.T) {
	cases := []struct {
		listen string
		want   string
		ok     bool
	}{
		{":9090", "http://127.0.0.1:9090", true},
		{"0.0.0.0:9090", "http://127.0.0.1:9090", true},
		{"localhost:1234", "http://127.0.0.1:1234", true},
		{"127.0.0.1:9090", "http://127.0.0.1:9090", true},
		{"unix:///var/run/devbot/executor.sock", "", false},
		{"", "", false},
		{"9090", "", false},
	}
	for _, tc := range cases {
		t.Run(fmt.Sprintf("listen=%q", tc.listen), func(t *testing.T) {
			got, err := executorHTTPUpstream(tc.listen)
			if !tc.ok {
				if err == nil {
					t.Fatalf("executorHTTPUpstream(%q) = %q, want error", tc.listen, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("executorHTTPUpstream(%q): %v", tc.listen, err)
			}
			if got != tc.want {
				t.Fatalf("executorHTTPUpstream(%q) = %q, want %q", tc.listen, got, tc.want)
			}
		})
	}
}

// --- HTTP gateway core integration ---

func TestHTTPGatewayConfig(t *testing.T) {
	all := httpGatewayConfig(backendAvailability{Model: true, Registry: true, Vertex: true, Git: true,
		JiraREST: true, JiraMCP: true, Screenshot: true, GlitchTip: true}, "http://127.0.0.1:9090")
	if all != executor.DefaultGatewayConfig() {
		t.Fatalf("all-enabled config must equal the default loopback config, got %+v", all)
	}

	// Disabled backends are cleared so the core fails their routes closed;
	// the executor upstream (this server) is always mapped.
	avail := backendAvailability{Model: true, JiraMCP: true}
	cfg := httpGatewayConfig(avail, "http://127.0.0.1:9090")
	if cfg.Models != "http://127.0.0.1:8450" || cfg.JiraMCP != "http://127.0.0.1:8444" {
		t.Fatalf("enabled backends must keep default loopback URLs, got %+v", cfg)
	}
	if cfg.Executor != "http://127.0.0.1:9090" {
		t.Fatalf("executor upstream must be mapped, got %+v", cfg)
	}
	if cfg.Registry != "" || cfg.Vertex != "" || cfg.Git != "" || cfg.JiraREST != "" ||
		cfg.Screenshots != "" || cfg.GlitchTip != "" {
		t.Fatalf("disabled backends must be cleared, got %+v", cfg)
	}

	// With no vendor backends the executor-only mapping still builds.
	if _, err := executor.NewHTTPGateway(httpGatewayConfig(backendAvailability{}, "http://127.0.0.1:9090")); err != nil {
		t.Fatalf("executor-only mapping must build: %v", err)
	}
	// An entirely empty mapping is still rejected by the core.
	if _, err := executor.NewHTTPGateway(httpGatewayConfig(backendAvailability{}, "")); err == nil {
		t.Fatal("empty backend mapping must fail")
	}
}

func TestHTTPGatewayHandlerIntegration(t *testing.T) {
	var gotAuth, gotPath string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("backend-ok"))
	}))
	defer backend.Close()

	cfg := httpGatewayConfig(backendAvailability{Model: true}, "http://127.0.0.1:9090") // others disabled
	cfg.Models = backend.URL                                                            // point the enabled backend at the test server
	cfg.Executor = backend.URL                                                          // point the executor route at it too
	handler, err := executor.NewHTTPGateway(cfg)
	if err != nil {
		t.Fatalf("NewHTTPGateway: %v", err)
	}
	gw := httptest.NewServer(handler)
	defer gw.Close()

	// Canonical /v1 pass-through keeps the backend path grammar.
	req, _ := http.NewRequest(http.MethodGet, gw.URL+"/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer ingress-oauth-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("canonical route: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("canonical route status = %d", resp.StatusCode)
	}
	if gotPath != "/v1/chat/completions" {
		t.Fatalf("canonical route path = %q", gotPath)
	}
	if gotAuth != "" {
		t.Fatalf("ingress bearer must be consumed, backend saw %q", gotAuth)
	}

	// /models alias strips its prefix.
	resp, err = http.Get(gw.URL + "/models/list")
	if err != nil {
		t.Fatalf("alias route: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || gotPath != "/list" {
		t.Fatalf("alias route status=%d path=%q", resp.StatusCode, gotPath)
	}

	// The executor route reaches the fixed executor upstream.
	resp, err = http.Post(gw.URL+"/executor/execute", "application/json",
		strings.NewReader(`{"tool":"gh","args":["pr","list"]}`))
	if err != nil {
		t.Fatalf("executor route: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || gotPath != "/executor/execute" {
		t.Fatalf("executor route status=%d path=%q", resp.StatusCode, gotPath)
	}

	// Disabled backend routes fail closed with 503.
	resp, err = http.Get(gw.URL + "/git/info/refs")
	if err != nil {
		t.Fatalf("disabled route: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("disabled route status = %d, want 503", resp.StatusCode)
	}

	// Unknown paths fail closed with 404.
	resp, err = http.Get(gw.URL + "/unknown")
	if err != nil {
		t.Fatalf("unknown route: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown route status = %d, want 404", resp.StatusCode)
	}
}

// --- executor HTTP wrapper (REHOR-252) ---

func TestExecutorGatewayHandler(t *testing.T) {
	if _, err := executorGatewayHandler(nil); err == nil {
		t.Fatal("nil executor server must fail")
	}
	execSrv := &server{policy: executor.DefaultPolicy()}
	handler, err := executorGatewayHandler(execSrv)
	if err != nil {
		t.Fatalf("executorGatewayHandler: %v", err)
	}
	if handler == nil {
		t.Fatal("executor wrapper handler must be non-nil")
	}
}

// newDualProtocolTestServer starts one dual-protocol listener server like
// main() does and returns its address.
func newDualProtocolTestServer(t *testing.T, execSrv pb.ExecutorServer) (*http.Server, string) {
	t.Helper()
	grpcSrv := grpc.NewServer()
	pb.RegisterExecutorServer(grpcSrv, execSrv)
	execHTTP, err := executorGatewayHandler(execSrv)
	if err != nil {
		t.Fatalf("executorGatewayHandler: %v", err)
	}
	srv := &http.Server{Handler: newDualProtocolHandler(grpcSrv, execHTTP)}
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() {
		_ = srv.Serve(lis)
	}()
	t.Cleanup(func() {
		shutdownHTTPServer(srv, 2*time.Second)
		shutdownGRPCServer(grpcSrv, 2*time.Second)
	})
	return srv, lis.Addr().String()
}

// writeFakeCommand writes an executable shell script that echoes its
// arguments, cats stdin back, and exits with code exit.
func writeFakeCommand(t *testing.T, dir, prefix string, exit int) string {
	t.Helper()
	path := filepath.Join(dir, prefix)
	script := fmt.Sprintf("#!/bin/sh\necho \"args: $*\"\ncat\nexit %d\n", exit)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake binary: %v", err)
	}
	return path
}

// TestExecutorDualProtocolTCP runs one command through BOTH the legacy
// plaintext gRPC path and the HTTP wrapper on the SAME TCP listener, using
// the SAME *server.Execute handler and policy, and requires identical
// stdout, stderr, and exit_code. The command is a local fake binary; no
// real credentials or external systems are involved.
func TestExecutorDualProtocolTCP(t *testing.T) {
	dir := t.TempDir()
	fakeBin := writeFakeCommand(t, dir, "gh-fake", 7)
	execSrv := &server{
		policy:   executor.DefaultPolicy(),
		ghPath:   fakeBin,
		glabPath: fakeBin,
		gpgPath:  fakeBin,
		timeout:  10 * time.Second,
	}
	req := &pb.ExecuteRequest{
		Tool:  "gh",
		Args:  []string{"pr", "list"},
		Stdin: []byte("stdin-payload\n"),
	}

	_, addr := newDualProtocolTestServer(t, execSrv)

	// Legacy plaintext gRPC client on the same port (h2c prior knowledge).
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("grpc.NewClient: %v", err)
	}
	defer conn.Close()
	grpcResp, err := pb.NewExecutorClient(conn).Execute(context.Background(), req)
	if err != nil {
		t.Fatalf("legacy grpc Execute: %v", err)
	}
	if grpcResp.ExitCode != 7 {
		t.Fatalf("fake command exit_code = %d, want 7 (resp %+v)", grpcResp.ExitCode, grpcResp)
	}
	if !strings.Contains(grpcResp.Stdout, "args: pr list") || !strings.Contains(grpcResp.Stdout, "stdin-payload") {
		t.Fatalf("fake command stdout unexpected: %+v", grpcResp)
	}

	// HTTP wrapper client on the same port, same JSON pb contract.
	base := "http://" + addr
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	resp, err := http.Post(base+"/executor/execute", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("http wrapper execute: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("http wrapper status = %d", resp.StatusCode)
	}
	var httpResp pb.ExecuteResponse
	if err := json.NewDecoder(resp.Body).Decode(&httpResp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if httpResp.Stdout != grpcResp.Stdout || httpResp.Stderr != grpcResp.Stderr || httpResp.ExitCode != grpcResp.ExitCode {
		t.Fatalf("protocol mismatch:\ngrpc = %+v\nhttp = %+v", grpcResp, &httpResp)
	}

	// Canonical protobuf encoding on the same port: same pb contract as
	// the gRPC wire format.
	pbBody, err := proto.Marshal(req)
	if err != nil {
		t.Fatalf("marshal protobuf request: %v", err)
	}
	resp, err = http.Post(base+"/executor/execute", "application/x-protobuf", bytes.NewReader(pbBody))
	if err != nil {
		t.Fatalf("http wrapper protobuf execute: %v", err)
	}
	pbRespBody, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatalf("read protobuf response: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("http wrapper protobuf status = %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/x-protobuf" {
		t.Fatalf("protobuf response content-type = %q", ct)
	}
	var pbResp pb.ExecuteResponse
	if err := proto.Unmarshal(pbRespBody, &pbResp); err != nil {
		t.Fatalf("unmarshal protobuf response: %v", err)
	}
	if pbResp.Stdout != grpcResp.Stdout || pbResp.Stderr != grpcResp.Stderr || pbResp.ExitCode != grpcResp.ExitCode {
		t.Fatalf("protobuf protocol mismatch:\ngrpc = %+v\nhttp = %+v", grpcResp, &pbResp)
	}

	// The wrapper rejects other methods, paths, and content types with
	// safe static statuses.
	resp, err = http.Get(base + "/executor/execute")
	if err != nil {
		t.Fatalf("GET method check: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d, want 405", resp.StatusCode)
	}
	resp, err = http.Post(base+"/other", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("wrong path check: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("wrong path status = %d, want 404", resp.StatusCode)
	}
	resp, err = http.Post(base+"/executor/execute", "text/plain", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("wrong content-type check: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("wrong content-type status = %d, want 415", resp.StatusCode)
	}

	// gRPC keeps working after HTTP requests on the same listener.
	grpcResp2, err := pb.NewExecutorClient(conn).Execute(context.Background(), req)
	if err != nil {
		t.Fatalf("grpc after http: %v", err)
	}
	if grpcResp2.ExitCode != grpcResp.ExitCode || grpcResp2.Stdout != grpcResp.Stdout {
		t.Fatalf("grpc after http mismatch: %+v vs %+v", grpcResp2, grpcResp)
	}
}

// TestExecutorDualProtocolUnix verifies the same dual-protocol behavior on
// a unix-socket listener (local development EXECUTOR_LISTEN default).
func TestExecutorDualProtocolUnix(t *testing.T) {
	dir := t.TempDir()
	fakeBin := writeFakeCommand(t, dir, "gh-fake", 3)
	execSrv := &server{
		policy:   executor.DefaultPolicy(),
		ghPath:   fakeBin,
		glabPath: fakeBin,
		gpgPath:  fakeBin,
		timeout:  10 * time.Second,
	}
	req := &pb.ExecuteRequest{
		Tool:  "gh",
		Args:  []string{"pr", "view"},
		Stdin: []byte("unix-stdin\n"),
	}

	// Keep the socket path short: darwin's unix domain socket sun_path
	// limit is 104 bytes and t.TempDir() paths can exceed it.
	sockDir, err := os.MkdirTemp("/tmp", "dualproto-*")
	if err != nil {
		t.Fatalf("mkdtemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	sockPath := filepath.Join(sockDir, "executor.sock")
	lis, err := openListener("unix://" + sockPath)
	if err != nil {
		t.Fatalf("openListener: %v", err)
	}
	grpcSrv := grpc.NewServer()
	pb.RegisterExecutorServer(grpcSrv, execSrv)
	execHTTP, err := executorGatewayHandler(execSrv)
	if err != nil {
		t.Fatalf("executorGatewayHandler: %v", err)
	}
	srv := &http.Server{Handler: newDualProtocolHandler(grpcSrv, execHTTP)}
	go func() {
		_ = srv.Serve(lis)
	}()
	t.Cleanup(func() {
		shutdownHTTPServer(srv, 2*time.Second)
		shutdownGRPCServer(grpcSrv, 2*time.Second)
	})

	// Legacy gRPC client over the unix socket.
	conn, err := grpc.NewClient("unix://"+sockPath, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("grpc.NewClient unix: %v", err)
	}
	defer conn.Close()
	grpcResp, err := pb.NewExecutorClient(conn).Execute(context.Background(), req)
	if err != nil {
		t.Fatalf("grpc Execute unix: %v", err)
	}
	if grpcResp.ExitCode != 3 || !strings.Contains(grpcResp.Stdout, "args: pr view") ||
		!strings.Contains(grpcResp.Stdout, "unix-stdin") {
		t.Fatalf("unix grpc response unexpected: %+v", grpcResp)
	}

	// HTTP wrapper client over the same unix socket.
	unixClient := &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", sockPath)
			},
		},
		Timeout: 10 * time.Second,
	}
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	resp, err := unixClient.Post("http://executor.local/executor/execute", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("http wrapper unix: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("http wrapper unix status = %d", resp.StatusCode)
	}
	var httpResp pb.ExecuteResponse
	if err := json.NewDecoder(resp.Body).Decode(&httpResp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if httpResp.Stdout != grpcResp.Stdout || httpResp.Stderr != grpcResp.Stderr || httpResp.ExitCode != grpcResp.ExitCode {
		t.Fatalf("unix protocol mismatch:\ngrpc = %+v\nhttp = %+v", grpcResp, &httpResp)
	}
}

// TestExecutorDualProtocolCancel verifies client cancellation propagates
// through both transports: a slow command is aborted instead of running to
// its timeout.
func TestExecutorDualProtocolCancel(t *testing.T) {
	dir := t.TempDir()
	slowBin := filepath.Join(dir, "gh-slow")
	// exec sleep: the shell replaces itself so a context kill always lands
	// on sleep itself and cannot orphan a child holding the output pipes.
	script := "#!/bin/sh\necho started\nexec sleep 30\n"
	if err := os.WriteFile(slowBin, []byte(script), 0o755); err != nil {
		t.Fatalf("write slow binary: %v", err)
	}
	execSrv := &server{
		policy:   executor.DefaultPolicy(),
		ghPath:   slowBin,
		glabPath: slowBin,
		gpgPath:  slowBin,
		timeout:  60 * time.Second,
	}
	req := &pb.ExecuteRequest{Tool: "gh", Args: []string{"pr", "list"}}

	_, addr := newDualProtocolTestServer(t, execSrv)

	// gRPC: cancel the RPC context mid-command.
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(200 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("grpc.NewClient: %v", err)
	}
	defer conn.Close()
	_, err = pb.NewExecutorClient(conn).Execute(ctx, req)
	if err == nil {
		t.Fatal("canceled grpc call must fail")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("grpc cancellation took %s; command was not aborted", elapsed)
	}

	// HTTP: cancel the request context mid-command.
	ctx2, cancel2 := context.WithCancel(context.Background())
	go func() {
		time.Sleep(200 * time.Millisecond)
		cancel2()
	}()
	start = time.Now()
	body, _ := json.Marshal(req)
	httpReq, err := http.NewRequestWithContext(ctx2, http.MethodPost,
		"http://"+addr+"/executor/execute", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	_, err = http.DefaultClient.Do(httpReq)
	if err == nil {
		t.Fatal("canceled http call must fail")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("http cancellation took %s; command was not aborted", elapsed)
	}
}

// TestH2CUpgradeOversizedBodyRejected verifies the outer MaxBytesHandler
// bound on the h2c layer: an Upgrade:h2c request whose first body exceeds
// the 4 MiB envelope is rejected instead of being buffered entirely into
// memory (x/net/http2/h2c reads the whole first upgraded request before
// dispatching). The server must also stay usable afterwards.
func TestH2CUpgradeOversizedBodyRejected(t *testing.T) {
	dir := t.TempDir()
	fakeBin := writeFakeCommand(t, dir, "gh-fake", 0)
	execSrv := &server{
		policy:   executor.DefaultPolicy(),
		ghPath:   fakeBin,
		glabPath: fakeBin,
		gpgPath:  fakeBin,
		timeout:  10 * time.Second,
	}
	_, addr := newDualProtocolTestServer(t, execSrv)

	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))

	settings := base64.RawURLEncoding.EncodeToString([]byte{0x00, 0x03, 0x00, 0x00, 0x7f})
	oversized := 5 << 20 // 5 MiB > 4 MiB envelope
	fmt.Fprintf(conn, "POST /executor/execute HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nUpgrade: h2c\r\nConnection: Upgrade, HTTP2-Settings\r\nHTTP2-Settings: %s\r\n\r\n", addr, oversized, settings)
	chunk := bytes.Repeat([]byte("x"), 64<<10)
	sent := 0
	for sent < oversized {
		n, werr := conn.Write(chunk)
		sent += n
		if werr != nil {
			break // server may close the connection once the cap trips
		}
	}

	// The bounded body read must produce an error response (h2c upgrade
	// fails) or a closed connection promptly — never a hang or unbounded
	// buffering.
	br := bufio.NewReader(conn)
	resp, rerr := http.ReadResponse(br, nil)
	if rerr == nil {
		resp.Body.Close()
		if resp.StatusCode != http.StatusInternalServerError {
			t.Fatalf("oversized h2c upgrade status = %d, want 500", resp.StatusCode)
		}
	}

	// The server is still healthy for normal requests.
	body := `{"tool":"gh","args":["pr","list"]}`
	hresp, err := http.Post("http://"+addr+"/executor/execute", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("server unusable after oversized h2c upgrade: %v", err)
	}
	hresp.Body.Close()
	if hresp.StatusCode != http.StatusOK {
		t.Fatalf("post-attack request status = %d", hresp.StatusCode)
	}
}

// TestBinarySIGTERMDrainsActiveCommands builds the REAL executor-server
// binary, starts slow fake gh commands through BOTH the legacy gRPC and
// the HTTP transport on the same listener, sends SIGTERM while they run,
// and requires: both responses finish with full stdout and exit code, the
// process exits cleanly only after the drain (no premature exit from
// Serve returning ErrServerClosed), all within bounded time.
func TestBinarySIGTERMDrainsActiveCommands(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and runs the real binary")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "executor-server")
	build := exec.Command("go", "build", "-o", bin, ".")
	buildOut, err := build.CombinedOutput()
	if err != nil {
		t.Fatalf("build executor-server: %v\n%s", err, buildOut)
	}

	// Slow command: runs ~3s so SIGTERM lands mid-command.
	fakeBin := filepath.Join(dir, "gh-slow")
	script := "#!/bin/sh\necho \"args: $*\"\nsleep 3\ncat\nexit 5\n"
	if err := os.WriteFile(fakeBin, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake binary: %v", err)
	}

	// Reserve a port for the binary's listener.
	reserve, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	addr := reserve.Addr().String()
	reserve.Close()

	cmd := exec.Command(bin,
		"--listen", addr,
		"--gh-path", fakeBin,
		"--glab-path", fakeBin,
		"--gpg-path", "/usr/bin/gpg")
	cmd.Env = append(os.Environ(),
		"METRICS_LISTEN=127.0.0.1:19092",
		"EXECUTOR_LISTEN="+addr)
	var logBuf bytes.Buffer
	cmd.Stdout = &logBuf
	cmd.Stderr = &logBuf
	if err := cmd.Start(); err != nil {
		t.Fatalf("start executor-server: %v", err)
	}
	defer func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}()

	// Wait for readiness: GET /executor/execute answers 405 once up.
	deadline := time.Now().Add(30 * time.Second)
	for {
		resp, err := http.Get("http://" + addr + "/executor/execute")
		if err == nil {
			resp.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("executor-server never became ready; log:\n%s", logBuf.String())
		}
		time.Sleep(50 * time.Millisecond)
	}

	req := &pb.ExecuteRequest{Tool: "gh", Args: []string{"pr", "list"}, Stdin: []byte("drain-stdin\n")}

	grpcDone := make(chan *pb.ExecuteResponse, 1)
	grpcErr := make(chan error, 1)
	go func() {
		conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			grpcErr <- err
			return
		}
		defer conn.Close()
		resp, err := pb.NewExecutorClient(conn).Execute(context.Background(), req)
		if err != nil {
			grpcErr <- err
			return
		}
		grpcDone <- resp
	}()

	httpDone := make(chan *pb.ExecuteResponse, 1)
	httpErr := make(chan error, 1)
	go func() {
		body, err := json.Marshal(req)
		if err != nil {
			httpErr <- err
			return
		}
		resp, err := http.Post("http://"+addr+"/executor/execute", "application/json", bytes.NewReader(body))
		if err != nil {
			httpErr <- err
			return
		}
		defer resp.Body.Close()
		var got pb.ExecuteResponse
		if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
			httpErr <- err
			return
		}
		httpDone <- &got
	}()

	// Let both commands start, then shut down mid-flight.
	time.Sleep(500 * time.Millisecond)
	sigStart := time.Now()
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("signal: %v", err)
	}

	// Both in-flight responses must complete with full output and exit
	// code — the drain must not truncate them.
	waitResp := func(name string, done <-chan *pb.ExecuteResponse, errCh <-chan error) *pb.ExecuteResponse {
		select {
		case resp := <-done:
			return resp
		case err := <-errCh:
			t.Fatalf("%s response failed during shutdown drain: %v\nlog:\n%s", name, err, logBuf.String())
		case <-time.After(30 * time.Second):
			t.Fatalf("%s response did not finish within bounded drain\nlog:\n%s", name, logBuf.String())
		}
		return nil
	}
	grpcResp := waitResp("grpc", grpcDone, grpcErr)
	httpResp := waitResp("http", httpDone, httpErr)
	for name, resp := range map[string]*pb.ExecuteResponse{"grpc": grpcResp, "http": httpResp} {
		if resp.ExitCode != 5 || !strings.Contains(resp.Stdout, "args: pr list") || !strings.Contains(resp.Stdout, "drain-stdin") {
			t.Fatalf("%s response truncated during drain: %+v", name, resp)
		}
	}

	// The process must exit cleanly (main joined the drain) and only
	// after the commands finished — no premature exit.
	exitErr := cmd.Wait()
	elapsed := time.Since(sigStart)
	if exitErr != nil {
		t.Fatalf("executor-server exit error: %v\nlog:\n%s", exitErr, logBuf.String())
	}
	if elapsed < 2*time.Second {
		t.Fatalf("process exited after only %s; active commands were not drained", elapsed)
	}
	if !strings.Contains(logBuf.String(), "shutting down...") {
		t.Fatalf("expected shutdown log; got:\n%s", logBuf.String())
	}
}

// --- backend availability inference ---

func TestInferBackendAvailability(t *testing.T) {
	env := map[string]string{
		"OPENAI_API_KEY":           "k",
		"REGISTRY_REDHAT_USERNAME": "u",
		"GCP_PROJECT_ID":           "p",
		"GIT_AUTH_ENABLED":         "true",
		"GH_TOKEN":                 "t",
		"JIRA_URL":                 "https://jira",
		"JIRA_USERNAME":            "u",
		"JIRA_API_TOKEN":           "t",
		"GLITCHTIP_URL":            "https://glitchtip",
	}
	for k, v := range env {
		t.Setenv(k, v)
	}

	avail := inferBackendAvailability()
	if !avail.Model || !avail.Registry || !avail.Vertex || !avail.Git ||
		!avail.JiraREST || !avail.JiraMCP || !avail.Screenshot || !avail.GlitchTip {
		t.Fatalf("all backends should be enabled, got %+v", avail)
	}

	// Jira MCP requires the complete JIRA_* triple (start.sh starts the
	// external mcp-atlassian process only then); the REST proxy needs only
	// the URL.
	t.Setenv("JIRA_API_TOKEN", "")
	avail = inferBackendAvailability()
	if avail.JiraMCP {
		t.Fatal("jira MCP must be disabled when JIRA_* is incomplete")
	}
	if !avail.JiraREST {
		t.Fatal("jira REST stays enabled with JIRA_URL set")
	}

	// Git auth is opt-in even with tokens present.
	t.Setenv("GIT_AUTH_ENABLED", "false")
	avail = inferBackendAvailability()
	if avail.Git {
		t.Fatal("git must be disabled when GIT_AUTH_ENABLED is not true")
	}
}

// --- full configuration validation ---

func TestBuildAgentGatewaysValidation(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "k")

	// A unix-socket legacy listener cannot serve the HTTP executor
	// upstream: fail clear configuration.
	_, err := buildAgentGateways("unix:///var/run/devbot/executor.sock")
	if err == nil || !strings.Contains(err.Error(), "TCP EXECUTOR_LISTEN") {
		t.Fatalf("unix listen with http gateway enabled must fail clear, got: %v", err)
	}

	// TCP listener: builds with the fixed loopback executor upstream.
	gw, err := buildAgentGateways(":9090")
	if err != nil {
		t.Fatalf("tcp listen must build: %v", err)
	}
	if gw.httpHandler == nil {
		t.Fatal("http gateway build missing handler")
	}

	// No vendor backends: the executor-only mapping still builds.
	for _, k := range []string{
		"OPENAI_API_KEY", "REGISTRY_REDHAT_USERNAME", "REGISTRY_REDHAT_TOKEN",
		"GCP_PROJECT_ID", "JIRA_URL", "JIRA_USERNAME", "JIRA_API_TOKEN",
		"GH_TOKEN", "GITLAB_TOKEN", "GLITCHTIP_URL", "GIT_AUTH_ENABLED",
	} {
		t.Setenv(k, "")
	}
	if _, err := buildAgentGateways(":9090"); err != nil {
		t.Fatalf("executor-only mapping must build: %v", err)
	}
}
