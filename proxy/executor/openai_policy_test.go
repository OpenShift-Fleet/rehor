package executor

import (
	"testing"
)

func TestOpenAIPolicyFromEnv(t *testing.T) {
	t.Setenv("OPENAI_ALLOWED_MODELS", "")
	if p := OpenAIPolicyFromEnv(); p != nil {
		t.Error("empty OPENAI_ALLOWED_MODELS should return nil policy")
	}

	t.Setenv("OPENAI_ALLOWED_MODELS", " gpt-5.6-luna , gpt-5.6-terra ,")
	p := OpenAIPolicyFromEnv()
	if p == nil {
		t.Fatal("non-empty OPENAI_ALLOWED_MODELS returned nil policy")
	}
	if err := p.Check("gpt-5.6-luna"); err != nil {
		t.Errorf("gpt-5.6-luna should be allowed: %v", err)
	}
	if err := p.Check("gpt-5.6-terra"); err != nil {
		t.Errorf("gpt-5.6-terra should be allowed: %v", err)
	}
	if got := p.Models(); len(got) != 2 {
		t.Errorf("Models() = %v, want 2 entries (blank entry must be skipped)", got)
	}
}

func TestOpenAIPolicyCheck(t *testing.T) {
	p := NewOpenAIPolicy([]string{"gpt-5.6-luna"})

	if err := p.Check("gpt-5.6-luna"); err != nil {
		t.Errorf("allowed model returned error: %v", err)
	}
	err := p.Check("gpt-5.6-terra")
	if err == nil {
		t.Fatal("blocked model should return an error")
	}
	if !contains(err.Error(), "model not allowed") {
		t.Errorf("error = %q, want it to mention 'model not allowed'", err.Error())
	}
	if err := p.Check(""); err == nil {
		t.Error("empty model should be denied")
	}

	// A nil policy must fail closed, not panic.
	var nilPolicy *OpenAIPolicy
	if err := nilPolicy.Check("gpt-5.6-luna"); err == nil {
		t.Error("nil policy should deny every model")
	}
}

func TestOpenAIPolicyModelsSorted(t *testing.T) {
	p := NewOpenAIPolicy([]string{"gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol"})
	got := p.Models()
	want := []string{"gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"}
	if len(got) != len(want) {
		t.Fatalf("Models() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Models() = %v, want %v", got, want)
		}
	}
}

func TestExtractChatModel(t *testing.T) {
	body := []byte(`{
		"model": "gpt-5.6-luna",
		"stream": true,
		"messages": [{"role": "user", "content": "hi"}],
		"tools": [{"type": "function", "function": {"name": "get_time"}}]
	}`)
	model, err := ExtractChatModel(body)
	if err != nil {
		t.Fatalf("ExtractChatModel returned error: %v", err)
	}
	if model != "gpt-5.6-luna" {
		t.Errorf("model = %q, want gpt-5.6-luna", model)
	}

	cases := []struct {
		name string
		body string
	}{
		{"invalid JSON", `{"model":`},
		{"missing model", `{"messages":[]}`},
		{"blank model", `{"model":""}`},
		{"JSON array", `[{"model":"gpt-5.6-luna"}]`},
		{"empty body", ``},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ExtractChatModel([]byte(tc.body)); err == nil {
				t.Errorf("ExtractChatModel(%q) should have failed", tc.body)
			}
		})
	}
}

func TestValidateOpenAIConfig(t *testing.T) {
	good := NewOpenAIPolicy([]string{"gpt-5.6-luna"})
	if err := ValidateOpenAIConfig("sk-test", good); err != nil {
		t.Errorf("valid config returned error: %v", err)
	}
	if err := ValidateOpenAIConfig("", good); err == nil {
		t.Error("empty API key should fail")
	}
	if err := ValidateOpenAIConfig("sk-test", nil); err == nil {
		t.Error("nil policy should fail")
	}
	if err := ValidateOpenAIConfig("sk-test", NewOpenAIPolicy(nil)); err == nil {
		t.Error("empty policy should fail")
	}
}
