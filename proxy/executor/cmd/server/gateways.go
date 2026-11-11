package main

// Opt-in agent gateways for the executor server (REHOR-251/252):
//
//   - HTTP gateway (REHOR-251): consolidated path-routed HTTP listener on a
//     fixed loopback address (127.0.0.1:8454) behind the oauth-services
//     sidecar (:8453), which performs the outer authentication. Only fixed
//     loopback routes to existing backends are supported; enabled backends
//     are inferred from the same configuration that drives the legacy
//     listeners. There is no arbitrary upstream URL routing.
//   - Executor HTTP transport (REHOR-252, renamed from the public gRPC
//     gateway): thin clients use HTTP instead of gRPC. The EXISTING
//     EXECUTOR_LISTEN address (:9090 in the deployment, or a unix socket)
//     serves both legacy gRPC (HTTP/2, h2c prior knowledge) and HTTP/1.1
//     POST /executor/execute from one http.Server: gRPC requests are
//     dispatched to the unchanged legacy grpc.Server, everything else to a
//     shared executor.NewExecutorHTTPHandler wrapping the SAME *server
//     Execute implementation and policy. No duplicate execution logic, no
//     new public authentication on the listener (same internal trust
//     boundary as before), no new Service/NetworkPolicy port. The HTTP
//     gateway routes /executor/execute to this listener as a fixed
//     loopback upstream.
//
// The gateway defaults to disabled. Disabled, it requires no new
// configuration and legacy startup is unchanged. Enabled with malformed or
// incomplete configuration, it fails before any listener is opened.
// Shutdown of the new servers is bounded even if clients stay connected.
// The legacy Squid forward proxy (:3128, started by start.sh) and all other
// existing listeners are untouched; ordinary sandbox egress is handled by
// the central OpenShell allowlist, not by this server.

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	executor "github.com/RedHatInsights/platform-frontend-ai-dev/proxy/executor"
	pb "github.com/RedHatInsights/platform-frontend-ai-dev/proxy/executor/gen"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
	"google.golang.org/grpc"
)

const (
	// Fixed listener address (deployment contract): loopback only, behind
	// the oauth-services sidecar on :8453 which terminates the public
	// Route and performs authentication.
	httpGatewayAddr = "127.0.0.1:8454"

	// Enable flag (deployment contract), default false.
	httpEnableEnv = "AGENT_HTTP_GATEWAY_ENABLED"

	// Bounded shutdown grace for the HTTP gateway, applied even if clients
	// stay connected.
	gatewayShutdownGrace = 10 * time.Second

	// Bounded shutdown grace for the dual-protocol executor listener's
	// gRPC side. It exceeds the default per-command timeout (60s) so a
	// force-stop never truncates an ordinarily-running command, while still
	// bounding shutdown when a client or handler stays open forever.
	executorShutdownGrace = 65 * time.Second

	// Bounded join timeout after the listener closes: the signal handler's
	// full drain (gateway 10s + listener HTTP 5s + gRPC 65s + legacy
	// servers 5s) must complete within this or main exits anyway. No
	// unbounded join.
	shutdownJoinGrace = 90 * time.Second
)

// httpGatewayEnabled parses the opt-in enable flag. Empty means false. Any
// value outside the accepted true/false spellings is malformed and fails
// early so a typo cannot silently disable or half-enable the gateway.
func httpGatewayEnabled() (bool, error) {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(httpEnableEnv)))
	switch v {
	case "", "false", "0", "no", "off":
		return false, nil
	case "true", "1", "yes", "on":
		return true, nil
	default:
		return false, fmt.Errorf("%s: malformed boolean value %q (want true or false)", httpEnableEnv, v)
	}
}

// executorHTTPUpstream derives the fixed loopback executor upstream URL
// from the legacy listener address. Only TCP listeners can serve the HTTP
// transport (the deployment contract uses :9090); a unix-socket listener
// with the HTTP gateway enabled fails clear configuration instead of
// silently guessing.
func executorHTTPUpstream(listenAddr string) (string, error) {
	addr := strings.TrimSpace(listenAddr)
	if addr == "" || strings.HasPrefix(addr, "unix://") {
		return "", fmt.Errorf("HTTP gateway requires a TCP EXECUTOR_LISTEN (deployment uses :9090); %q cannot serve the executor HTTP upstream", listenAddr)
	}
	_, port, err := net.SplitHostPort(addr)
	if err != nil || port == "" {
		return "", fmt.Errorf("HTTP gateway: EXECUTOR_LISTEN %q is not a host:port TCP address", listenAddr)
	}
	// The upstream is always the fixed loopback address regardless of the
	// bind host, mirroring the other fixed backends.
	return "http://127.0.0.1:" + port, nil
}

