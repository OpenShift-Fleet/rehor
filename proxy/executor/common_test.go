package executor

import (
	"net/http"
	"testing"
)

func TestStripSensitiveResponseHeaders(t *testing.T) {
	resp := &http.Response{Header: make(http.Header)}
	resp.Header.Set("Authorization", "Bearer leaked-token")
	resp.Header.Set("Set-Cookie", "session=secret")
	resp.Header.Set("WWW-Authenticate", `Basic realm="git"`)
	resp.Header.Set("X-Access-Token", "abc")
	resp.Header.Set("Content-Type", "application/json")
	if err := stripSensitiveResponseHeaders(resp); err != nil {
		t.Fatalf("stripSensitiveResponseHeaders: %v", err)
	}
	for _, h := range []string{"Authorization", "Set-Cookie", "WWW-Authenticate", "X-Access-Token"} {
		if got := resp.Header.Get(h); got != "" {
			t.Errorf("%s = %q, want empty", h, got)
		}
	}
	if got := resp.Header.Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
}
