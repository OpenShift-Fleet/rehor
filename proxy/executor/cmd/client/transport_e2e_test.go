package main

// End-to-end tests for the default-HTTP thin client (REHOR-252) against
// local dual-protocol fixtures: the updated proxy serves legacy gRPC (h2c)
// and HTTP/1.1 /executor/execute on the same listener.

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/RedHatInsights/platform-frontend-ai-dev/proxy/executor/gen"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/proto"
)

func init() {
	dialTimeout = 300 * time.Millisecond
	// Proxy tests set variables explicitly; ambient machine proxy settings
	// must not leak into hermetic loopback assertions.
	for _, name := range []string{
		"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy",
	} {
		os.Unsetenv(name)
	}
}

// fakeStdoutOverride lets envelope tests swap in large outputs for both
// transports; package tests run sequentially.
var fakeStdoutOverride string

// fakeExecuteOutputs mirrors the legacy fake executor semantics for both
// transports so CLI output and exit codes can be compared.
func fakeExecuteOutputs(req *pb.ExecuteRequest) *pb.ExecuteResponse {
	resp := &pb.ExecuteResponse{
		Stdout:   "out:" + req.Tool,
		Stderr:   "err:" + strings.Join(req.Args, ","),
		ExitCode: 7,
	}
	if len(req.Stdin) > 0 {
		resp.Stdout = "stdin:" + string(req.Stdin)
	}
	if len(req.Stdin) > 1024 && fakeStdoutOverride != "" {
		resp.Stdout = fakeStdoutOverride
	}
	return resp
}

// dualServer is a local fixture speaking HTTP/1.1 and gRPC (h2c) on the SAME
// listener, like the updated proxy.
type dualServer struct {
	pb.UnimplementedExecutorServer

	httpHits atomic.Int32
	grpcHits atomic.Int32

	mu       sync.Mutex
	lastAuth string
	lastCT   string
	lastTool string
	lastArgs string
}

func (d *dualServer) record(auth, ct string, req *pb.ExecuteRequest) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.lastAuth = auth
	d.lastCT = ct
	d.lastTool = req.Tool
	d.lastArgs = strings.Join(req.Args, ",")
}

func (d *dualServer) snapshot() (string, string, string, string, int32, int32) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.lastAuth, d.lastCT, d.lastTool, d.lastArgs, d.httpHits.Load(), d.grpcHits.Load()
}

