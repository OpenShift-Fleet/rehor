package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	executor "github.com/RedHatInsights/platform-frontend-ai-dev/proxy/executor"
	pb "github.com/RedHatInsights/platform-frontend-ai-dev/proxy/executor/gen"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"google.golang.org/grpc"
)

var (
	listen   = flag.String("listen", "unix:///var/run/devbot/executor.sock", "listener address: unix:///path or :port")
	ghPath   = flag.String("gh-path", "/usr/local/bin/gh-real", "path to real gh binary")
	glabPath = flag.String("glab-path", "/usr/local/bin/glab-real", "path to real glab binary")
	gpgPath  = flag.String("gpg-path", "/usr/bin/gpg", "path to real gpg binary")
	timeout  = flag.Duration("timeout", 60*time.Second, "per-command timeout")

	vertexListen  = flag.String("vertex-listen", ":8443", "vertex auth proxy listen address")
	vertexProject = flag.String("vertex-project", "", "real GCP project ID")
	vertexRegion  = flag.String("vertex-region", "", "real GCP region")

	jiraListen   = flag.String("jira-listen", ":8445", "jira auth proxy listen address")
	jiraURL      = flag.String("jira-url", "", "upstream Jira URL")
	jiraUsername  = flag.String("jira-username", "", "Jira username")
	jiraToken    = flag.String("jira-token", "", "Jira API token")

	screenshotListen = flag.String("screenshot-listen", ":8446", "screenshot upload proxy listen address")

	metricsListen = flag.String("metrics-listen", ":9091", "address for Prometheus /metrics endpoint (env: METRICS_LISTEN)")
)

type server struct {
	pb.UnimplementedExecutorServer
	policy   *executor.Policy
	ghPath   string
	glabPath string
	gpgPath  string
	timeout  time.Duration
}

func (s *server) Execute(ctx context.Context, req *pb.ExecuteRequest) (*pb.ExecuteResponse, error) {
	start := time.Now()
	tool := req.Tool
	args := req.Args

	subcmd := extractSubcmd(args)
	var exitCode int32
	defer func() {
		dur := time.Since(start)
		log.Printf("exec: tool=%s subcmd=%s exit=%d dur=%s", tool, subcmd, exitCode, dur.Round(time.Millisecond))
		code := "OK"
		if exitCode != 0 {
			code = "ERROR"
		}
		executor.GRPCRequestsTotal.WithLabelValues("Execute", code).Inc()
		executor.GRPCRequestDuration.WithLabelValues("Execute").Observe(dur.Seconds())
	}()

	if err := s.policy.Check(tool, args); err != nil {
		log.Printf("policy-deny: tool=%s subcmd=%s reason=%s", tool, subcmd, err)
		exitCode = 1
		return &pb.ExecuteResponse{
			Stderr:   err.Error() + "\n",
			ExitCode: exitCode,
		}, nil
	}

	if tool == "glab" && len(args) > 0 && args[0] == "credential-helper" {
		resp, err := s.handleGlabCredentialHelper(req)
		if resp != nil {
			exitCode = resp.ExitCode
		}
		return resp, err
	}

	var binPath string
	switch tool {
	case "gh":
		binPath = s.ghPath
	case "glab":
		binPath = s.glabPath
	case "gpg":
		binPath = s.gpgPath
	default:
		exitCode = 1
		return &pb.ExecuteResponse{
			Stderr:   fmt.Sprintf("unknown tool: %s\n", tool),
			ExitCode: exitCode,
		}, nil
	}

	cmdCtx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	cmd := exec.CommandContext(cmdCtx, binPath, args...)
	if len(req.Stdin) > 0 {
		cmd.Stdin = bytes.NewReader(req.Stdin)
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = int32(exitErr.ExitCode())
		} else {
			exitCode = 1
			stderr.WriteString(err.Error() + "\n")
		}
	}

	return &pb.ExecuteResponse{
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		ExitCode: exitCode,
	}, nil
}

func (s *server) handleGlabCredentialHelper(req *pb.ExecuteRequest) (*pb.ExecuteResponse, error) {
	if len(req.Args) < 2 || req.Args[1] != "get" {
		return &pb.ExecuteResponse{
			Stderr:   "usage: glab credential-helper get\n",
			ExitCode: 1,
		}, nil
	}

	input := string(req.Stdin)
	if !strings.Contains(input, "host=gitlab.cee.redhat.com") {
		return &pb.ExecuteResponse{
			Stderr:   "credential-helper: host not matched\n",
			ExitCode: 1,
		}, nil
	}

	username := os.Getenv("GL_USERNAME")
	token := os.Getenv("GITLAB_TOKEN")
	if username == "" || token == "" {
		return &pb.ExecuteResponse{
			Stderr:   "credential-helper: GL_USERNAME/GITLAB_TOKEN not set\n",
			ExitCode: 1,
		}, nil
	}

	return &pb.ExecuteResponse{
		Stdout:   fmt.Sprintf("username=%s\npassword=%s\n", username, token),
		ExitCode: 0,
	}, nil
}

func extractSubcmd(args []string) string {
	var parts []string
	for _, a := range args {
		if strings.HasPrefix(a, "-") {
			continue
		}
		parts = append(parts, a)
		if len(parts) >= 2 {
			break
		}
	}
	if len(parts) == 0 {
		return "(none)"
	}
	return strings.Join(parts, " ")
}

