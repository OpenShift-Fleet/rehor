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

	args := os.Args[1:]

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

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, err := grpc.DialContext(ctx, target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(),
		grpc.WithNoProxy(),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "executor: cannot connect to %s: %v\n", addr, err)
		os.Exit(127)
	}
	defer conn.Close()

	client := pb.NewExecutorClient(conn)

	req := &pb.ExecuteRequest{
		Tool: tool,
		Args: args,
	}

	if needsStdin(tool, args) {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "executor: read stdin: %v\n", err)
			os.Exit(1)
		}
		req.Stdin = data
	}

	execCtx, execCancel := context.WithTimeout(context.Background(), 65*time.Second)
	defer execCancel()

	resp, err := client.Execute(execCtx, req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "executor: rpc failed: %v\n", err)
		os.Exit(1)
	}

	if resp.Stdout != "" {
		fmt.Fprint(os.Stdout, resp.Stdout)
	}
	if resp.Stderr != "" {
		fmt.Fprint(os.Stderr, resp.Stderr)
	}

	os.Exit(int(resp.ExitCode))
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