// ServeHTTP handles POST /executor/execute with the canonical binary
// protobuf codec, mirroring the updated gateway.
func (d *dualServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != httpEndpointPath || r.Method != http.MethodPost {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	d.httpHits.Add(1)
	body, _ := io.ReadAll(r.Body)
	var req pb.ExecuteRequest
	if err := proto.Unmarshal(body, &req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	d.record(r.Header.Get("Authorization"), r.Header.Get("Content-Type"), &req)
	resp := fakeExecuteOutputs(&req)
	out, err := proto.Marshal(resp)
	if err != nil {
		http.Error(w, "encode error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", protobufContentType)
	w.Write(out)
}

// Execute implements the gRPC ExecutorServer side of the fixture.
func (d *dualServer) Execute(ctx context.Context, req *pb.ExecuteRequest) (*pb.ExecuteResponse, error) {
	d.grpcHits.Add(1)
	auth := "<none>"
	if md, ok := metadata.FromIncomingContext(ctx); ok {
		if v := md.Get("authorization"); len(v) > 0 {
			auth = v[0]
		}
	}
	d.record(auth, "application/grpc", req)
	return fakeExecuteOutputs(req), nil
}

// peekConn buffers the first bytes read so the protocol can be detected
// before handing the connection to the right server.
type peekConn struct {
	net.Conn
	buf []byte
}

func (c *peekConn) Peek(n int) ([]byte, error) {
	for len(c.buf) < n {
		tmp := make([]byte, n-len(c.buf))
		m, err := c.Conn.Read(tmp)
		c.buf = append(c.buf, tmp[:m]...)
		if err != nil {
			return c.buf, err
		}
	}
	return c.buf, nil
}

func (c *peekConn) Read(p []byte) (int, error) {
	if len(c.buf) > 0 {
		n := copy(p, c.buf)
		c.buf = c.buf[n:]
		return n, nil
	}
	return c.Conn.Read(p)
}

// chanListener feeds pre-classified connections to one protocol server.
type chanListener struct {
	conns  chan net.Conn
	closed chan struct{}
	once   sync.Once
	addr   net.Addr
}

func newChanListener(addr net.Addr) *chanListener {
	return &chanListener{conns: make(chan net.Conn, 16), closed: make(chan struct{}), addr: addr}
}

func (l *chanListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.closed:
		return nil, errors.New("listener closed")
	}
}

func (l *chanListener) Close() error {
	l.once.Do(func() { close(l.closed) })
	return nil
}

func (l *chanListener) Addr() net.Addr { return l.addr }

// startDualServer runs the dual-protocol fixture on the given listener and
// returns its dial address for EXECUTOR_ADDR plus the fixture for
// assertions.
func startDualServer(t *testing.T, lis net.Listener) (string, *dualServer) {
	t.Helper()
	d := &dualServer{}

	grpcSrv := grpc.NewServer()
	pb.RegisterExecutorServer(grpcSrv, d)
	grpcLis := newChanListener(lis.Addr())

	httpSrv := &http.Server{Handler: d}
	httpLis := newChanListener(lis.Addr())

	go grpcSrv.Serve(grpcLis)
	go httpSrv.Serve(httpLis)

	done := make(chan struct{})
	t.Cleanup(func() {
		lis.Close()
		grpcSrv.Stop()
		httpSrv.Close()
		close(done)
	})
	go func() {
		for {
			conn, err := lis.Accept()
			if err != nil {
				return
			}
			pc := &peekConn{Conn: conn}
			go func() {
				b, _ := pc.Peek(3)
				if string(b) == "PRI" {
					// HTTP/2 client preface: legacy gRPC.
					grpcLis.conns <- pc
				} else {
					httpLis.conns <- pc
				}
			}()
		}
	}()

	fixtureMu.Lock()
	fixtures[lis.Addr()] = d
	fixtureMu.Unlock()

	if lis.Addr().Network() == "unix" {
		return "unix://" + lis.Addr().String(), d
	}
	return lis.Addr().String(), d
}

// unixSocketPath returns a socket path short enough for sun_path.
func unixSocketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "exsock")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, "executor.sock")
}

func runClient(t *testing.T, tool string, args []string, stdin string) (int, string, string) {
	t.Helper()
	var out, errOut strings.Builder
	code := run(tool, args, strings.NewReader(stdin), &out, &errOut)
	return code, out.String(), errOut.String()
}

func assertCLIOutput(t *testing.T, code int, out, errMsg string, stdin string) {
	t.Helper()
	if code != 7 {
		t.Fatalf("exit = %d, want 7 (stderr: %s)", code, errMsg)
	}
	if stdin != "" {
		if out != "stdin:"+stdin {
			t.Errorf("stdout = %q, want stdin echo", out)
		}
	} else if out != "out:gh" {
		t.Errorf("stdout = %q, want out:gh", out)
	}
	if errMsg != "err:pr,view,42" {
		t.Errorf("stderr = %q, want err:pr,view,42", errMsg)
	}
}

