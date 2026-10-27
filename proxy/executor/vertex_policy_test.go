package executor

import (
	"testing"
)

func TestExtractModelValid(t *testing.T) {
	tests := []struct {
		path       string
		wantModel  string
		wantMethod string
	}{
		{
			path:       "/v1/projects/my-proj/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-6:rawPredict",
			wantModel:  "claude-sonnet-4-6",
			wantMethod: "rawPredict",
		},
		{
			path:       "/v1/projects/dummy-id/locations/global/publishers/anthropic/models/claude-opus-4-6:streamRawPredict",
			wantModel:  "claude-opus-4-6",
			wantMethod: "streamRawPredict",
		},
		{
			path:       "/v1/projects/p/locations/l/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict",
			wantModel:  "claude-haiku-4-5@20251001",
			wantMethod: "rawPredict",
		},
	}

	for _, tt := range tests {
		model, method, err := ExtractModel(tt.path)
		if err != nil {
			t.Errorf("ExtractModel(%q) error: %v", tt.path, err)
			continue
		}
		if model != tt.wantModel {
			t.Errorf("ExtractModel(%q) model = %q, want %q", tt.path, model, tt.wantModel)
		}
		if method != tt.wantMethod {
			t.Errorf("ExtractModel(%q) method = %q, want %q", tt.path, method, tt.wantMethod)
		}
	}
}

func TestExtractModelInvalid(t *testing.T) {
	tests := []struct {
		path    string
		wantErr string
	}{
		{"/v1/projects/p/locations/l/publishers/anthropic/foo/bar", "no /models/"},
		{"/v1/projects/p/locations/l/publishers/anthropic/models/claude-sonnet", "no :method"},
		{"/healthz", "no /models/"},
	}

	for _, tt := range tests {
		_, _, err := ExtractModel(tt.path)
		if err == nil {
			t.Errorf("ExtractModel(%q) expected error containing %q", tt.path, tt.wantErr)
			continue
		}
		if !contains(err.Error(), tt.wantErr) {
			t.Errorf("ExtractModel(%q) error = %q, want substring %q", tt.path, err.Error(), tt.wantErr)
		}
	}
}

func TestVertexPolicyCheck(t *testing.T) {
	p := NewVertexPolicy([]string{
		"claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-haiku-4-5@20251001",
	})

	allowed := []string{
		"claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-haiku-4-5@20251001",
	}
	for _, m := range allowed {
		if err := p.Check(m); err != nil {
			t.Errorf("Check(%q) unexpected error: %v", m, err)
		}
	}

	blocked := []string{"gemini-pro", "claude-unknown", ""}
	for _, m := range blocked {
		if err := p.Check(m); err == nil {
			t.Errorf("Check(%q) expected error, got nil", m)
		}
	}
}

func TestVertexPolicyFromEnv(t *testing.T) {
	t.Setenv("VERTEX_ALLOWED_MODELS", "model-a, model-b")
	p := VertexPolicyFromEnv()

	if err := p.Check("model-a"); err != nil {
		t.Errorf("Check(model-a) unexpected error: %v", err)
	}
	if err := p.Check("model-b"); err != nil {
		t.Errorf("Check(model-b) unexpected error: %v", err)
	}
	if err := p.Check("claude-opus-4-6"); err == nil {
		t.Error("Check(claude-opus-4-6) should fail when env override is set")
	}
}

func TestVertexPolicyFromEnvEmpty(t *testing.T) {
	t.Setenv("VERTEX_ALLOWED_MODELS", "")
	p := VertexPolicyFromEnv()
	if p != nil {
		t.Error("VertexPolicyFromEnv() should return nil when env is empty")
	}
}
