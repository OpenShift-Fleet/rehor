package executor

import (
	"fmt"
	"strings"
)

// Policy validates CLI commands against an allowlist.
type Policy struct {
	allowed      map[string][]subcommand
	blocked      map[string][]blockedCmd
	blockedFlags map[string][]blockedFlag
	allowAll     map[string]bool
}

// DefaultPolicy returns the built-in command allowlist.
func DefaultPolicy() *Policy {
	return &defaultPolicy
}

type subcommand struct {
	parts []string
}

type blockedCmd struct {
	parts  []string
	reason string
}

type blockedFlag struct {
	flag   string
	reason string
}

var defaultPolicy = Policy{
	allowed: map[string][]subcommand{
		"gh": {
			{[]string{"pr", "view"}},
			{[]string{"pr", "close"}},
			{[]string{"pr", "checks"}},
			{[]string{"pr", "comment"}},
			{[]string{"pr", "list"}},
			{[]string{"pr", "diff"}},
			{[]string{"pr", "merge"}},
			{[]string{"pr", "review"}},
			{[]string{"pr", "ready"}},
			{[]string{"pr", "edit"}},
			{[]string{"api"}},
			{[]string{"repo", "sync"}},
			{[]string{"release", "create"}},
			{[]string{"release", "upload"}},
			{[]string{"auth", "setup-git"}},
			{[]string{"auth", "status"}},
			{[]string{"auth", "git-credential"}},
			{[]string{"issue", "view"}},
			{[]string{"issue", "list"}},
			{[]string{"issue", "comment"}},
		},
		"glab": {
			{[]string{"api"}},
			{[]string{"mr", "close"}},
			{[]string{"mr", "view"}},
			{[]string{"mr", "list"}},
			{[]string{"mr", "note"}},
			{[]string{"mr", "update"}},
			{[]string{"auth", "status"}},
			{[]string{"credential-helper"}},
		},
	},
	blocked: map[string][]blockedCmd{
		"gh": {
			{[]string{"auth", "login"}, "interactive auth not allowed"},
			{[]string{"auth", "refresh"}, "token refresh not allowed"},
			{[]string{"auth", "token"}, "token exposure not allowed"},
			{[]string{"repo", "delete"}, "destructive operation not allowed"},
			{[]string{"pr", "checkout"}, "gh runs in the executor container and cannot see or modify sandbox repo files — use git: git fetch <remote> pull/<n>/head:pr-<n> && git checkout pr-<n>"},
			{[]string{"pr", "create"}, "gh cannot see the sandbox repo — create PRs via API: gh api repos/<owner>/<repo>/pulls -X POST -f head=<branch> -f base=<default> ..."},
		},
		"glab": {
			{[]string{"auth", "login"}, "interactive auth not allowed"},
			{[]string{"mr", "create"}, "glab cannot see the sandbox repo — create MRs via API: glab api projects/<path>/merge_requests -X POST -f source_branch=... -f target_branch=..."},
		},
	},
	blockedFlags: map[string][]blockedFlag{
		"gpg": {
			{"--export-secret-keys", "private key export not allowed"},
			{"--export-secret-subkeys", "private key export not allowed"},
			{"--export-ssh-key", "key export not allowed"},
			{"--gen-key", "key generation not allowed"},
			{"--full-gen-key", "key generation not allowed"},
			{"--edit-key", "key modification not allowed"},
			{"--delete-secret-keys", "key deletion not allowed"},
			{"--send-keys", "key upload not allowed"},
		},
	},
	allowAll: map[string]bool{
		"gpg": true,
	},
}

func extractPositionalArgs(args []string) []string {
	var positional []string
	skip := false
	for _, a := range args {
		if skip {
			skip = false
			continue
		}
		if a == "--" {
			break
		}
		if strings.HasPrefix(a, "-") {
			if !strings.Contains(a, "=") {
				skip = true
			}
			continue
		}
		positional = append(positional, a)
	}
	return positional
}

func (p *Policy) Check(tool string, args []string) error {
	for _, bf := range p.blockedFlags[tool] {
		for _, a := range args {
			flag := a
			if idx := strings.IndexByte(a, '='); idx >= 0 {
				flag = a[:idx]
			}
			if flag == bf.flag {
				return fmt.Errorf("blocked: %s %s — %s", tool, bf.flag, bf.reason)
			}
		}
	}

	if p.allowAll[tool] {
		return nil
	}

	positional := extractPositionalArgs(args)

	for _, b := range p.blocked[tool] {
		if matchPrefix(positional, b.parts) {
			return fmt.Errorf("blocked: %s %s — %s", tool, strings.Join(b.parts, " "), b.reason)
		}
	}

	for _, a := range p.allowed[tool] {
		if matchPrefix(positional, a.parts) {
			return nil
		}
	}

	if len(positional) == 0 {
		return fmt.Errorf("denied: %s with no subcommand", tool)
	}
	return fmt.Errorf("denied: %s %s — not in allowlist", tool, strings.Join(positional, " "))
}

func matchPrefix(positional, pattern []string) bool {
	if len(positional) < len(pattern) {
		return false
	}
	for i, p := range pattern {
		if positional[i] != p {
			return false
		}
	}
	return true
}