func TestDefaultHTTPHostPortAgainstDualServer(t *testing.T) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr, _ := startDualServer(t, lis)

	// Only EXECUTOR_ADDR: default transport must be HTTP on the same
	// listener, with no credentials on the plaintext internal path.
	t.Setenv("EXECUTOR_ADDR", addr)
	code, out, errMsg := runClient(t, "gh", []string{"pr", "view", "42"}, "")
	assertCLIOutput(t, code, out, errMsg, "")

	auth, ct, tool, args, httpHits, grpcHits := dualSnapshot(t, lis.Addr(), addr)
	if httpHits != 1 || grpcHits != 0 {
		t.Errorf("hits: http=%d grpc=%d, want http=1 grpc=0", httpHits, grpcHits)
	}
	if auth != "" {
		t.Errorf("Authorization on derived plaintext internal transport: %q", auth)
	}
	if ct != protobufContentType {
		t.Errorf("Content-Type = %q", ct)
	}
	if tool != "gh" || args != "pr,view,42" {
		t.Errorf("request tool=%q args=%q", tool, args)
	}
}

func TestDefaultHTTPUnixAgainstDualServer(t *testing.T) {
	sock := unixSocketPath(t)
	lis, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	startDualServer(t, lis)

	t.Setenv("EXECUTOR_ADDR", "unix://"+sock)
	code, out, errMsg := runClient(t, "gh", []string{"pr", "view", "42"}, "")
	assertCLIOutput(t, code, out, errMsg, "")
}

func TestDefaultAddrUnsetUsesDefaultUnixSocketHTTP(t *testing.T) {
	// No EXECUTOR_ADDR, no HTTP URL: derived HTTP over the default unix
	// socket. Nothing listens there in tests, so this must be a connect
	// error (127), proving the default switched to HTTP-over-unix.
	t.Setenv("EXECUTOR_ADDR", "")
	code, _, errMsg := runClient(t, "gh", []string{"pr", "view", "42"}, "")
	if code != 127 {
		t.Fatalf("exit = %d, want 127 (stderr: %s)", code, errMsg)
	}
	if !strings.Contains(errMsg, "cannot connect") {
		t.Errorf("stderr = %q, want connect failure", errMsg)
	}
}

func TestExplicitGRPCRollbackAgainstDualServer(t *testing.T) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr, _ := startDualServer(t, lis)

	t.Setenv("EXECUTOR_ADDR", addr)
	t.Setenv("EXECUTOR_TRANSPORT", "grpc")
	code, out, errMsg := runClient(t, "gh", []string{"pr", "view", "42"}, "")
	assertCLIOutput(t, code, out, errMsg, "")

	_, _, _, _, httpHits, grpcHits := dualSnapshot(t, lis.Addr(), addr)
	if httpHits != 0 || grpcHits != 1 {
		t.Errorf("hits: http=%d grpc=%d, want http=0 grpc=1", httpHits, grpcHits)
	}
}

func TestNoFallbackFromHTTPFailureToGRPC(t *testing.T) {
	// A grpc-ONLY server (old, not yet updated proxy): the new client's
	// default HTTP must fail loudly — never silently retry over gRPC,
	// because the command may have already executed.
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := grpc.NewServer()
	pb.RegisterExecutorServer(srv, &dualServer{})
	go srv.Serve(lis)
	t.Cleanup(srv.Stop)

	t.Setenv("EXECUTOR_ADDR", lis.Addr().String())
	code, _, errMsg := runClient(t, "gh", []string{"pr", "view", "42"}, "")
	if code == 0 || code == 7 {
		t.Fatalf("exit = %d, want failure against grpc-only server", code)
	}
	if code != 1 {
		t.Logf("note: exit = %d (stderr: %s)", code, errMsg)
	}
	if !strings.Contains(errMsg, "rpc failed") {
		t.Errorf("stderr = %q, want rpc failure", errMsg)
	}
}

func TestStdinPassthroughHTTP(t *testing.T) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr, _ := startDualServer(t, lis)

	t.Setenv("EXECUTOR_ADDR", addr)
	// needsStdin("gh", auth git-credential) must keep reading stdin on the
	// HTTP transport and deliver it (base64 in JSON) to the server.
	code, out, errMsg := runClient(t, "gh", []string{"auth", "git-credential", "get"}, "host=example.com\n")
	if code != 7 {
		t.Fatalf("exit = %d, want 7 (stderr: %s)", code, errMsg)
	}
	if out != "stdin:host=example.com\n" {
		t.Errorf("stdout = %q, want stdin echo", out)
	}
	if errMsg != "err:auth,git-credential,get" {
		t.Errorf("stderr = %q", errMsg)
	}
}

func writeTempFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestExplicitHTTPSPlaceholderToken(t *testing.T) {
	var gotAuth atomic.Value
	var gotCT atomic.Value
	var gotTool atomic.Value
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req pb.ExecuteRequest
		if err := proto.Unmarshal(body, &req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		gotAuth.Store(r.Header.Get("Authorization"))
		gotCT.Store(r.Header.Get("Content-Type"))
		gotTool.Store(req.Tool)
		out, err := proto.Marshal(fakeExecuteOutputs(&req))
		if err != nil {
			http.Error(w, "encode error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", protobufContentType)
		w.Write(out)
	}))
	srv.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	srv.StartTLS()
	t.Cleanup(srv.Close)

	// Trust the server's actual certificate via EXECUTOR_CA_FILE.
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	dir := t.TempDir()
	caFile := writeTempFile(t, dir, "ca.pem", string(caPEM))

	t.Setenv("EXECUTOR_HTTP_URL", srv.URL+"/executor/execute")
	t.Setenv("EXECUTOR_CA_FILE", caFile)
	t.Setenv("EXECUTOR_TOKEN", "openshell:resolve:env:executor")

	code, out, errMsg := runClient(t, "gh", []string{"pr", "view", "42"}, "")
	assertCLIOutput(t, code, out, errMsg, "")

	if gotAuth.Load() != "Bearer openshell:resolve:env:executor" {
		t.Errorf("Authorization = %v", gotAuth.Load())
	}
	if gotCT.Load() != protobufContentType {
		t.Errorf("Content-Type = %v", gotCT.Load())
	}
	if tool, ok := gotTool.Load().(string); !ok || tool != "gh" {
		t.Errorf("request tool = %v", gotTool.Load())
	}
}

func TestExplicitHTTPSTokenFileRejectedWithoutRead(t *testing.T) {
	// EXECUTOR_TOKEN_FILE is always a configuration error: the client never
	// reads a token file. A sentinel nonexistent path proves no read is
	// attempted and no value is echoed.
	sentinel := filepath.Join(t.TempDir(), "nonexistent-sentinel-token")
	t.Setenv("EXECUTOR_HTTP_URL", "https://executor.example.com/executor/execute")
	t.Setenv("EXECUTOR_TOKEN_FILE", sentinel)

	code, _, errMsg := runClient(t, "gh", []string{"pr", "view", "42"}, "")
	if code != 2 {
		t.Fatalf("exit = %d, want 2 (stderr: %s)", code, errMsg)
	}
	if !strings.Contains(errMsg, "EXECUTOR_TOKEN_FILE is not supported") {
		t.Errorf("stderr = %q", errMsg)
	}
	if strings.Contains(errMsg, sentinel) {
		t.Errorf("stderr echoes the path: %q", errMsg)
	}
}

func TestExplicitHTTPSUntrustedCertRejected(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler must not be reached")
	}))
	srv.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	srv.StartTLS()
	t.Cleanup(srv.Close)

	// No EXECUTOR_CA_FILE: the self-signed certificate must fail
	// verification as a connect error. There is no skip option.
	t.Setenv("EXECUTOR_HTTP_URL", srv.URL+"/executor/execute")
	code, _, errMsg := runClient(t, "gh", []string{"pr", "view", "42"}, "")
	if code != 127 {
		t.Fatalf("exit = %d, want 127 (stderr: %s)", code, errMsg)
	}
	if !strings.Contains(errMsg, "cannot connect") {
		t.Errorf("stderr = %q", errMsg)
	}
}

// generateNamedCert creates a self-signed CA-style certificate valid for the
// given DNS name (plus 127.0.0.1), used for proxy-routed HTTPS fixtures.
func generateNamedCert(t *testing.T, dnsName string) (tls.Certificate, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: dnsName},
		DNSNames:              []string{dnsName},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}),
	)
	if err != nil {
		t.Fatal(err)
	}
	return cert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

