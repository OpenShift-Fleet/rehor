package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	pb "github.com/RedHatInsights/platform-frontend-ai-dev/proxy/executor/gen"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// dialTimeout bounds connection establishment (blocking gRPC dial and the
// HTTP dialer/TLS handshake); a variable so tests can shorten it.
var dialTimeout = 5 * time.Second

// grpcExecTimeout is the legacy per-command execution timeout, unchanged.
var grpcExecTimeout = 65 * time.Second

func main() {
	tool := filepath.Base(os.Args[0])
	if tool == "executor-client" {
		if len(os.Args) < 2 {
			fmt.Fprintln(os.Stderr, "usage: executor-client <tool> [args...]")
			os.Exit(1)
		}
		tool = os.Args[1]
		os.Args = append(os.Args[:1], os.Args[2:]...)
	}

	os.Exit(run(tool, os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

// run executes one tool invocation against the configured executor and
// returns the process exit code. The default transport is HTTP/1.1 to
// /executor/execute on the existing EXECUTOR_ADDR listener (the updated
// proxy serves both gRPC and HTTP there); EXECUTOR_TRANSPORT=grpc rolls back
// to the legacy gRPC client; EXECUTOR_HTTP_URL selects the explicit
// authenticated HTTPS endpoint. HTTP failures never fall back to gRPC: a
// command may have already executed, so a silent retry could double-execute.
//
// Exit codes: 2 configuration error, 127 connect error, 1 rpc/http error,
// otherwise the server-reported tool exit code.
func run(tool string, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	tc, err := resolveTransportConfig(os.Getenv)
	if err != nil {
		// Errors never contain token values.
		fmt.Fprintf(stderr, "executor: invalid transport configuration: %v\n", err)
		return 2
	}

	if tc.grpc {
		return runGRPC(tool, args, stdin, stdout, stderr)
	}
	return runHTTP(tc.http, tool, args, stdin, stdout, stderr)
}

// runHTTP executes one invocation over the authenticated HTTP gateway.
func runHTTP(cfg *httpConfig, tool string, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	req := &pb.ExecuteRequest{
		Tool: tool,
		Args: args,
	}
	if needsStdin(tool, args) {
		data, err := io.ReadAll(stdin)
		if err != nil {
			fmt.Fprintf(stderr, "executor: read stdin: %v\n", err)
			return 1
		}
		req.Stdin = data
	}

	execCtx, execCancel := context.WithTimeout(context.Background(), httpExecTimeout)
	defer execCancel()

	resp, err := httpExecute(execCtx, cfg, req)
	if err != nil {
		if isConnectError(err) {
			fmt.Fprintf(stderr, "executor: cannot connect to %s: %v\n", redactURL(cfg.url), err)
			return 127
		}
		fmt.Fprintf(stderr, "executor: rpc failed: %v\n", err)
		return 1
	}

	if resp.Stdout != "" {
		fmt.Fprint(stdout, resp.Stdout)
	}
	if resp.Stderr != "" {
		fmt.Fprint(stderr, resp.Stderr)
	}

	return int(resp.ExitCode)
}

// runGRPC is the legacy internal transport, behaviorally identical to the
// pre-HTTP client: insecure gRPC over the EXECUTOR_ADDR unix socket or TCP
// address, dial before reading stdin, 5s dial / 65s execute timeouts. No new
// public gRPC route.
func runGRPC(tool string, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	addr := os.Getenv("EXECUTOR_ADDR")
	if addr == "" {
		addr = "unix:///var/run/devbot/executor.sock"
	}

	target := addr
	if strings.HasPrefix(addr, "unix://") {
		target = "unix://" + strings.TrimPrefix(addr, "unix://")
	} else if !strings.Contains(addr, "://") {
		target = "dns:///" + addr
	}

	dialCtx, dialCancel := context.WithTimeout(context.Background(), dialTimeout)
	defer dialCancel()

	conn, err := grpc.DialContext(dialCtx, target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(),
		grpc.WithNoProxy(),
	)
	if err != nil {
		fmt.Fprintf(stderr, "executor: cannot connect to %s: %v\n", addr, err)
		return 127
	}
	defer conn.Close()

	client := pb.NewExecutorClient(conn)

	req := &pb.ExecuteRequest{
		Tool: tool,
		Args: args,
	}

	if needsStdin(tool, args) {
		data, err := io.ReadAll(stdin)
		if err != nil {
			fmt.Fprintf(stderr, "executor: read stdin: %v\n", err)
			return 1
		}
		req.Stdin = data
	}

	execCtx, execCancel := context.WithTimeout(context.Background(), grpcExecTimeout)
	defer execCancel()

	resp, err := client.Execute(execCtx, req)
	if err != nil {
		fmt.Fprintf(stderr, "executor: rpc failed: %v\n", err)
		return 1
	}

	if resp.Stdout != "" {
		fmt.Fprint(stdout, resp.Stdout)
	}
	if resp.Stderr != "" {
		fmt.Fprint(stderr, resp.Stderr)
	}

	return int(resp.ExitCode)
}

func needsStdin(tool string, args []string) bool {
	joined := strings.Join(args, " ")
	if tool == "gh" && strings.Contains(joined, "auth git-credential") {
		return true
	}
	if tool == "glab" && strings.Contains(joined, "credential-helper") {
		return true
	}
	if tool == "gpg" {
		for _, a := range args {
			switch a {
			case "--sign", "--detach-sign", "--clear-sign",
				"--import", "--verify", "--encrypt", "--decrypt":
				return true
			}
			// Git invokes gpg with combined short flags like -bsau.
			// Check each character for sign/encrypt/decrypt flags.
			if len(a) > 1 && a[0] == '-' && a[1] != '-' {
				for _, c := range a[1:] {
					switch c {
					case 's', 'b', 'e', 'd':
						return true
					}
				}
			}
		}
	}
	return false
}