// backendAvailability records which legacy backends are actually enabled.
// Only enabled backends are mapped into the HTTP gateway.
type backendAvailability struct {
	Model      bool // OpenAI-compatible proxy :8450
	Registry   bool // Red Hat registry pull proxy :8451
	Vertex     bool // Vertex AI proxy :8443
	Git        bool // git auth proxy :8447
	JiraREST   bool // Jira REST proxy :8445
	JiraMCP    bool // mcp-atlassian :8444 (external start.sh process)
	Screenshot bool // screenshot upload :8446
	GlitchTip  bool // GlitchTip proxy :8448
}

// jiraMCPEnabled mirrors proxy/start.sh: the mcp-atlassian server on :8444
// is an external process started only when the Jira credentials are complete.
func jiraMCPEnabled() bool {
	return os.Getenv("JIRA_URL") != "" &&
		os.Getenv("JIRA_USERNAME") != "" &&
		os.Getenv("JIRA_API_TOKEN") != ""
}

// inferBackendAvailability mirrors the enablement conditions of the legacy
// listeners in main() so the gateway maps only backends that actually exist.
// Conditions are read from the environment, which is what the deployment
// contract and start.sh use; CLI-flag-only overrides are not inferred.
func inferBackendAvailability() backendAvailability {
	envTrue := func(name string) bool {
		return strings.EqualFold(strings.TrimSpace(os.Getenv(name)), "true")
	}
	return backendAvailability{
		// OpenAI-compatible gateway is on only when a key is present.
		Model: os.Getenv("OPENAI_API_KEY") != "",
		// NewRegistryProxy returns no handler only when both are empty.
		Registry: os.Getenv("REGISTRY_REDHAT_USERNAME") != "" || os.Getenv("REGISTRY_REDHAT_TOKEN") != "",
		// Vertex proxy requires a configured project.
		Vertex: strings.TrimSpace(os.Getenv("GCP_PROJECT_ID")) != "",
		// Git auth proxy is opt-in and needs a token.
		Git: envTrue("GIT_AUTH_ENABLED") && (os.Getenv("GH_TOKEN") != "" || os.Getenv("GITLAB_TOKEN") != ""),
		// Jira REST proxy requires an upstream URL.
		JiraREST: strings.TrimSpace(os.Getenv("JIRA_URL")) != "",
		// Jira MCP backend only exists when start.sh started it.
		JiraMCP: jiraMCPEnabled(),
		// Screenshot upload needs a GitHub token.
		Screenshot: os.Getenv("GH_TOKEN") != "",
		// GlitchTip proxy requires an upstream URL.
		GlitchTip: strings.TrimSpace(os.Getenv("GLITCHTIP_URL")) != "",
	}
}

// httpGatewayConfig maps backend availability onto the executor core
// GatewayConfig: enabled backends keep their fixed default loopback
// listeners, disabled backends are cleared so the core fails those routes
// closed with 503. The core owns the fixed routing table (canonical /v1
// model and /v2 registry paths plus aliases and prefix rewrites); there is
// no arbitrary upstream URL routing. The executor upstream is the
// dual-protocol legacy listener itself (fixed loopback address derived
// from EXECUTOR_LISTEN; deployment default http://127.0.0.1:9090).
func httpGatewayConfig(avail backendAvailability, executorUpstream string) executor.GatewayConfig {
	cfg := executor.DefaultGatewayConfig()
	cfg.Executor = executorUpstream
	if !avail.Model {
		cfg.Models = ""
	}
	if !avail.JiraMCP {
		cfg.JiraMCP = ""
	}
	if !avail.JiraREST {
		cfg.JiraREST = ""
	}
	if !avail.Git {
		cfg.Git = ""
	}
	if !avail.Vertex {
		cfg.Vertex = ""
	}
	if !avail.Registry {
		cfg.Registry = ""
	}
	if !avail.Screenshot {
		cfg.Screenshots = ""
	}
	if !avail.GlitchTip {
		cfg.GlitchTip = ""
	}
	return cfg
}

// httpGatewayHandler builds the consolidated HTTP gateway handler. The Go
// mux consumes the outer authorization (the oauth-services sidecar on :8453
// authenticates); the core strips the ingress bearer and session headers
// before forwarding to the loopback backends.
func httpGatewayHandler(avail backendAvailability, executorUpstream string) (http.Handler, error) {
	return executor.NewHTTPGateway(httpGatewayConfig(avail, executorUpstream))
}

// executorGatewayHandler builds the shared executor HTTP wrapper
// (REHOR-252). The wrapper is the SAME *server.Execute implementation and
// policy as the legacy gRPC listener. Bodies are protobuf wire format
// (application/x-protobuf, canonical, 4 MiB envelope like the gRPC
// default) or JSON over the generated pb structs (application/json, debug
// encoding; tool, args, stdin base64 / stdout, stderr, exit_code), bounded
// to 4 MiB in each direction without silent truncation. It performs no
// authentication of its own: the listener keeps the legacy internal trust
// boundary, and the authenticated HTTP gateway is the public path.
func executorGatewayHandler(execSrv pb.ExecutorServer) (http.Handler, error) {
	if execSrv == nil {
		return nil, fmt.Errorf("executor HTTP wrapper requires the executor server instance")
	}
	return executor.NewExecutorHTTPHandler(execSrv), nil
}