// TestExplicitHTTPSUsesEnvProxyCONNECT proves the explicit HTTPS endpoint
// honors HTTPS_PROXY (standard net/http ProxyFromEnvironment): the request
// traverses a local CONNECT proxy and the Authorization placeholder arrives
// at the backend inside the TLS tunnel. The backend uses a non-loopback
// fixture name from the certificate SAN so standard NO_PROXY loopback
// bypasses cannot hide proxy routing.
func TestExplicitHTTPSUsesEnvProxyCONNECT(t *testing.T) {
	const fixtureHost = "fixture-public.example.test"

	var gotAuth atomic.Value
	var backendHits atomic.Int32
	backend := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backendHits.Add(1)
		body, _ := io.ReadAll(r.Body)
		var req pb.ExecuteRequest
		if err := proto.Unmarshal(body, &req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		gotAuth.Store(r.Header.Get("Authorization"))
		out, err := proto.Marshal(fakeExecuteOutputs(&req))
		if err != nil {
			http.Error(w, "encode error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", protobufContentType)
		w.Write(out)
	})}
	cert, caPEM := generateNamedCert(t, fixtureHost)
	rawLis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	tlsLis := tls.NewListener(rawLis, &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
	})
	go backend.Serve(tlsLis)
	t.Cleanup(func() { backend.Close(); tlsLis.Close() })
	backendPort := rawLis.Addr().(*net.TCPAddr).Port

	// Local CONNECT proxy: tunnels every CONNECT to the fixture backend and
	// records the requested authority. No proxy credentials are involved.
	var connectCount atomic.Int32
	var connectAuthority atomic.Value
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "unexpected method", http.StatusMethodNotAllowed)
			return
		}
		connectCount.Add(1)
		connectAuthority.Store(r.Host)
		hj, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "no hijack", http.StatusInternalServerError)
			return
		}
		clientConn, _, err := hj.Hijack()
		if err != nil {
			return
		}
		defer clientConn.Close()
		upstream, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", backendPort))
		if err != nil {
			return
		}
		defer upstream.Close()
		if _, err := clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
			return
		}
		done := make(chan struct{}, 2)
		go func() { io.Copy(upstream, clientConn); done <- struct{}{} }()
		go func() { io.Copy(clientConn, upstream); done <- struct{}{} }()
		<-done
	}))
	t.Cleanup(proxy.Close)

	dir := t.TempDir()
	caFile := writeTempFile(t, dir, "ca.pem", string(caPEM))

	// Explicit HTTPS via the proxy: NO_PROXY deliberately does not bypass
	// the fixture host.
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("https_proxy", proxy.URL)
	t.Setenv("HTTP_PROXY", "")
	t.Setenv("http_proxy", "")
	t.Setenv("NO_PROXY", "")
	t.Setenv("no_proxy", "")
	t.Setenv("EXECUTOR_HTTP_URL", fmt.Sprintf("https://%s:%d/executor/execute", fixtureHost, backendPort))
	t.Setenv("EXECUTOR_CA_FILE", caFile)
	t.Setenv("EXECUTOR_TOKEN", "openshell:resolve:env:executor")

	code, out, errMsg := runClient(t, "gh", []string{"pr", "view", "42"}, "")
	if code != 7 {
		t.Fatalf("exit = %d, want 7 (stderr: %s)", code, errMsg)
	}
	if out != "out:gh" {
		t.Errorf("stdout = %q", out)
	}
	if connectCount.Load() != 1 {
		t.Fatalf("CONNECT count = %d, want 1 (proxy must be used)", connectCount.Load())
	}
	if got, _ := connectAuthority.Load().(string); got != fmt.Sprintf("%s:%d", fixtureHost, backendPort) {
		t.Errorf("CONNECT authority = %q", got)
	}
	if gotAuth.Load() != "Bearer openshell:resolve:env:executor" {
		t.Errorf("Authorization inside TLS tunnel = %v", gotAuth.Load())
	}
	if backendHits.Load() != 1 {
		t.Errorf("backend hits = %d", backendHits.Load())
	}
}