func openListener(addr string) (net.Listener, error) {
	if strings.HasPrefix(addr, "unix://") {
		path := strings.TrimPrefix(addr, "unix://")
		os.Remove(path)
		lis, err := net.Listen("unix", path)
		if err != nil {
			return nil, err
		}
		if err := os.Chmod(path, 0666); err != nil {
			log.Printf("chmod socket: %v", err)
		}
		return lis, nil
	}
	return net.Listen("tcp", addr)
}

func main() {
	flag.Parse()

	if envListen := os.Getenv("EXECUTOR_LISTEN"); envListen != "" {
		*listen = envListen
	}
	if envTimeout := os.Getenv("EXECUTOR_TIMEOUT"); envTimeout != "" {
		if d, err := time.ParseDuration(envTimeout); err == nil {
			*timeout = d
		}
	}
	if v := os.Getenv("VERTEX_AUTH_LISTEN"); v != "" {
		*vertexListen = v
	}
	if v := os.Getenv("GCP_PROJECT_ID"); v != "" {
		*vertexProject = v
	}
	if v := os.Getenv("GCP_REGION"); v != "" {
		*vertexRegion = v
	}
	if v := os.Getenv("JIRA_AUTH_LISTEN"); v != "" {
		*jiraListen = v
	}
	if v := os.Getenv("JIRA_URL"); v != "" {
		*jiraURL = v
	}
	if v := os.Getenv("JIRA_USERNAME"); v != "" {
		*jiraUsername = v
	}
	if v := os.Getenv("JIRA_API_TOKEN"); v != "" {
		*jiraToken = v
	}
	if v := os.Getenv("SCREENSHOT_LISTEN"); v != "" {
		*screenshotListen = v
	}
	if v := os.Getenv("METRICS_LISTEN"); v != "" {
		*metricsListen = v
	}

	metricsMux := http.NewServeMux()
	metricsMux.Handle("/metrics", promhttp.Handler())
	metricsSrv := &http.Server{Addr: *metricsListen, Handler: metricsMux}
	go func() {
		log.Printf("metrics server listening on %s", *metricsListen)
		if err := metricsSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("metrics server error: %v", err)
		}
	}()

	lis, err := openListener(*listen)
	if err != nil {
		log.Fatalf("listen %s: %v", *listen, err)
	}

	policy := executor.DefaultPolicy()

	grpcSrv := grpc.NewServer()
	pb.RegisterExecutorServer(grpcSrv, &server{
		policy:   policy,
		ghPath:   *ghPath,
		glabPath: *glabPath,
		gpgPath:  *gpgPath,
		timeout:  *timeout,
	})

	var vertexSrv *http.Server
	if *vertexProject != "" {
		ts, err := executor.NewTokenSource(context.Background())
		if err != nil {
			log.Fatalf("vertex token source: %v", err)
		}
		vp := executor.VertexPolicyFromEnv()
		if vp == nil {
			log.Fatal("vertex: VERTEX_ALLOWED_MODELS must be set when vertex-project is configured")
		}
		handler := executor.InstrumentHTTPHandler("vertex", executor.NewVertexProxy(*vertexProject, *vertexRegion, ts, vp))
		vertexSrv = &http.Server{Addr: *vertexListen, Handler: handler}
		go func() {
			log.Printf("vertex-auth-proxy listening on %s (project=%s region=%s)", *vertexListen, *vertexProject, *vertexRegion)
			if err := vertexSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Fatalf("vertex proxy: %v", err)
			}
		}()
	}

	var jiraSrv *http.Server
	if *jiraURL != "" {
		if err := executor.ValidateJiraConfig(*jiraURL, *jiraUsername, *jiraToken); err != nil {
			log.Fatalf("jira config: %v", err)
		}
		handler := executor.InstrumentHTTPHandler("jira", executor.NewJiraProxy(*jiraURL, *jiraUsername, *jiraToken))
		jiraSrv = &http.Server{Addr: *jiraListen, Handler: handler}
		go func() {
			log.Printf("jira-auth-proxy listening on %s (upstream=%s)", *jiraListen, *jiraURL)
			if err := jiraSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Fatalf("jira proxy: %v", err)
			}
		}()
	}

	var screenshotSrv *http.Server
	if ghToken := os.Getenv("GH_TOKEN"); ghToken != "" {
		handler := executor.InstrumentHTTPHandler("screenshot", executor.NewScreenshotUploader(ghToken))
		screenshotSrv = &http.Server{Addr: *screenshotListen, Handler: handler}
		go func() {
			log.Printf("screenshot-upload listening on %s", *screenshotListen)
			if err := screenshotSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Fatalf("screenshot upload: %v", err)
			}
		}()
	}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("shutting down...")
		grpcSrv.GracefulStop()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if vertexSrv != nil {
			vertexSrv.Shutdown(ctx)
		}
		if jiraSrv != nil {
			jiraSrv.Shutdown(ctx)
		}
		if screenshotSrv != nil {
			screenshotSrv.Shutdown(ctx)
		}
		if err := metricsSrv.Shutdown(ctx); err != nil {
			log.Printf("metrics server shutdown error: %v", err)
		}
	}()

	log.Printf("executor-server listening on %s", *listen)
	if err := grpcSrv.Serve(lis); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
