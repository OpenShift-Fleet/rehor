package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	executor "github.com/RedHatInsights/platform-frontend-ai-dev/proxy/executor"
	pb "github.com/RedHatInsights/platform-frontend-ai-dev/proxy/executor/gen"
)

type signingBackend struct {
	gpg      string
	env      []string
	mu       sync.Mutex
	requests []*pb.ExecuteRequest
}

func (b *signingBackend) Execute(ctx context.Context, req *pb.ExecuteRequest) (*pb.ExecuteResponse, error) {
	b.mu.Lock()
	b.requests = append(b.requests, &pb.ExecuteRequest{Tool: req.Tool, Args: append([]string(nil), req.Args...), Stdin: bytes.Clone(req.Stdin)})
	b.mu.Unlock()
	if req.Tool != "gpg" {
		return nil, fmt.Errorf("unexpected tool")
	}
	cmd := exec.CommandContext(ctx, b.gpg, req.Args...)
	cmd.Env = b.env
	cmd.Stdin = bytes.NewReader(req.Stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	code := int32(0)
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = int32(exitErr.ExitCode())
		} else {
			return nil, err
		}
	}
	return &pb.ExecuteResponse{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: code}, nil
}

func TestGitCommitSigningThroughHTTPGateway(t *testing.T) {
	paths := make(map[string]string)
	for _, name := range []string{"git", "gpg", "gpgconf"} {
		path, err := exec.LookPath(name)
		if err != nil {
			t.Skipf("%s executable unavailable", name)
		}
		paths[name] = path
	}
	paths["go"] = filepath.Join(runtime.GOROOT(), "bin", "go")
	if _, err := os.Stat(paths["go"]); os.IsNotExist(err) {
		t.Skip("go executable unavailable")
	} else if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	aliasDir, err := os.MkdirTemp("/tmp", "signing-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(aliasDir) })
	alias := filepath.Join(aliasDir, "root")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	signerHome := filepath.Join(alias, "signer")
	verifyHome := filepath.Join(alias, "verifier")
	repo := filepath.Join(root, "repo")
	templates := filepath.Join(root, "templates")
	for _, dir := range []string{signerHome, verifyHome, repo, templates} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	baseEnv := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + root,
		"TMPDIR=" + root,
		"XDG_CONFIG_HOME=" + filepath.Join(root, "config"),
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=" + os.DevNull,
		"GIT_TERMINAL_PROMPT=0",
		"LC_ALL=C",
	}
	signerEnv := append(append([]string{}, baseEnv...), "GNUPGHOME="+signerHome)
	verifyEnv := append(append([]string{}, baseEnv...), "GNUPGHOME="+verifyHome)
	run := func(dir string, env []string, input []byte, bin string, args ...string) []byte {
		t.Helper()
		cmd := exec.Command(bin, args...)
		cmd.Dir, cmd.Env = dir, env
		cmd.Stdin = bytes.NewReader(input)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%s %v: %v\n%s", filepath.Base(bin), args, err, out)
		}
		return out
	}
	for _, home := range []string{signerHome, verifyHome} {
		home := home
		t.Cleanup(func() {
			cmd := exec.Command(paths["gpgconf"], "--homedir", home, "--kill", "gpg-agent")
			cmd.Env = baseEnv
			_ = cmd.Run()
		})
	}

	// The build uses the already available module cache and cannot download dependencies.
	goPath := os.Getenv("GOPATH")
	if goPath == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Fatal(err)
		}
		goPath = filepath.Join(home, "go")
	}
	modCache := os.Getenv("GOMODCACHE")
	if modCache == "" {
		modCache = filepath.Join(strings.Split(goPath, string(os.PathListSeparator))[0], "pkg", "mod")
	}
	buildEnv := append(append([]string{}, baseEnv...), "GOMODCACHE="+modCache, "GOCACHE="+filepath.Join(root, "go-cache"), "GOPROXY=off", "GOSUMDB=off", "GOTOOLCHAIN=local", "CGO_ENABLED=0")
	shim := filepath.Join(root, "gpg")
	run("", buildEnv, nil, paths["go"], "build", "-mod=readonly", "-buildvcs=false", "-o", shim, ".")

	run("", signerEnv, nil, paths["gpg"], "--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-generate-key", "Signing Test <signing@example.invalid>", "ed25519", "sign", "0")
	keys := string(run("", signerEnv, nil, paths["gpg"], "--batch", "--with-colons", "--list-keys"))
	var fingerprint string
	for _, line := range strings.Split(keys, "\n") {
		fields := strings.Split(line, ":")
		if len(fields) > 9 && fields[0] == "fpr" {
			fingerprint = fields[9]
			break
		}
	}
	if fingerprint == "" {
		t.Fatal("generated key has no fingerprint")
	}
	publicKey := run("", signerEnv, nil, paths["gpg"], "--batch", "--armor", "--export", fingerprint)
	run("", verifyEnv, publicKey, paths["gpg"], "--batch", "--import")
	secretKeys := string(run("", verifyEnv, nil, paths["gpg"], "--batch", "--with-colons", "--list-secret-keys"))
	if strings.Contains(secretKeys, "sec:") {
		t.Fatal("verification keyring contains a private key")
	}

	backend := &signingBackend{gpg: paths["gpg"], env: signerEnv}
	upstream := httptest.NewServer(executor.NewExecutorHTTPHandler(backend))
	t.Cleanup(upstream.Close)
	gateway, err := executor.NewHTTPGateway(executor.GatewayConfig{Executor: upstream.URL})
	if err != nil {
		t.Fatal(err)
	}
	front := httptest.NewServer(gateway)
	t.Cleanup(front.Close)
	gitEnv := append(append([]string{}, signerEnv...), "EXECUTOR_HTTP_URL="+front.URL+"/executor/execute", "EXECUTOR_TRANSPORT=http")
	run(repo, gitEnv, nil, paths["git"], "init", "--quiet", "--template="+templates)
	for _, config := range [][2]string{{"user.name", "Signing Test"}, {"user.email", "signing@example.invalid"}, {"user.signingkey", fingerprint}, {"commit.gpgsign", "true"}, {"gpg.program", shim}} {
		run(repo, gitEnv, nil, paths["git"], "config", "--local", config[0], config[1])
	}
	if err := os.WriteFile(filepath.Join(repo, "content.txt"), []byte("signed content\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	run(repo, gitEnv, nil, paths["git"], "add", "content.txt")
	run(repo, gitEnv, nil, paths["git"], "commit", "--quiet", "-m", "Signed commit")

	backend.mu.Lock()
	requests := append([]*pb.ExecuteRequest(nil), backend.requests...)
	backend.mu.Unlock()
	if len(requests) != 1 || requests[0].Tool != "gpg" || len(requests[0].Stdin) == 0 {
		t.Fatalf("unexpected signing requests: count=%d", len(requests))
	}
	if !strings.Contains(string(requests[0].Stdin), "\n\nSigned commit\n") {
		t.Fatal("signing request did not contain the commit payload")
	}
	commit := string(run(repo, gitEnv, nil, paths["git"], "cat-file", "-p", "HEAD"))
	if !strings.Contains(commit, "\ngpgsig -----BEGIN PGP SIGNATURE-----\n") {
		t.Fatal("commit has no signature")
	}
	verified := string(run(repo, verifyEnv, nil, paths["git"], "-c", "gpg.program="+paths["gpg"], "verify-commit", "--raw", "HEAD"))
	if !strings.Contains(verified, "[GNUPG:] VALIDSIG "+fingerprint+" ") {
		t.Fatalf("signature did not verify against generated key:\n%s", verified)
	}
}