// TestDerivedInternalIgnoresAmbientProxy proves the derived internal
// transport (legacy EXECUTOR_ADDR boundary) ignores ambient proxy settings,
// like the legacy gRPC WithNoProxy behavior.
func TestDerivedInternalIgnoresAmbientProxy(t *testing.T) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr, _ := startDualServer(t, lis)

	// A bogus proxy that would fail every connection if it were used.
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("http_proxy", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	t.Setenv("https_proxy", "http://127.0.0.1:1")
	t.Setenv("NO_PROXY", "")
	t.Setenv("no_proxy", "")

	t.Setenv("EXECUTOR_ADDR", addr)
	code, out, errMsg := runClient(t, "gh", []string{"pr", "view", "42"}, "")
	assertCLIOutput(t, code, out, errMsg, "")
}

func TestHTTPConnectRefusedIs127(t *testing.T) { // Reserve then close a port so nothing listens.
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := lis.Addr().String()
	lis.Close()

	t.Setenv("EXECUTOR_ADDR", addr)
	code, _, errMsg := runClient(t, "gh", []string{"pr", "view", "42"}, "")
	if code != 127 {
		t.Fatalf("exit = %d, want 127 (stderr: %s)", code, errMsg)
	}
}

func TestHTTPRedirectTrapReceivesZero(t *testing.T) {
	var trapHits atomic.Int32
	trap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		trapHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(trap.Close)

	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The redirect target carries a dummy secret query: it must never
		// be followed, and never echoed in the client's stderr.
		http.Redirect(w, r, trap.URL+"/steal?token=dummy-secret-value-123", http.StatusFound)
	}))
	t.Cleanup(redirector.Close)

	// Explicit https endpoint pointing at the redirector: the client must
	// refuse the redirect; the trap must receive nothing. Use loopback http
	// (allowed for offline tests) so no certificate is needed.
	t.Setenv("EXECUTOR_HTTP_URL", redirector.URL+"/executor/execute")
	code, _, errMsg := runClient(t, "gh", []string{"pr", "view", "42"}, "")
	if code != 1 {
		t.Fatalf("exit = %d, want 1 (stderr: %s)", code, errMsg)
	}
	if trapHits.Load() != 0 {
		t.Errorf("redirect trap received %d requests", trapHits.Load())
	}
	if !strings.Contains(errMsg, "rpc failed") {
		t.Errorf("stderr = %q", errMsg)
	}
	// The refused-redirect error is a static sentinel: neither the redirect
	// target URL nor its query may appear in stderr.
	if strings.Contains(errMsg, "dummy-secret-value-123") {
		t.Errorf("stderr leaks redirect query secret: %q", errMsg)
	}
	if strings.Contains(errMsg, "/steal") {
		t.Errorf("stderr leaks redirect target path: %q", errMsg)
	}
}

