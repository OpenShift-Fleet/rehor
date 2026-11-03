package executor

import (
	"testing"
)

func TestPolicyAllowed(t *testing.T) {
	cases := []struct {
		tool string
		args []string
	}{
		{"gh", []string{"pr", "view", "42", "--repo", "org/repo", "--json", "state"}},
		{"gh", []string{"pr", "close", "42"}},
		{"gh", []string{"pr", "checks", "42"}},
		{"gh", []string{"pr", "comment", "42", "--body", "done"}},
		{"gh", []string{"pr", "list", "--repo", "org/repo"}},
		{"gh", []string{"api", "repos/org/repo/pulls/1/comments"}},
		{"gh", []string{"repo", "sync", "fork/repo", "--source", "org/repo"}},
		{"gh", []string{"release", "create", "v1.0"}},
		{"gh", []string{"auth", "setup-git"}},
		{"gh", []string{"auth", "status"}},
		{"gh", []string{"auth", "git-credential", "get"}},
		{"gh", []string{"issue", "view", "123"}},
		{"glab", []string{"api", "projects/foo%2Fbar/merge_requests/1"}},
		{"glab", []string{"mr", "close", "1"}},
		{"glab", []string{"mr", "view", "1", "--comments"}},
		{"glab", []string{"auth", "status", "--hostname", "gitlab.cee.redhat.com"}},
		{"glab", []string{"credential-helper", "get"}},
	}

	for _, tc := range cases {
		err := DefaultPolicy().Check(tc.tool, tc.args)
		if err != nil {
			t.Errorf("expected allowed: %s %v — got: %v", tc.tool, tc.args, err)
		}
	}
}

func TestPolicyBlocked(t *testing.T) {
	cases := []struct {
		tool   string
		args   []string
		substr string
	}{
		{"gh", []string{"auth", "login"}, "interactive"},
		{"gh", []string{"auth", "refresh"}, "token refresh"},
		{"gh", []string{"auth", "token"}, "token exposure"},
		{"gh", []string{"repo", "delete", "org/repo"}, "destructive"},
		{"gh", []string{"pr", "checkout", "3539", "--repo", "project-kessel/insights-rbac"}, "use git"},
		{"gh", []string{"pr", "create", "--title", "fix", "--head", "bot/RHCLOUD-1"}, "gh api"},
		{"glab", []string{"mr", "create", "--title", "fix"}, "glab api"},
		{"glab", []string{"auth", "login"}, "interactive"},
	}

	for _, tc := range cases {
		err := DefaultPolicy().Check(tc.tool, tc.args)
		if err == nil {
			t.Errorf("expected blocked: %s %v", tc.tool, tc.args)
			continue
		}
		if tc.substr != "" && !contains(err.Error(), tc.substr) {
			t.Errorf("expected %q in error for %s %v — got: %v", tc.substr, tc.tool, tc.args, err)
		}
	}
}

func TestPolicyDeniedUnknown(t *testing.T) {
	cases := []struct {
		tool string
		args []string
	}{
		{"gh", []string{"secret", "list"}},
		{"gh", []string{"ssh-key", "add"}},
		{"glab", []string{"ci", "run"}},
		{"gh", nil},
		{"unknown", []string{"foo"}},
	}

	for _, tc := range cases {
		err := DefaultPolicy().Check(tc.tool, tc.args)
		if err == nil {
			t.Errorf("expected denied: %s %v", tc.tool, tc.args)
		}
	}
}

func TestExtractPositionalArgs(t *testing.T) {
	cases := []struct {
		input    []string
		expected []string
	}{
		{[]string{"pr", "view", "42", "--json", "state"}, []string{"pr", "view", "42"}},
		{[]string{"pr", "--repo", "org/repo", "create"}, []string{"pr", "create"}},
		{[]string{"api", "--method=POST", "repos/foo"}, []string{"api", "repos/foo"}},
		{[]string{"--help"}, nil},
		{[]string{"pr", "view", "--", "--not-a-flag"}, []string{"pr", "view"}},
	}

	for _, tc := range cases {
		got := extractPositionalArgs(tc.input)
		if !sliceEqual(got, tc.expected) {
			t.Errorf("extractPositionalArgs(%v) = %v, want %v", tc.input, got, tc.expected)
		}
	}
}

func TestBlockedTakesPrecedence(t *testing.T) {
	err := DefaultPolicy().Check("gh", []string{"auth", "token"})
	if err == nil {
		t.Error("auth token should be blocked even though auth status is allowed")
	}
}

func TestGPGAllowed(t *testing.T) {
	cases := []struct {
		args []string
	}{
		{[]string{"--sign"}},
		{[]string{"--detach-sign", "--armor", "file.txt"}},
		{[]string{"--verify", "file.sig"}},
		{[]string{"--list-secret-keys", "--keyid-format", "long", "user@example.com"}},
		{[]string{"--list-keys"}},
		{[]string{"--import"}},
		{[]string{"--batch", "--import"}},
		{[]string{"--local-user", "ABCD1234", "--sign"}},
	}

	for _, tc := range cases {
		err := DefaultPolicy().Check("gpg", tc.args)
		if err != nil {
			t.Errorf("expected gpg allowed: %v — got: %v", tc.args, err)
		}
	}
}

func TestGPGBlocked(t *testing.T) {
	cases := []struct {
		args   []string
		substr string
	}{
		{[]string{"--export-secret-keys"}, "private key export"},
		{[]string{"--export-secret-subkeys", "ABCD1234"}, "private key export"},
		{[]string{"--export-ssh-key", "ABCD1234"}, "key export"},
		{[]string{"--gen-key"}, "key generation"},
		{[]string{"--full-gen-key"}, "key generation"},
		{[]string{"--edit-key", "ABCD1234"}, "key modification"},
		{[]string{"--delete-secret-keys", "ABCD1234"}, "key deletion"},
		{[]string{"--send-keys", "--keyserver", "keys.openpgp.org", "ABCD1234"}, "key upload"},
		{[]string{"--export-secret-keys=ABCD1234"}, "private key export"},
	}

	for _, tc := range cases {
		err := DefaultPolicy().Check("gpg", tc.args)
		if err == nil {
			t.Errorf("expected gpg blocked: %v", tc.args)
			continue
		}
		if tc.substr != "" && !contains(err.Error(), tc.substr) {
			t.Errorf("expected %q in error for gpg %v — got: %v", tc.substr, tc.args, err)
		}
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && containsAt(s, substr)
}

func containsAt(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func sliceEqual(a, b []string) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