// maxRequestBodyBytes bounds any request body read before the handler
// chain, including the first-request body that x/net/http2/h2c buffers
// entirely into memory on an Upgrade:h2c connection (its own docs require
// an http.MaxBytesHandler wrapper for this). It mirrors the executor's 4
// MiB envelope; +1 lets the executor wrapper's own too-large check decide
// the response status. Legacy gRPC is unaffected: prior-knowledge PRI
// requests are hijacked before any body is read, and HTTP/2 DATA frames
// after the hijack never pass through this reader.
const maxRequestBodyBytes = 4<<20 + 1

// newDualProtocolHandler returns the single-address h2c dispatcher for the
// legacy executor listener: HTTP/2 gRPC requests (Content-Type
// application/grpc, including h2c prior-knowledge connections from
// plaintext gRPC clients) go to the unchanged legacy grpc.Server; every
// other request (HTTP/1.1 or upgraded) goes to the shared executor HTTP
// wrapper. The h2c layer is wrapped in http.MaxBytesHandler so the buffered
// h2c-upgrade first request cannot consume unbounded memory. The returned
// handler is served by one http.Server; grpcSrv.Serve must NOT also be
// called on the listener.
func newDualProtocolHandler(grpcSrv *grpc.Server, execHTTP http.Handler) http.Handler {
	h2cHandler := h2c.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor == 2 && strings.HasPrefix(r.Header.Get("Content-Type"), "application/grpc") {
			grpcSrv.ServeHTTP(w, r)
			return
		}
		execHTTP.ServeHTTP(w, r)
	}), &http2.Server{})
	return http.MaxBytesHandler(h2cHandler, maxRequestBodyBytes)
}

// shutdownGRPCServer stops srv with a bounded grace: GracefulStop first
// and, once the grace expires, a forced Stop fired from a background
// goroutine (grpc's GracefulStop waits for in-flight handlers while
// holding the server lock, which a concurrent Stop would otherwise block
// on; the leaked goroutine dies with the process). This bounds shutdown of
// h2c-hijacked gRPC connections that http.Server.Shutdown cannot close.
func shutdownGRPCServer(srv *grpc.Server, grace time.Duration) {
	done := make(chan struct{})
	go func() {
		srv.GracefulStop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(grace):
		log.Printf("executor listener: graceful gRPC stop timed out after %s, forcing close", grace)
		go srv.Stop()
	}
}

// agentGateways holds the opt-in HTTP gateway server and its validated
// configuration.
type agentGateways struct {
	httpHandler http.Handler
	httpSrv     *http.Server
}

// buildAgentGateways validates the complete enabled-gateway configuration
// before any listener is opened: the HTTP gateway requires a TCP executor
// listener for its fixed executor upstream plus its route mapping.
func buildAgentGateways(listenAddr string) (*agentGateways, error) {
	executorUpstream, err := executorHTTPUpstream(listenAddr)
	if err != nil {
		return nil, err
	}
	handler, err := httpGatewayHandler(inferBackendAvailability(), executorUpstream)
	if err != nil {
		return nil, fmt.Errorf("http gateway: %w", err)
	}
	return &agentGateways{httpHandler: handler}, nil
}

// start brings up the HTTP gateway listener. It runs after the legacy
// servers are constructed; the fixed listener is opened synchronously so a
// port conflict fails fast.
func (g *agentGateways) start() error {
	lis, err := net.Listen("tcp", httpGatewayAddr)
	if err != nil {
		return fmt.Errorf("http gateway listen %s: %w", httpGatewayAddr, err)
	}
	srv := &http.Server{
		Addr:              httpGatewayAddr,
		Handler:           g.httpHandler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	g.httpSrv = srv
	go func() {
		log.Printf("agent-http-gateway listening on %s (behind oauth-services sidecar :8453)", httpGatewayAddr)
		if err := srv.Serve(lis); err != nil && err != http.ErrServerClosed {
			log.Fatalf("agent http gateway: %v", err)
		}
	}()
	return nil
}

// shutdown stops the HTTP gateway with a bounded grace period even if
// clients stay connected.
func (g *agentGateways) shutdown() {
	if g.httpSrv != nil {
		shutdownHTTPServer(g.httpSrv, gatewayShutdownGrace)
	}
}

// shutdownHTTPServer bounds HTTP server shutdown; hijacked connections are
// force-closed by Close once the grace expires.
func shutdownHTTPServer(srv *http.Server, grace time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("agent gateway shutdown error after %s grace, closing: %v", grace, err)
		srv.Close()
	}
}