// TestHTTPWireEnvelopeMatchesLegacyGRPC proves the binary protobuf codec
// preserves the legacy 4 MiB envelope: a near-4MiB stdin (whose JSON base64
// encoding would exceed the cap) and a large quote-heavy stdout (whose JSON
// escaping would exceed the cap) both succeed over HTTP and produce exactly
// the same CLI output as the legacy gRPC transport.
func TestHTTPWireEnvelopeMatchesLegacyGRPC(t *testing.T) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr, _ := startDualServer(t, lis)

	// ~3.5 MiB stdin: JSON base64 would be ~4.7 MiB (> cap), protobuf wire
	// stays under 4 MiB.
	bigStdin := strings.Repeat("s", 3500*1024)
	// Quote/backslash-heavy stdout ~3.3 MiB on the protobuf wire: JSON
	// escaping would inflate it to ~4.7 MiB, over the cap.
	bigStdout := strings.Repeat(`a"b\n`, 700000)

	fakeStdoutOverride = bigStdout
	t.Cleanup(func() { fakeStdoutOverride = "" })

	runVia := func(transport string) (int, string, string) {
		t.Helper()
		t.Setenv("EXECUTOR_ADDR", addr)
		if transport == "" {
			t.Setenv("EXECUTOR_TRANSPORT", "")
		} else {
			t.Setenv("EXECUTOR_TRANSPORT", transport)
		}
		var out, errOut strings.Builder
		code := run("gh", []string{"auth", "git-credential", "get"}, strings.NewReader(bigStdin), &out, &errOut)
		return code, out.String(), errOut.String()
	}

	// Default HTTP transport: big stdin accepted, big stdout returned whole.
	httpCode, httpOut, httpErr := runVia("")
	if httpCode != 7 {
		t.Fatalf("HTTP exit = %d, want 7 (stderr: %s)", httpCode, httpErr)
	}
	if httpOut != bigStdout {
		t.Errorf("HTTP stdout length = %d, want %d", len(httpOut), len(bigStdout))
	}

	// Legacy gRPC rollback: identical output for identical input.
	grpcCode, grpcOut, grpcErr := runVia("grpc")
	if grpcCode != 7 {
		t.Fatalf("gRPC exit = %d, want 7 (stderr: %s)", grpcCode, grpcErr)
	}
	if grpcOut != httpOut {
		t.Errorf("gRPC stdout differs from HTTP stdout: %d vs %d bytes", len(grpcOut), len(httpOut))
	}
}

func TestHTTPErrorResponseShapes(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"non-200", func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "boom", http.StatusInternalServerError)
		}},
		{"malformed protobuf", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", protobufContentType)
			io.WriteString(w, "not protobuf at all")
		}},
		{"wrong content type", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, "{}")
		}},
		{"oversize response", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", protobufContentType)
			resp := &pb.ExecuteResponse{Stdout: strings.Repeat("a", 5<<20)}
			out, err := proto.Marshal(resp)
			if err != nil {
				t.Errorf("marshal oversize: %v", err)
				return
			}
			w.Write(out)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(tc.handler)
			t.Cleanup(srv.Close)

			t.Setenv("EXECUTOR_HTTP_URL", srv.URL+"/executor/execute")
			code, _, errMsg := runClient(t, "gh", []string{"pr", "view", "42"}, "")
			if code != 1 {
				t.Fatalf("exit = %d, want 1 (stderr: %s)", code, errMsg)
			}
			if !strings.Contains(errMsg, "rpc failed") {
				t.Errorf("stderr = %q", errMsg)
			}
		})
	}
}

func TestRunConfigErrorExitsNonzeroWithoutLeak(t *testing.T) {
	t.Setenv("EXECUTOR_ADDR", "devbot-proxy:9090")
	t.Setenv("EXECUTOR_TOKEN", "super-secret-token-value-123")

	code, _, errMsg := runClient(t, "gh", []string{"pr", "view", "42"}, "")
	if code != 2 {
		t.Fatalf("exit = %d, want 2", code)
	}
	if strings.Contains(errMsg, "super-secret-token-value-123") {
		t.Errorf("stderr leaks token: %q", errMsg)
	}
	if !strings.Contains(errMsg, "invalid transport configuration") {
		t.Errorf("stderr = %q", errMsg)
	}
}

// dualSnapshot fetches the fixture registered for this test's listener.
var fixtureMu sync.Mutex
var fixtures = map[net.Addr]*dualServer{}

func dualSnapshot(t *testing.T, key net.Addr, _ string) (string, string, string, string, int32, int32) {
	t.Helper()
	fixtureMu.Lock()
	defer fixtureMu.Unlock()
	d, ok := fixtures[key]
	if !ok {
		t.Fatalf("no fixture for %s", key)
	}
	return d.snapshot()
}
