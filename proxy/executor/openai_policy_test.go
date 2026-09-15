package executor

import (
	"testing"
)

func TestOpenAIPolicyFromEnv(t *testing.T) {
	t.Setenv("OPENAI_ALLOWED_MODELS", "")
	if p := OpenAIPolicyFromEnv(); p != nil {
		t.Error("empty OPENAI_ALLOWED_MODELS should return nil policy")
	}

	t.Setenv("OPENAI_ALLOWED_MODELS", " gpt-4o-mini , gpt-4o ,")
	p := OpenAIPolicyFromEnv()
	if p == nil {
		t.Fatal("non-empty OPENAI_ALLOWED_MODELS returned nil policy")
	}
	if err := p.Check("gpt-4o-mini"); err != nil {
		t.Errorf("gpt-4o-mini should be allowed: %v", err)
	}
	if err := p.Check("gpt-4o"); err != nil {
		t.Errorf("gpt-4o should be allowed: %v", err)
	}
	if got := p.Models(); len(got) != 2 {
		t.Errorf("Models() = %v, want 2 entries (blank entry must be skipped)", got)
	}
}

func TestOpenAIPolicyCheck(t *testing.T) {
	p := NewOpenAIPolicy([]string{"gpt-4o-mini"})

	if err := p.Check("gpt-4o-mini"); err != nil {
		t.Errorf("allowed model returned error: %v", err)
	}
	err := p.Check("gpt-4o")
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
	if err := nilPolicy.Check("gpt-4o-mini"); err == nil {
		t.Error("nil policy should deny every model")
	}
}

func TestOpenAIPolicyModelsSorted(t *testing.T) {
	p := NewOpenAIPolicy([]string{"gpt-4o", "gpt-4o-mini", "o3-mini"})
	got := p.Models()
	want := []string{"gpt-4o", "gpt-4o-mini", "o3-mini"}
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
		"model": "gpt-4o-mini",
		"stream": true,
		"messages": [{"role": "user", "content": "hi"}],
		"tools": [{"type": "function", "function": {"name": "get_time"}}]
	}`)
	model, err := ExtractChatModel(body)
	if err != nil {
		t.Fatalf("ExtractChatModel returned error: %v", err)
	}
	if model != "gpt-4o-mini" {
		t.Errorf("model = %q, want gpt-4o-mini", model)
	}

	cases := []struct {
		name string
		body string
	}{
		{"invalid JSON", `{"model":`},
		{"missing model", `{"messages":[]}`},
		{"blank model", `{"model":""}`},
		{"JSON array", `[{"model":"gpt-4o-mini"}]`},
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
	good := NewOpenAIPolicy([]string{"gpt-4o-mini"})
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
